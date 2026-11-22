import type {
  Bounds,
  GeoJsonGeometry,
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  PlayAreaFeatureCollection,
  PolygonGeometry,
  Position,
} from "@searchlight/shared";
import * as turf from "@turf/turf";

import { playAreaBounds, runOverpassQuery } from "@/lib/creator/overpass";

const METERS_PER_DEGREE = (6371008.8 * Math.PI) / 180;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Minimum line-cropping mask buffer (100 m) applied by OSM/QLever line fetchers
 * even when user margin is 0 km. Nominatim simplifies boundary polygons at
 * 0.0005° (~55 m), so without a small tolerance border rivers and international
 * borders wiggle across the simplified edge and get shredded into fragments.
 */
export const MIN_LINE_CROP_BUFFER_KM = 0.1;

export interface OverpassGeomNode {
  lat: number;
  lon: number;
}

export interface OverpassRelationMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  geometry?: OverpassGeomNode[];
}

export interface OverpassGeomElement {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassGeomNode[];
  members?: OverpassRelationMember[];
}

export interface CreatorGeoFeatureItem {
  uid: string;
  name: string;
  geometry: GeoJsonGeometry;
  enabled: boolean;
  /** Original feature id and properties preserved when loading an existing .game.json. */
  originalId?: string | number;
  originalProperties?: Record<string, unknown>;
}

export interface RegionFetchResult {
  items: CreatorGeoFeatureItem[];
  vertexCount: number;
  skippedOutside: number;
  endpoint: string;
}

export interface LineFetchResult {
  items: CreatorGeoFeatureItem[];
  vertexCount: number;
  endpoint: string;
}

/** Counts coordinate vertices in a GeoJSON geometry. */
export function countGeometryVertices(geom: GeoJsonGeometry): number {
  switch (geom.type) {
    case "Point":
      return 1;
    case "LineString":
      return geom.coordinates.length;
    case "MultiLineString":
      return geom.coordinates.reduce((sum, l) => sum + l.length, 0);
    case "Polygon":
      return geom.coordinates.reduce((sum, r) => sum + r.length, 0);
    case "MultiPolygon":
      return geom.coordinates.reduce(
        (sum, poly) => sum + poly.reduce((s, r) => s + r.length, 0),
        0,
      );
  }
}

function perpDistanceMeters(pt: Position, start: Position, end: Position): number {
  const cosLat = Math.cos(((start[1] + end[1]) / 2) * (Math.PI / 180));
  const px = (pt[0] - start[0]) * cosLat * METERS_PER_DEGREE;
  const py = (pt[1] - start[1]) * METERS_PER_DEGREE;
  const dx = (end[0] - start[0]) * cosLat * METERS_PER_DEGREE;
  const dy = (end[1] - start[1]) * METERS_PER_DEGREE;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
  return Math.hypot(px - t * dx, py - t * dy);
}

function simplifyOpenPathMeters(coords: readonly Position[], toleranceMeters: number): Position[] {
  if (toleranceMeters <= 0 || coords.length <= 2) {
    return coords.map(([lng, lat]) => [round6(lng), round6(lat)]);
  }

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: [number, number][] = [[0, coords.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistanceMeters(coords[i], coords[start], coords[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceMeters && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }

  const out: Position[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (!keep[i]) continue;
    const p: Position = [round6(coords[i][0]), round6(coords[i][1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Iterative Douglas-Peucker simplification in meters that ALWAYS keeps the
 * first and last vertex pinned. Because neighbouring OSM boundary relations
 * share identical way IDs, simplifying each unique way with pinned endpoints
 * before ring assembly guarantees shared borders stay topology-aligned.
 * For already-closed ways, splits at the farthest vertex before simplifying
 * and falls back to the unsimplified ring if simplification would collapse it.
 */
export function simplifyPathMeters(
  coords: readonly Position[],
  toleranceMeters: number,
): Position[] {
  const rounded: Position[] = coords.map(([lng, lat]) => [round6(lng), round6(lat)]);
  if (toleranceMeters <= 0 || rounded.length <= 2) return rounded;

  const isClosed = rounded.length >= 4 && posEqual(rounded[0], rounded[rounded.length - 1]);
  if (isClosed) {
    let splitIdx = -1;
    let maxDist = -1;
    for (let i = 1; i < rounded.length - 1; i++) {
      const d = perpDistanceMeters(rounded[i], rounded[0], rounded[0]);
      if (d > maxDist) {
        maxDist = d;
        splitIdx = i;
      }
    }
    if (splitIdx <= 0) return rounded;
    const firstHalf = simplifyOpenPathMeters(rounded.slice(0, splitIdx + 1), toleranceMeters);
    const secondHalf = simplifyOpenPathMeters(rounded.slice(splitIdx), toleranceMeters);
    const merged = [...firstHalf, ...secondHalf.slice(1)];
    if (merged.length >= 4 && posEqual(merged[0], merged[merged.length - 1])) {
      return merged;
    }
    // Never collapse a valid closed ring into < 4 vertices.
    return rounded;
  }

  return simplifyOpenPathMeters(rounded, toleranceMeters);
}

function posEqual(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function posKey(p: Position): string {
  return `${p[0]},${p[1]}`;
}

/**
 * Splits a self-touching (figure-8) closed ring into simple closed sub-rings
 * whenever an interior vertex is visited more than once.
 */
function splitSelfTouchingRing(ring: Position[]): Position[][] {
  const simple: Position[][] = [];
  const queue: Position[][] = [ring];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.length < 4 || !posEqual(cur[0], cur[cur.length - 1])) continue;
    const seen = new Map<string, number>();
    let splitAt: [number, number] | null = null;
    // Check indices 0 .. cur.length - 2 (the last vertex intentionally repeats index 0)
    for (let i = 0; i < cur.length - 1; i++) {
      const key = posKey(cur[i]);
      const prev = seen.get(key);
      if (prev !== undefined) {
        splitAt = [prev, i];
        break;
      }
      seen.set(key, i);
    }
    if (!splitAt) {
      simple.push(cur);
      continue;
    }
    const [a, b] = splitAt;
    const loop1 = [...cur.slice(a, b + 1)];
    const loop2 = [...cur.slice(0, a), ...cur.slice(b)];
    if (loop1.length >= 4) queue.push(loop1);
    if (loop2.length >= 4) queue.push(loop2);
  }
  return simple;
}

/**
 * Stitches open way segments end-to-end into closed polygon rings.
 * Handles ways ordered in either direction, already-closed rings, and
 * figure-8 rings touching at a shared corner.
 */
export function stitchWaysToRings(ways: readonly Position[][]): Position[][] {
  const remaining: Position[][] = [];
  const rings: Position[][] = [];

  for (const raw of ways) {
    if (raw.length < 2) continue;
    if (raw.length >= 4 && posEqual(raw[0], raw[raw.length - 1])) {
      rings.push(...splitSelfTouchingRing(raw));
    } else {
      remaining.push([...raw]);
    }
  }

  while (remaining.length > 0) {
    const current = remaining.shift()!;
    let progress = true;
    while (
      progress &&
      !(current.length >= 4 && posEqual(current[0], current[current.length - 1]))
    ) {
      progress = false;
      const headKey = posKey(current[0]);
      const tailKey = posKey(current[current.length - 1]);

      for (let i = 0; i < remaining.length; i++) {
        const seg = remaining[i];
        const segStart = posKey(seg[0]);
        const segEnd = posKey(seg[seg.length - 1]);

        if (segStart === tailKey) {
          current.push(...seg.slice(1));
        } else if (segEnd === tailKey) {
          current.push(...seg.slice(0, -1).reverse());
        } else if (segEnd === headKey) {
          current.unshift(...seg.slice(0, -1));
        } else if (segStart === headKey) {
          current.unshift(...seg.slice(1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }

    if (current.length >= 4 && posEqual(current[0], current[current.length - 1])) {
      rings.push(...splitSelfTouchingRing(current));
    }
  }

  return rings;
}

function canonicalWayDirection(coords: Position[]): Position[] {
  if (coords.length < 2) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  // Canonicalize direction so simplifying the same way from different
  // relations produces bit-identical intermediate vertices.
  if (first[0] > last[0] || (first[0] === last[0] && first[1] > last[1])) {
    return [...coords].reverse();
  }
  return coords;
}

function roundPolygonGeom(
  geom: PolygonGeometry | MultiPolygonGeometry,
): PolygonGeometry | MultiPolygonGeometry | null {
  const roundRing = (ring: readonly Position[]): Position[] | null => {
    const out: Position[] = [];
    for (const p of ring) {
      const rp: Position = [round6(p[0]), round6(p[1])];
      const last = out[out.length - 1];
      if (!last || last[0] !== rp[0] || last[1] !== rp[1]) out.push(rp);
    }
    if (out.length < 3) return null;
    if (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]) {
      out.push([out[0][0], out[0][1]]);
    }
    return out.length >= 4 ? out : null;
  };
  if (geom.type === "Polygon") {
    const rings = geom.coordinates.map(roundRing).filter((r): r is Position[] => r !== null);
    return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
  }
  const polys = geom.coordinates
    .map((poly) => poly.map(roundRing).filter((r): r is Position[] => r !== null))
    .filter((rings) => rings.length > 0);
  if (polys.length === 0) return null;
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

function unionMaskFeatures(
  features: PlayAreaFeatureCollection["features"],
): PlayAreaFeatureCollection["features"] {
  if (features.length <= 1) return features;
  try {
    const fc = turf.featureCollection(
      features.map((f) => ({
        type: "Feature" as const,
        properties: {},
        geometry: f.geometry,
      })),
    );
    const merged = turf.union(fc);
    if (
      merged?.geometry &&
      (merged.geometry.type === "Polygon" || merged.geometry.type === "MultiPolygon")
    ) {
      const rounded = roundPolygonGeom(merged.geometry as PolygonGeometry | MultiPolygonGeometry);
      if (rounded) {
        return [
          {
            type: "Feature",
            properties: features[0].properties ?? null,
            geometry: rounded,
          },
        ];
      }
    }
  } catch {
    // Fall back to keeping individual features if union fails on invalid rings.
  }
  return features;
}

/**
 * Returns `playArea` expanded by `bufferKm` kilometers when `bufferKm > 0`,
 * or `playArea` itself when `bufferKm <= 0`. Unions multi-feature masks so
 * overlapping buffered polygons never produce overlapping outputs or
 * double-counted areas.
 */
export function buildPlayAreaMask(
  playArea: PlayAreaFeatureCollection,
  bufferKm = 0,
): PlayAreaFeatureCollection {
  if (playArea.features.length === 0) return playArea;
  if (bufferKm <= 0) {
    if (playArea.features.length <= 1) return playArea;
    return {
      type: "FeatureCollection",
      features: unionMaskFeatures(playArea.features),
    };
  }
  const bufferedFeatures: PlayAreaFeatureCollection["features"] = [];
  for (const feat of playArea.features) {
    try {
      const buffered = turf.buffer(
        { type: "Feature", properties: {}, geometry: feat.geometry },
        bufferKm,
        { units: "kilometers", steps: 12 },
      );
      if (
        buffered?.geometry &&
        (buffered.geometry.type === "Polygon" || buffered.geometry.type === "MultiPolygon")
      ) {
        const rounded = roundPolygonGeom(
          buffered.geometry as PolygonGeometry | MultiPolygonGeometry,
        );
        if (rounded) {
          bufferedFeatures.push({
            type: "Feature",
            properties: feat.properties ?? null,
            geometry: rounded,
          });
        }
      }
    } catch {
      bufferedFeatures.push(feat);
    }
  }
  return bufferedFeatures.length > 0
    ? { type: "FeatureCollection", features: unionMaskFeatures(bufferedFeatures) }
    : playArea;
}

/**
 * Returns a query bounding box derived directly from `mask` (rounded slightly
 * outward so features right on a buffered boundary are never excluded before
 * polygon clipping).
 */
export function maskQueryBounds(mask: PlayAreaFeatureCollection): Bounds {
  const [w, s, e, n] = playAreaBounds(mask);
  const eps = 1e-5;
  return [
    Math.max(-180, round6(w - eps)),
    Math.max(-89.9, round6(s - eps)),
    Math.min(180, round6(e + eps)),
    Math.min(89.9, round6(n + eps)),
  ];
}

interface MaskEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface MaskFeatureEntry {
  feature: {
    type: "Feature";
    properties: Record<string, never>;
    geometry: PolygonGeometry | MultiPolygonGeometry;
  };
  bbox: Bounds;
  area: number;
}

const MASK_GRID_SIZE = 32;

interface PlayAreaMaskIndex {
  bbox: Bounds;
  totalArea: number;
  features: MaskFeatureEntry[];
  edges: MaskEdge[];
  grid: number[][];
  cellW: number;
  cellH: number;
  edgeStamp: Uint32Array;
  stampCounter: number;
}

const maskIndexCache = new WeakMap<PlayAreaFeatureCollection, PlayAreaMaskIndex>();

function computeCoordsBbox(coords: readonly Position[]): Bounds {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

function computeGeomBbox(
  geom: PolygonGeometry | MultiPolygonGeometry | LineStringGeometry | MultiLineStringGeometry,
): Bounds {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (ring: readonly Position[]) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  };
  if (geom.type === "LineString") visit(geom.coordinates);
  else if (geom.type === "MultiLineString") geom.coordinates.forEach(visit);
  else if (geom.type === "Polygon") geom.coordinates.forEach(visit);
  else geom.coordinates.forEach((p) => p.forEach(visit));
  return [minLng, minLat, maxLng, maxLat];
}

function bboxesOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function getMaskIndex(mask: PlayAreaFeatureCollection): PlayAreaMaskIndex {
  const cached = maskIndexCache.get(mask);
  if (cached) return cached;

  const normalizedFeatures = unionMaskFeatures(mask.features);
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let totalArea = 0;
  const features: MaskFeatureEntry[] = [];
  const edges: MaskEdge[] = [];

  for (const pa of normalizedFeatures) {
    const geom = pa.geometry;
    const feature = {
      type: "Feature" as const,
      properties: {} as Record<string, never>,
      geometry: geom,
    };
    const bbox = computeGeomBbox(geom);
    if (bbox[0] < minLng) minLng = bbox[0];
    if (bbox[1] < minLat) minLat = bbox[1];
    if (bbox[2] > maxLng) maxLng = bbox[2];
    if (bbox[3] > maxLat) maxLat = bbox[3];

    let area = 0;
    try {
      area = turf.area(feature);
    } catch {
      area = 0;
    }
    totalArea += area;
    features.push({ feature, bbox, area });

    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length - 1; i++) {
          const ax = ring[i][0];
          const ay = ring[i][1];
          const bx = ring[i + 1][0];
          const by = ring[i + 1][1];
          if (ax === bx && ay === by) continue;
          edges.push({
            ax,
            ay,
            bx,
            by,
            minX: ax < bx ? ax : bx,
            minY: ay < by ? ay : by,
            maxX: ax > bx ? ax : bx,
            maxY: ay > by ? ay : by,
          });
        }
      }
    }
  }

  const spanX = Math.max(1e-9, maxLng - minLng);
  const spanY = Math.max(1e-9, maxLat - minLat);
  const cellW = spanX / MASK_GRID_SIZE;
  const cellH = spanY / MASK_GRID_SIZE;
  const grid: number[][] = Array.from({ length: MASK_GRID_SIZE * MASK_GRID_SIZE }, () => []);

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const x0 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((e.minX - minLng) / cellW)));
    const x1 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((e.maxX - minLng) / cellW)));
    const y0 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((e.minY - minLat) / cellH)));
    const y1 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((e.maxY - minLat) / cellH)));
    for (let cy = y0; cy <= y1; cy++) {
      const rowOff = cy * MASK_GRID_SIZE;
      for (let cx = x0; cx <= x1; cx++) {
        grid[rowOff + cx].push(ei);
      }
    }
  }

  const index: PlayAreaMaskIndex = {
    bbox: [minLng, minLat, maxLng, maxLat],
    totalArea,
    features,
    edges,
    grid,
    cellW,
    cellH,
    edgeStamp: new Uint32Array(edges.length),
    stampCounter: 0,
  };
  maskIndexCache.set(mask, index);
  return index;
}

function queryMaskEdges(
  idx: PlayAreaMaskIndex,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  const [bMinX, bMinY, bMaxX, bMaxY] = idx.bbox;
  if (maxX < bMinX || minX > bMaxX || maxY < bMinY || minY > bMaxY) return [];
  const x0 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((minX - bMinX) / idx.cellW)));
  const x1 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((maxX - bMinX) / idx.cellW)));
  const y0 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((minY - bMinY) / idx.cellH)));
  const y1 = Math.max(0, Math.min(MASK_GRID_SIZE - 1, Math.floor((maxY - bMinY) / idx.cellH)));

  let stamp = ++idx.stampCounter;
  if (stamp >= 0xffff_fffe) {
    idx.edgeStamp.fill(0);
    idx.stampCounter = 1;
    stamp = 1;
  }

  const hits: number[] = [];
  for (let cy = y0; cy <= y1; cy++) {
    const rowOff = cy * MASK_GRID_SIZE;
    for (let cx = x0; cx <= x1; cx++) {
      const bucket = idx.grid[rowOff + cx];
      for (let i = 0; i < bucket.length; i++) {
        const ei = bucket[i];
        if (idx.edgeStamp[ei] === stamp) continue;
        idx.edgeStamp[ei] = stamp;
        const e = idx.edges[ei];
        if (e.minX <= maxX && e.maxX >= minX && e.minY <= maxY && e.maxY >= minY) {
          hits.push(ei);
        }
      }
    }
  }
  return hits;
}

/** Fast point-in-mask check for clipping POIs to the play area (+ margin). */
export function pointInPlayAreaMask(
  lng: number,
  lat: number,
  mask: PlayAreaFeatureCollection,
): boolean {
  if (mask.features.length === 0) return true;
  const idx = getMaskIndex(mask);
  if (lng < idx.bbox[0] || lng > idx.bbox[2] || lat < idx.bbox[1] || lat > idx.bbox[3]) {
    return false;
  }
  const pt = turf.point([lng, lat]);
  return idx.features.some(({ feature, bbox }) => {
    if (lng < bbox[0] || lng > bbox[2] || lat < bbox[1] || lat > bbox[3]) return false;
    try {
      return turf.booleanPointInPolygon(pt, feature.geometry);
    } catch {
      return false;
    }
  });
}

function dedupeRoundedPath(coords: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const p of coords) {
    const rp: Position = [round6(p[0]), round6(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== rp[0] || last[1] !== rp[1]) {
      out.push(rp);
    }
  }
  return out;
}

function firstPolygonPoint(geom: PolygonGeometry | MultiPolygonGeometry): Position | null {
  if (geom.type === "Polygon") return geom.coordinates[0]?.[0] ?? null;
  return geom.coordinates[0]?.[0]?.[0] ?? null;
}

/**
 * Clips a polygon / multipolygon region against the allowed play-area mask.
 * - Uses the mask edge grid for an O(1) interior/exterior fast-path so country-
 *   scale municipal layers never stall calling `turf.intersect` on interior rings.
 * - Drops border-touching neighbors and hairline slivers (< 100 m² or < 0.5%
 *   of the smaller of region/mask area), while keeping small fully-contained
 *   regions intact.
 * - Keeps regions already >= 99.9% inside untouched so internal shared borders
 *   stay topology-aligned, and crops any overhanging region down to the mask.
 */
export function cropRegionToPlayAreaMask(
  geom: PolygonGeometry | MultiPolygonGeometry,
  mask: PlayAreaFeatureCollection,
): PolygonGeometry | MultiPolygonGeometry | null {
  if (mask.features.length === 0) return geom;
  const idx = getMaskIndex(mask);
  const geomBbox = computeGeomBbox(geom);
  if (!bboxesOverlap(geomBbox, idx.bbox)) return null;

  // O(1) fast-path: if zero mask boundary edges (outer or hole) enter geomBbox,
  // geom cannot cross the mask boundary and cannot contain any part of the mask.
  // Testing a single vertex decides strictly-inside vs strictly-outside exactly.
  const nearbyMaskEdges = queryMaskEdges(idx, geomBbox[0], geomBbox[1], geomBbox[2], geomBbox[3]);
  if (nearbyMaskEdges.length === 0) {
    const sample = firstPolygonPoint(geom);
    if (!sample) return null;
    return pointInPlayAreaMask(sample[0], sample[1], mask) ? geom : null;
  }

  const regionFeat = { type: "Feature" as const, properties: {}, geometry: geom };
  let regionArea = 0;
  try {
    regionArea = turf.area(regionFeat);
  } catch {
    return null;
  }
  if (regionArea <= 0) return null;

  const clippedFeats: Array<{
    type: "Feature";
    properties: Record<string, never>;
    geometry: PolygonGeometry | MultiPolygonGeometry;
  }> = [];
  for (const { feature: maskFeat, bbox: maskBbox } of idx.features) {
    if (!bboxesOverlap(geomBbox, maskBbox)) continue;
    try {
      const inter = turf.intersect(turf.featureCollection([regionFeat, maskFeat]));
      if (!inter?.geometry) continue;
      if (inter.geometry.type === "Polygon" || inter.geometry.type === "MultiPolygon") {
        clippedFeats.push({
          type: "Feature",
          properties: {},
          geometry: inter.geometry as PolygonGeometry | MultiPolygonGeometry,
        });
      }
    } catch {
      // Fallback: if Turf intersection fails on an invalid ring, keep only if an
      // interior point of the region falls inside the mask.
      try {
        const pt = turf.pointOnFeature(regionFeat);
        if (turf.booleanPointInPolygon(pt, maskFeat.geometry)) {
          return geom;
        }
      } catch {
        // ignore
      }
    }
  }

  if (clippedFeats.length === 0) return null;

  let mergedGeom: PolygonGeometry | MultiPolygonGeometry;
  if (clippedFeats.length === 1) {
    mergedGeom = clippedFeats[0].geometry;
  } else {
    const unioned = unionMaskFeatures(clippedFeats);
    if (unioned.length === 1) {
      mergedGeom = unioned[0].geometry;
    } else {
      const polys: Position[][][] = [];
      for (const f of unioned) {
        if (f.geometry.type === "Polygon") polys.push(f.geometry.coordinates);
        else polys.push(...f.geometry.coordinates);
      }
      mergedGeom =
        polys.length === 1
          ? { type: "Polygon", coordinates: polys[0] }
          : { type: "MultiPolygon", coordinates: polys };
    }
  }

  const clipped = roundPolygonGeom(mergedGeom);
  if (!clipped) return null;

  let clippedArea = 0;
  try {
    clippedArea = turf.area({ type: "Feature", properties: {}, geometry: clipped });
  } catch {
    return null;
  }
  if (clippedArea <= 0) return null;

  // Already essentially completely inside the play area (including tiny valid
  // contained polygons): keep original crisp geometry untouched.
  if (clippedArea >= 0.999 * regionArea) {
    return geom;
  }

  const refArea = Math.min(regionArea, idx.totalArea > 0 ? idx.totalArea : regionArea);
  // Drop border-touching neighbors / hairline boundary jitter.
  if (clippedArea < 100 || (refArea > 0 && clippedArea / refArea < 0.005)) {
    return null;
  }

  return clipped;
}

function collectSegmentSplitParams(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  edge: MaskEdge,
  outTs: number[],
): void {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = edge.bx - edge.ax;
  const sy = edge.by - edge.ay;
  const denom = rx * sy - ry * sx;
  const qpx = edge.ax - ax;
  const qpy = edge.ay - ay;

  if (Math.abs(denom) > 1e-12) {
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    if (t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) {
      if (t > 1e-9 && t < 1 - 1e-9) {
        outTs.push(t);
      }
    }
    return;
  }

  // Parallel / collinear: if collinear, split at the mask edge's endpoints that
  // project onto the interior of segment [a, b].
  const rLenSq = rx * rx + ry * ry;
  if (rLenSq <= 1e-20) return;
  const cross = Math.abs(qpx * ry - qpy * rx);
  if (cross > 1e-10 * Math.sqrt(rLenSq)) return;
  const tc = (qpx * rx + qpy * ry) / rLenSq;
  const td = ((edge.bx - ax) * rx + (edge.by - ay) * ry) / rLenSq;
  if (tc > 1e-9 && tc < 1 - 1e-9) outTs.push(tc);
  if (td > 1e-9 && td < 1 - 1e-9) outTs.push(td);
}

/**
 * Crops a LineString / MultiLineString to the allowed play-area mask using
 * direct parametric 2D segment clipping against the spatial-grid-indexed mask
 * boundary edges. Handles repeated crossings at the same coordinate, collinear
 * border-following lines exiting the mask, holes, and country-scale layers
 * without per-way RBush rebuilds or `turf.lineSplit` floating-point drops.
 */
export function cropLineToPlayAreaMask(
  geom: LineStringGeometry | MultiLineStringGeometry,
  mask: PlayAreaFeatureCollection,
): LineStringGeometry | MultiLineStringGeometry | null {
  if (mask.features.length === 0) return geom;
  const idx = getMaskIndex(mask);
  if (!bboxesOverlap(computeGeomBbox(geom), idx.bbox)) return null;

  const lines: Position[][] = geom.type === "LineString" ? [geom.coordinates] : geom.coordinates;

  const kept: Position[][] = [];

  for (const coords of lines) {
    if (coords.length < 2) continue;
    const lineBbox = computeCoordsBbox(coords);
    if (!bboxesOverlap(lineBbox, idx.bbox)) continue;

    // Fast path: if zero mask boundary edges enter the line's bbox, one point
    // test decides whether the entire polyline is inside or outside in O(1).
    if (queryMaskEdges(idx, lineBbox[0], lineBbox[1], lineBbox[2], lineBbox[3]).length === 0) {
      if (pointInPlayAreaMask(coords[0][0], coords[0][1], mask)) {
        const clean = dedupeRoundedPath(coords);
        if (clean.length >= 2) kept.push(clean);
      }
      continue;
    }

    let current: Position[] = [];
    const flushCurrent = () => {
      const clean = dedupeRoundedPath(current);
      if (clean.length >= 2) kept.push(clean);
      current = [];
    };

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const ax = a[0];
      const ay = a[1];
      const bx = b[0];
      const by = b[1];
      if (ax === bx && ay === by) continue;

      const sMinX = ax < bx ? ax : bx;
      const sMaxX = ax > bx ? ax : bx;
      const sMinY = ay < by ? ay : by;
      const sMaxY = ay > by ? ay : by;

      if (
        sMaxX < idx.bbox[0] ||
        sMinX > idx.bbox[2] ||
        sMaxY < idx.bbox[1] ||
        sMinY > idx.bbox[3]
      ) {
        flushCurrent();
        continue;
      }

      const candidateEdgeIds = queryMaskEdges(idx, sMinX, sMinY, sMaxX, sMaxY);
      const ts: number[] = [0, 1];
      for (let ci = 0; ci < candidateEdgeIds.length; ci++) {
        collectSegmentSplitParams(ax, ay, bx, by, idx.edges[candidateEdgeIds[ci]], ts);
      }
      ts.sort((p, q) => p - q);

      // Deduplicate split parameters and keep sub-intervals whose midpoint is inside.
      let prevT = ts[0];
      for (let ti = 1; ti < ts.length; ti++) {
        const nextT = ts[ti];
        if (nextT - prevT <= 1e-9) continue;
        const midT = (prevT + nextT) / 2;
        const midLng = ax + (bx - ax) * midT;
        const midLat = ay + (by - ay) * midT;
        if (pointInPlayAreaMask(midLng, midLat, mask)) {
          const p0: Position = [round6(ax + (bx - ax) * prevT), round6(ay + (by - ay) * prevT)];
          const p1: Position = [round6(ax + (bx - ax) * nextT), round6(ay + (by - ay) * nextT)];
          if (current.length === 0) {
            current.push(p0, p1);
          } else {
            const last = current[current.length - 1];
            if (last[0] === p0[0] && last[1] === p0[1]) {
              current.push(p1);
            } else {
              flushCurrent();
              current.push(p0, p1);
            }
          }
        } else {
          flushCurrent();
        }
        prevT = nextT;
      }
    }
    flushCurrent();
  }

  if (kept.length === 0) return null;
  return kept.length === 1
    ? { type: "LineString", coordinates: kept[0] }
    : { type: "MultiLineString", coordinates: kept };
}

/**
 * Assembles Overpass `out geom;` boundary relations into Polygon / MultiPolygon
 * features while simplifying each shared OSM way once by way ID so neighbouring
 * regions keep exact shared borders without gaps or slivers.
 */
export function assembleAdminRelations(
  elements: readonly OverpassGeomElement[],
  {
    playArea,
    toleranceMeters = 15,
    preferEnglishName = false,
  }: {
    playArea?: PlayAreaFeatureCollection;
    toleranceMeters?: number;
    preferEnglishName?: boolean;
  } = {},
): { items: CreatorGeoFeatureItem[]; vertexCount: number; skippedOutside: number } {
  // 1. Simplify every unique member way ONCE by OSM way ID.
  const simplifiedWays = new Map<number, Position[]>();
  for (const el of elements) {
    if (el.type !== "relation" || !Array.isArray(el.members)) continue;
    for (const member of el.members) {
      if (
        member.type !== "way" ||
        !Array.isArray(member.geometry) ||
        member.geometry.length < 2 ||
        simplifiedWays.has(member.ref)
      ) {
        continue;
      }
      const raw: Position[] = member.geometry.map((pt) => [round6(pt.lon), round6(pt.lat)]);
      const canonical = canonicalWayDirection(raw);
      simplifiedWays.set(member.ref, simplifyPathMeters(canonical, toleranceMeters));
    }
  }

  const items: CreatorGeoFeatureItem[] = [];
  let skippedOutside = 0;

  for (const el of elements) {
    if (el.type !== "relation" || !Array.isArray(el.members)) continue;
    const rawName = preferEnglishName
      ? (el.tags?.["name:en"] ?? el.tags?.name)
      : (el.tags?.name ?? el.tags?.["name:en"]);
    const name = rawName?.trim();
    if (!name) continue;

    const outerWays: Position[][] = [];
    const innerWays: Position[][] = [];
    for (const member of el.members) {
      if (member.type !== "way") continue;
      const coords = simplifiedWays.get(member.ref);
      if (!coords || coords.length < 2) continue;
      if (member.role === "inner") innerWays.push(coords);
      else if (member.role === "outer" || member.role === "") {
        outerWays.push(coords);
      }
    }

    const outerRings = stitchWaysToRings(outerWays);
    if (outerRings.length === 0) continue;
    const innerRings = stitchWaysToRings(innerWays);

    const polygons: Position[][][] = outerRings.map((ring) => [ring]);
    const outerAreas = outerRings.map((ring) => {
      try {
        return turf.area(turf.polygon([ring]));
      } catch {
        return Infinity;
      }
    });
    for (const hole of innerRings) {
      const sample = turf.point(hole[0]);
      // Pick the smallest outer shell that contains this hole (handles
      // islands inside lakes that contain their own inner lakes).
      let bestIdx = -1;
      let bestArea = Infinity;
      for (let pIdx = 0; pIdx < polygons.length; pIdx++) {
        try {
          if (
            turf.booleanPointInPolygon(sample, turf.polygon([polygons[pIdx][0]])) &&
            outerAreas[pIdx] < bestArea
          ) {
            bestIdx = pIdx;
            bestArea = outerAreas[pIdx];
          }
        } catch {
          // ignore invalid ring
        }
      }
      if (bestIdx !== -1) {
        polygons[bestIdx].push(hole);
      }
    }

    const rawGeometry: PolygonGeometry | MultiPolygonGeometry =
      polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };

    const geometry = playArea ? cropRegionToPlayAreaMask(rawGeometry, playArea) : rawGeometry;
    if (!geometry) {
      skippedOutside++;
      continue;
    }

    items.push({
      uid: `rel-${el.id}`,
      name,
      geometry,
      enabled: true,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  const vertexCount = items.reduce((sum, item) => sum + countGeometryVertices(item.geometry), 0);
  return { items, vertexCount, skippedOutside };
}

export function buildAdminRegionsQuery(adminLevel: number, bounds: Bounds): string {
  const [w, s, e, n] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const midLat = round6((s + n) / 2);
  const midLon = round6((w + e) / 2);
  // Include both bbox-intersecting relations and any larger relation that
  // fully encloses the play area's center (whose boundary lies outside bbox).
  return [
    "[out:json][timeout:120];",
    `is_in(${midLat},${midLon})->.containing;`,
    "(",
    `  relation["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"](${bbox});`,
    `  relation(pivot.containing)["boundary"="administrative"]["admin_level"="${adminLevel}"]["name"];`,
    ");",
    "out geom;",
  ].join("\n");
}

/**
 * Fetches OSM administrative boundary relations inside the play area,
 * simplifies shared borders identically, stitches rings, and filters to regions
 * intersecting the play area.
 */
export async function fetchAdminRegionsFromOsm({
  adminLevel,
  playArea,
  bufferKm = 0,
  toleranceMeters = 15,
  preferEnglishName = false,
  customEndpoint,
  rawQueryOverride,
  signal,
  onStatus,
}: {
  adminLevel: number;
  playArea: PlayAreaFeatureCollection;
  bufferKm?: number;
  toleranceMeters?: number;
  preferEnglishName?: boolean;
  customEndpoint?: string;
  rawQueryOverride?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<RegionFetchResult> {
  const mask = buildPlayAreaMask(playArea, bufferKm);
  const bounds = bufferKm > 0 ? maskQueryBounds(mask) : playAreaBounds(playArea);
  const query = rawQueryOverride?.trim() || buildAdminRegionsQuery(adminLevel, bounds);
  onStatus?.(`Querying OpenStreetMap for admin_level=${adminLevel} boundaries…`);
  const { elements, endpoint } = await runOverpassQuery(query, {
    customEndpoint,
    signal,
    onStatus,
  });

  const assembled = assembleAdminRelations(elements as unknown as OverpassGeomElement[], {
    playArea: mask,
    toleranceMeters,
    preferEnglishName,
  });

  return {
    ...assembled,
    endpoint,
  };
}

export function buildLineLayerQuery(osmFilter: string, bounds: Bounds): string {
  const [w, s, e, n] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:120];\nway${osmFilter.trim()}(${bbox});\nout geom;`;
}

/**
 * Assembles Overpass `way ...; out geom;` elements into simplified LineString /
 * MultiLineString features. When `groupByName` is true, segments sharing a name
 * merge into one MultiLineString per line name (suitable for matching); unnamed
 * segments merge into a single fallback feature (suitable for measuring).
 */
export function assembleLineWays(
  elements: readonly OverpassGeomElement[],
  {
    layerName,
    playArea,
    toleranceMeters = 15,
    groupByName = true,
    preferEnglishName = false,
  }: {
    layerName: string;
    playArea?: PlayAreaFeatureCollection;
    toleranceMeters?: number;
    groupByName?: boolean;
    preferEnglishName?: boolean;
  },
): { items: CreatorGeoFeatureItem[]; vertexCount: number } {
  const namedGroups = new Map<string, Position[][]>();
  const unnamedSegments: Position[][] = [];
  const individual: CreatorGeoFeatureItem[] = [];

  for (const el of elements) {
    if (el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) {
      continue;
    }
    const raw: Position[] = el.geometry.map((pt) => [round6(pt.lon), round6(pt.lat)]);
    if (raw.length < 2) continue;

    let keptSegments: Position[][];
    if (playArea) {
      // Clip raw geometry before simplifying so simplification never deletes a
      // valid crossing, then re-clip if tolerance > 0 so simplified chords can
      // never cut outside concave notches or holes.
      const clippedRaw = cropLineToPlayAreaMask({ type: "LineString", coordinates: raw }, playArea);
      if (!clippedRaw) continue;
      const rawPieces =
        clippedRaw.type === "LineString" ? [clippedRaw.coordinates] : clippedRaw.coordinates;
      keptSegments = [];
      for (const piece of rawPieces) {
        const simplified = simplifyPathMeters(piece, toleranceMeters);
        if (simplified.length < 2) continue;
        if (toleranceMeters > 0) {
          const reclipped = cropLineToPlayAreaMask(
            { type: "LineString", coordinates: simplified },
            playArea,
          );
          if (!reclipped) continue;
          if (reclipped.type === "LineString") keptSegments.push(reclipped.coordinates);
          else keptSegments.push(...reclipped.coordinates);
        } else {
          keptSegments.push(simplified);
        }
      }
      if (keptSegments.length === 0) continue;
    } else {
      const simplified = simplifyPathMeters(raw, toleranceMeters);
      if (simplified.length < 2) continue;
      keptSegments = [simplified];
    }

    const rawName = preferEnglishName
      ? (el.tags?.["name:en"] ?? el.tags?.name ?? el.tags?.ref)
      : (el.tags?.name ?? el.tags?.["name:en"] ?? el.tags?.ref);
    const name = rawName?.trim() || "";

    if (groupByName) {
      if (name) {
        const list = namedGroups.get(name) ?? [];
        list.push(...keptSegments);
        namedGroups.set(name, list);
      } else {
        unnamedSegments.push(...keptSegments);
      }
    } else {
      individual.push({
        uid: `way-${el.id}`,
        name: name || layerName,
        geometry:
          keptSegments.length === 1
            ? { type: "LineString", coordinates: keptSegments[0] }
            : { type: "MultiLineString", coordinates: keptSegments },
        enabled: true,
      });
    }
  }

  const items: CreatorGeoFeatureItem[] = groupByName ? [] : individual;
  if (groupByName) {
    let idx = 0;
    for (const [name, segments] of [...namedGroups.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const geometry: LineStringGeometry | MultiLineStringGeometry =
        segments.length === 1
          ? { type: "LineString", coordinates: segments[0] }
          : { type: "MultiLineString", coordinates: segments };
      items.push({
        uid: `line-group-${idx++}`,
        name,
        geometry,
        enabled: true,
      });
    }
    if (unnamedSegments.length > 0) {
      const geometry: LineStringGeometry | MultiLineStringGeometry =
        unnamedSegments.length === 1
          ? { type: "LineString", coordinates: unnamedSegments[0] }
          : { type: "MultiLineString", coordinates: unnamedSegments };
      items.push({
        uid: `line-unnamed`,
        name: layerName,
        geometry,
        enabled: true,
      });
    }
  }

  const vertexCount = items.reduce((sum, item) => sum + countGeometryVertices(item.geometry), 0);
  return { items, vertexCount };
}

/** Fetches simplified OSM line features (rail lines, rivers, coastlines, borders). */
export async function fetchLineLayerFromOsm({
  layerName,
  osmFilter,
  playArea,
  bufferKm = 0,
  toleranceMeters = 15,
  groupByName = true,
  preferEnglishName = false,
  customEndpoint,
  rawQueryOverride,
  signal,
  onStatus,
}: {
  layerName: string;
  osmFilter: string;
  playArea: PlayAreaFeatureCollection;
  bufferKm?: number;
  toleranceMeters?: number;
  groupByName?: boolean;
  preferEnglishName?: boolean;
  customEndpoint?: string;
  rawQueryOverride?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<LineFetchResult> {
  const mask = buildPlayAreaMask(playArea, Math.max(bufferKm, MIN_LINE_CROP_BUFFER_KM));
  const bounds = maskQueryBounds(mask);
  const query = rawQueryOverride?.trim() || buildLineLayerQuery(osmFilter, bounds);
  onStatus?.(`Querying OpenStreetMap for ${layerName}…`);
  const { elements, endpoint } = await runOverpassQuery(query, {
    customEndpoint,
    signal,
    onStatus,
  });

  const assembled = assembleLineWays(elements as unknown as OverpassGeomElement[], {
    layerName,
    playArea: mask,
    toleranceMeters,
    groupByName,
    preferEnglishName,
  });

  return {
    ...assembled,
    endpoint,
  };
}

function comparePos(a: Position, b: Position): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

function canonicalArcDirection(arc: Position[]): {
  canonical: Position[];
  reversed: boolean;
} {
  const n = arc.length;
  if (n < 2) return { canonical: arc, reversed: false };
  let cmp = comparePos(arc[0], arc[n - 1]);
  if (cmp === 0) {
    for (let i = 1; i < Math.floor(n / 2); i++) {
      cmp = comparePos(arc[i], arc[n - 1 - i]);
      if (cmp !== 0) break;
    }
  }
  if (cmp > 0) {
    return { canonical: [...arc].reverse(), reversed: true };
  }
  return { canonical: arc, reversed: false };
}

function arcSignature(arc: readonly Position[]): string {
  return arc.map((p) => `${p[0]},${p[1]}`).join(";");
}

function cleanUniqueRingVertices(ring: readonly Position[]): Position[] {
  const out: Position[] = [];
  for (const raw of ring) {
    const p: Position = [round6(raw[0]), round6(raw[1])];
    const last = out[out.length - 1];
    if (!last || !posEqual(last, p)) {
      out.push(p);
    }
  }
  if (out.length > 1 && posEqual(out[0], out[out.length - 1])) {
    out.pop();
  }
  return out;
}

function addUndirectedEdge(neighbors: Map<string, Set<string>>, a: Position, b: Position): void {
  const ka = posKey(a);
  const kb = posKey(b);
  if (ka === kb) return;
  let sa = neighbors.get(ka);
  if (!sa) {
    sa = new Set();
    neighbors.set(ka, sa);
  }
  sa.add(kb);
  let sb = neighbors.get(kb);
  if (!sb) {
    sb = new Set();
    neighbors.set(kb, sb);
  }
  sb.add(ka);
}

/**
 * Topology-preserving simplification for Polygon / MultiPolygon layers.
 * Splits every ring at shared topological junctions (vertices where 3+ borders
 * meet or where a ring touches itself), simplifies each unique border arc once
 * in a canonical direction with pinned endpoints, and reassembles rings.
 * Neighbouring polygons keep bit-identical shared borders with zero gaps or
 * overlaps introduced.
 */
export function simplifyPolygonLayerTopology(
  items: readonly CreatorGeoFeatureItem[],
  toleranceMeters: number,
): { items: CreatorGeoFeatureItem[]; vertexCount: number } {
  if (toleranceMeters <= 0) {
    return {
      items: [...items],
      vertexCount: items.reduce((sum, i) => sum + countGeometryVertices(i.geometry), 0),
    };
  }

  // 1. Collect cleaned cyclic rings and build global vertex adjacency graph.
  const neighbors = new Map<string, Set<string>>();
  const selfRepeatedKeys = new Set<string>();

  const allRings: Position[][] = [];
  const rawRings: Position[][] = [];
  type ItemRef =
    | { kind: "other"; item: CreatorGeoFeatureItem }
    | { kind: "Polygon"; item: CreatorGeoFeatureItem; ringIndices: number[] }
    | {
        kind: "MultiPolygon";
        item: CreatorGeoFeatureItem;
        polyRingIndices: number[][];
      };

  const registerRing = (rawRing: readonly Position[]): number => {
    const unique = cleanUniqueRingVertices(rawRing);
    const idx = allRings.length;
    allRings.push(unique);
    rawRings.push(rawRing.map((p) => [p[0], p[1]] as Position));
    const seenInRing = new Set<string>();
    const m = unique.length;
    for (let i = 0; i < m; i++) {
      const k = posKey(unique[i]);
      if (seenInRing.has(k)) selfRepeatedKeys.add(k);
      seenInRing.add(k);
      if (m >= 2) {
        addUndirectedEdge(neighbors, unique[i], unique[(i + 1) % m]);
      }
    }
    return idx;
  };

  const itemRefs: ItemRef[] = items.map((item) => {
    if (item.geometry.type === "Polygon") {
      return {
        kind: "Polygon",
        item,
        ringIndices: item.geometry.coordinates.map(registerRing),
      };
    }
    if (item.geometry.type === "MultiPolygon") {
      return {
        kind: "MultiPolygon",
        item,
        polyRingIndices: item.geometry.coordinates.map((poly) => poly.map(registerRing)),
      };
    }
    return { kind: "other", item };
  });

  // 2. Decompose every ring into canonical shared arcs and simplify each once.
  const originalArcs = new Map<string, Position[]>();
  const simplifiedArcs = new Map<string, Position[]>();

  const registerArc = (arc: Position[]): { sig: string; reversed: boolean } => {
    const { canonical, reversed } = canonicalArcDirection(arc);
    const sig = arcSignature(canonical);
    if (!originalArcs.has(sig)) {
      originalArcs.set(sig, canonical);
      simplifiedArcs.set(sig, simplifyPathMeters(canonical, toleranceMeters));
    }
    return { sig, reversed };
  };

  const ringArcPlans: Array<
    | { mode: "raw"; coords: Position[] }
    | { mode: "arcs"; arcs: Array<{ sig: string; reversed: boolean }> }
  > = allRings.map((unique, ringIdx) => {
    const m = unique.length;
    if (m < 3) {
      return {
        mode: "raw",
        coords: rawRings[ringIdx],
      };
    }

    const junctions: number[] = [];
    for (let i = 0; i < m; i++) {
      const k = posKey(unique[i]);
      const deg = neighbors.get(k)?.size ?? 0;
      if (deg !== 2 || selfRepeatedKeys.has(k)) {
        junctions.push(i);
      }
    }

    // Isolated ring with no degree != 2 junctions (e.g. island / enclave):
    // rotate to canonical start & winding so identical outer/hole rings match.
    if (junctions.length === 0) {
      let minIdx = 0;
      for (let i = 1; i < m; i++) {
        if (comparePos(unique[i], unique[minIdx]) < 0) minIdx = i;
      }
      const rotated = [...unique.slice(minIdx), ...unique.slice(0, minIdx)];
      const reversed = comparePos(rotated[1], rotated[m - 1]) > 0;
      const canonical = reversed
        ? [rotated[0], ...rotated.slice(1).reverse(), rotated[0]]
        : [...rotated, rotated[0]];
      const sig = arcSignature(canonical);
      if (!originalArcs.has(sig)) {
        originalArcs.set(sig, canonical);
        simplifiedArcs.set(sig, simplifyPathMeters(canonical, toleranceMeters));
      }
      return { mode: "arcs", arcs: [{ sig, reversed }] };
    }

    const arcs: Array<{ sig: string; reversed: boolean }> = [];
    if (junctions.length === 1) {
      const j = junctions[0];
      const loop = [...unique.slice(j), ...unique.slice(0, j), unique[j]];
      arcs.push(registerArc(loop));
    } else {
      for (let t = 0; t < junctions.length; t++) {
        const start = junctions[t];
        const end = junctions[(t + 1) % junctions.length];
        const seg =
          start < end
            ? unique.slice(start, end + 1)
            : [...unique.slice(start), ...unique.slice(0, end + 1)];
        arcs.push(registerArc(seg));
      }
    }
    return { mode: "arcs", arcs };
  });

  // 3. Reconstruct rings; if any simplified ring/polygon becomes degenerate,
  // self-intersecting, or moves/crosses a hole outside its shell, restore its
  // arcs globally so neighbouring polygons stay aligned too.
  const buildRing = (plan: (typeof ringArcPlans)[number]): Position[] => {
    if (plan.mode === "raw") return plan.coords;
    const out: Position[] = [];
    for (const { sig, reversed } of plan.arcs) {
      const pts = simplifiedArcs.get(sig)!;
      const start = out.length === 0 ? 0 : 1;
      if (reversed) {
        for (let i = pts.length - 1 - start; i >= 0; i--) {
          out.push(pts[i]);
        }
      } else {
        for (let i = start; i < pts.length; i++) {
          out.push(pts[i]);
        }
      }
    }
    return out;
  };

  const isRingValid = (ring: Position[]): boolean => {
    if (ring.length < 4 || !posEqual(ring[0], ring[ring.length - 1])) {
      return false;
    }
    try {
      const poly = turf.polygon([ring]);
      if (turf.area(poly) <= 0) return false;
      if (ring.length <= 2000 && turf.kinks(poly).features.length > 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const polygonRingGroups: number[][] = [];
  for (const ref of itemRefs) {
    if (ref.kind === "Polygon") polygonRingGroups.push(ref.ringIndices);
    else if (ref.kind === "MultiPolygon") {
      polygonRingGroups.push(...ref.polyRingIndices);
    }
  }

  // Map each arc signature to the polygon groups that use it so restoring an
  // arc only re-validates affected polygons instead of rescanning the whole layer.
  const arcToGroups = new Map<string, Set<number>>();
  for (let gIdx = 0; gIdx < polygonRingGroups.length; gIdx++) {
    for (const rIdx of polygonRingGroups[gIdx]) {
      const plan = ringArcPlans[rIdx];
      if (!plan || plan.mode !== "arcs") continue;
      for (const { sig } of plan.arcs) {
        let set = arcToGroups.get(sig);
        if (!set) {
          set = new Set();
          arcToGroups.set(sig, set);
        }
        set.add(gIdx);
      }
    }
  }

  const dirtyGroups = new Set<number>();
  for (let gIdx = 0; gIdx < polygonRingGroups.length; gIdx++) {
    dirtyGroups.add(gIdx);
  }

  while (dirtyGroups.size > 0) {
    const nextIter = dirtyGroups.values().next();
    if (nextIter.done) break;
    const gIdx = nextIter.value;
    dirtyGroups.delete(gIdx);

    const ringGroup = polygonRingGroups[gIdx];
    if (ringGroup.length === 0) continue;
    const rebuiltGroup = ringGroup.map((idx) => buildRing(ringArcPlans[idx]));
    let groupInvalid = rebuiltGroup.some((r) => !isRingValid(r));
    if (!groupInvalid && rebuiltGroup.length > 1) {
      try {
        const outerPoly = turf.polygon([rebuiltGroup[0]]);
        const outerLine = turf.lineString(rebuiltGroup[0]);
        for (let h = 1; h < rebuiltGroup.length; h++) {
          const holePoly = turf.polygon([rebuiltGroup[h]]);
          if (
            !turf.booleanWithin(holePoly, outerPoly) ||
            turf.lineIntersect(outerLine, turf.lineString(rebuiltGroup[h])).features.length > 0
          ) {
            groupInvalid = true;
            break;
          }
        }
      } catch {
        groupInvalid = true;
      }
    }
    if (groupInvalid) {
      for (const rIdx of ringGroup) {
        const plan = ringArcPlans[rIdx];
        if (!plan || plan.mode !== "arcs") continue;
        for (const { sig } of plan.arcs) {
          const orig = originalArcs.get(sig)!;
          if (simplifiedArcs.get(sig) !== orig) {
            simplifiedArcs.set(sig, orig);
            const affected = arcToGroups.get(sig);
            if (affected) {
              for (const aIdx of affected) dirtyGroups.add(aIdx);
            }
          }
        }
      }
    }
  }

  const finalRings = ringArcPlans.map(buildRing);

  const nextItems: CreatorGeoFeatureItem[] = itemRefs.map((ref) => {
    if (ref.kind === "other") return ref.item;
    if (ref.kind === "Polygon") {
      return {
        ...ref.item,
        geometry: {
          type: "Polygon",
          coordinates: ref.ringIndices.map((idx) => finalRings[idx]),
        },
      };
    }
    return {
      ...ref.item,
      geometry: {
        type: "MultiPolygon",
        coordinates: ref.polyRingIndices.map((poly) => poly.map((idx) => finalRings[idx])),
      },
    };
  });

  const vertexCount = nextItems.reduce((sum, i) => sum + countGeometryVertices(i.geometry), 0);
  return { items: nextItems, vertexCount };
}

/**
 * Topology-preserving simplification for LineString / MultiLineString layers.
 * Pins endpoints and shared network junctions (vertices with degree != 2) so
 * connected line networks stay joined after simplification.
 */
export function simplifyLineLayerTopology(
  items: readonly CreatorGeoFeatureItem[],
  toleranceMeters: number,
): { items: CreatorGeoFeatureItem[]; vertexCount: number } {
  if (toleranceMeters <= 0) {
    return {
      items: [...items],
      vertexCount: items.reduce((sum, i) => sum + countGeometryVertices(i.geometry), 0),
    };
  }

  const neighbors = new Map<string, Set<string>>();
  const forcedJunctions = new Set<string>();
  const allLines: Position[][] = [];

  const registerLine = (raw: readonly Position[]): number => {
    const cleaned: Position[] = [];
    for (const p of raw) {
      const rounded: Position = [round6(p[0]), round6(p[1])];
      const last = cleaned[cleaned.length - 1];
      if (!last || !posEqual(last, rounded)) cleaned.push(rounded);
    }
    const idx = allLines.length;
    allLines.push(cleaned);
    if (cleaned.length >= 2) {
      forcedJunctions.add(posKey(cleaned[0]));
      forcedJunctions.add(posKey(cleaned[cleaned.length - 1]));
      const seen = new Set<string>();
      for (let i = 0; i < cleaned.length; i++) {
        const k = posKey(cleaned[i]);
        if (seen.has(k)) forcedJunctions.add(k);
        seen.add(k);
        if (i > 0) addUndirectedEdge(neighbors, cleaned[i - 1], cleaned[i]);
      }
    }
    return idx;
  };

  type LineRef =
    | { kind: "other"; item: CreatorGeoFeatureItem }
    | { kind: "LineString"; item: CreatorGeoFeatureItem; lineIdx: number }
    | {
        kind: "MultiLineString";
        item: CreatorGeoFeatureItem;
        lineIndices: number[];
      };

  const refs: LineRef[] = items.map((item) => {
    if (item.geometry.type === "LineString") {
      return {
        kind: "LineString",
        item,
        lineIdx: registerLine(item.geometry.coordinates),
      };
    }
    if (item.geometry.type === "MultiLineString") {
      return {
        kind: "MultiLineString",
        item,
        lineIndices: item.geometry.coordinates.map(registerLine),
      };
    }
    return { kind: "other", item };
  });

  const simplifiedArcs = new Map<string, Position[]>();
  const simplifyLine = (coords: Position[]): Position[] => {
    if (coords.length <= 2) return coords;
    const junctions: number[] = [0];
    for (let i = 1; i < coords.length - 1; i++) {
      const k = posKey(coords[i]);
      if (forcedJunctions.has(k) || (neighbors.get(k)?.size ?? 0) !== 2) {
        junctions.push(i);
      }
    }
    junctions.push(coords.length - 1);

    const out: Position[] = [];
    for (let t = 0; t < junctions.length - 1; t++) {
      const seg = coords.slice(junctions[t], junctions[t + 1] + 1);
      const { canonical, reversed } = canonicalArcDirection(seg);
      const sig = arcSignature(canonical);
      let simp = simplifiedArcs.get(sig);
      if (!simp) {
        simp = simplifyPathMeters(canonical, toleranceMeters);
        simplifiedArcs.set(sig, simp);
      }
      const oriented = reversed ? [...simp].reverse() : simp;
      if (out.length === 0) out.push(...oriented);
      else out.push(...oriented.slice(1));
    }
    return out.length >= 2 ? out : coords;
  };

  const finalLines = allLines.map(simplifyLine);
  const nextItems: CreatorGeoFeatureItem[] = refs.map((ref) => {
    if (ref.kind === "other") return ref.item;
    if (ref.kind === "LineString") {
      return {
        ...ref.item,
        geometry: {
          type: "LineString",
          coordinates: finalLines[ref.lineIdx],
        },
      };
    }
    return {
      ...ref.item,
      geometry: {
        type: "MultiLineString",
        coordinates: ref.lineIndices.map((idx) => finalLines[idx]),
      },
    };
  });

  const vertexCount = nextItems.reduce((sum, i) => sum + countGeometryVertices(i.geometry), 0);
  return { items: nextItems, vertexCount };
}
