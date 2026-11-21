import type { Bounds, PlayAreaFeatureCollection, PlayAreaGeometry } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { MultiPolygon, Polygon } from "geojson";
import { orient2d } from "robust-predicates";

export const DEFAULT_OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

export interface PlaceSearchResult {
  id: string;
  name: string;
  displayName: string;
  type: string;
  bounds: Bounds;
  playArea: PlayAreaFeatureCollection;
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface CreatorPointItem {
  uid: string;
  name: string;
  lng: number;
  lat: number;
  enabled: boolean;
  tier?: string;
  osmId?: string;
  custom?: boolean;
  /** True when the user explicitly edited the name so OSM refetches preserve it. */
  nameEdited?: boolean;
  /** Original feature id and properties preserved when loading an existing .game.json. */
  originalId?: string | number;
  originalProperties?: Record<string, unknown>;
}

export interface StationFetchResult {
  stations: CreatorPointItem[];
  mergedCount: number;
  outsideCount: number;
  endpoint: string;
}

export interface PoiLayerQuerySpec {
  id: string;
  name: string;
  osmFilter: string;
  notableOnly?: boolean;
}

export interface PoiFetchResult {
  byLayerId: Record<string, CreatorPointItem[]>;
  endpoint: string;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Normalizes a place name for deduplication ("Gare du Nord" ≈ "gare du nord",
 * strips punctuation/accents/whitespace runs).
 */
export function normalizeMatchName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Expands `[west, south, east, north]` by `km` in every direction, clamped to
 * valid WGS84 bounds.
 */
export function expandBoundsKm(bounds: Bounds, km: number): Bounds {
  const [west, south, east, north] = bounds;
  if (km <= 0) return [west, south, east, north];
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const latDelta = km / 111.32;
  const cosLat = Math.max(0.1, Math.cos(midLat));
  const lngDelta = km / (111.32 * cosLat);
  return [
    round6(Math.max(-180, west - lngDelta)),
    round6(Math.max(-89.9, south - latDelta)),
    round6(Math.min(180, east + lngDelta)),
    round6(Math.min(89.9, north + latDelta)),
  ];
}

/** Computes `[west, south, east, north]` of a PlayAreaFeatureCollection, or null if empty/non-finite. */
export function tryPlayAreaBounds(playArea: PlayAreaFeatureCollection): Bounds | null {
  if (!playArea.features || playArea.features.length === 0) return null;
  const [w, s, e, n] = turf.bbox({
    type: "FeatureCollection",
    features: playArea.features.map((f) => ({
      type: "Feature" as const,
      geometry: f.geometry,
      properties: f.properties ?? null,
    })),
  });
  if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)) {
    return null;
  }
  return [round6(w), round6(s), round6(e), round6(n)];
}

/** Computes `[west, south, east, north]` of a PlayAreaFeatureCollection. */
export function playAreaBounds(playArea: PlayAreaFeatureCollection): Bounds {
  return tryPlayAreaBounds(playArea) ?? [-180, -85, 180, 85];
}

/** Builds a rectangular PlayAreaFeatureCollection from `[west, south, east, north]`. */
export function rectanglePlayArea(bounds: Bounds, name = "Play Area"): PlayAreaFeatureCollection {
  const [w, s, e, n] = bounds.map(round6) as Bounds;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
    ],
  };
}

function roundRing(coords: number[][]): [number, number][] {
  const out: [number, number][] = [];
  for (const pos of coords) {
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const p: [number, number] = [round6(pos[0]), round6(pos[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      out.push(p);
    }
  }
  if (out.length >= 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      out.push([first[0], first[1]]);
    }
  }
  return out;
}

/**
 * Validates a user-drawn polygon from `[lat, lng]` map clicks: rounds to 6
 * decimals, rejects collinear / zero-area polygons and self-intersecting rings.
 */
export function buildValidatedDrawnPlayArea(
  latLngPoints: readonly [number, number][],
  name = "Play Area",
): { ok: true; playArea: PlayAreaFeatureCollection } | { ok: false; error: string } {
  const ring = roundRing(latLngPoints.map(([lat, lng]) => [lng, lat]));
  if (ring.length < 4) {
    return {
      ok: false,
      error: "Place at least 3 distinct corners on the map.",
    };
  }
  const first = ring[0];
  const second = ring.find((p) => p[0] !== first[0] || p[1] !== first[1]);
  const hasNonCollinear =
    second !== undefined &&
    ring.some((p) => orient2d(first[0], first[1], second[0], second[1], p[0], p[1]) !== 0);
  const poly = turf.polygon([ring]);
  if (!hasNonCollinear) {
    return {
      ok: false,
      error: "The drawn corners lie on a straight line. Give the play area some width.",
    };
  }
  if (turf.kinks(poly).features.length > 0) {
    return {
      ok: false,
      error: "The polygon edges cross each other. Undo points and draw a simple loop.",
    };
  }
  if (turf.area(poly) < 1) {
    return {
      ok: false,
      error: "The drawn play area is too small.",
    };
  }
  return {
    ok: true,
    playArea: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name },
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      ],
    },
  };
}

function sanitizePolygonGeometry(geom: Polygon | MultiPolygon): PlayAreaGeometry | null {
  if (geom.type === "Polygon") {
    const rings = geom.coordinates.map(roundRing).filter((r) => r.length >= 4);
    return rings.length > 0 ? { type: "Polygon", coordinates: rings } : null;
  }
  const polys = geom.coordinates
    .map((poly) => poly.map(roundRing).filter((r) => r.length >= 4))
    .filter((rings) => rings.length > 0);
  if (polys.length === 0) return null;
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/**
 * Searches OpenStreetMap Nominatim for named administrative regions / cities
 * with ready-to-use simplified boundary polygons. Only call on explicit user
 * submit (not per-keystroke autocomplete) per Nominatim usage policy.
 */
export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
): Promise<PlaceSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({
    q: trimmed,
    format: "jsonv2",
    polygon_geojson: "1",
    polygon_threshold: "0.0005",
    limit: "6",
  });
  const res = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    throw new Error(`Place search failed (HTTP ${res.status})`);
  }
  const items = (await res.json()) as Array<{
    place_id: number;
    osm_type?: string;
    osm_id?: number;
    name?: string;
    display_name?: string;
    type?: string;
    boundingbox?: [string, string, string, string];
    geojson?: { type?: string; coordinates?: unknown };
  }>;

  const results: PlaceSearchResult[] = [];
  for (const item of items) {
    const name = item.name?.trim() || item.display_name?.split(",")[0]?.trim() || trimmed;
    const displayName = item.display_name?.trim() || name;

    let geometry: PlayAreaGeometry | null = null;
    if (item.geojson?.type === "Polygon" || item.geojson?.type === "MultiPolygon") {
      geometry = sanitizePolygonGeometry(item.geojson as Polygon | MultiPolygon);
    }

    let playArea: PlayAreaFeatureCollection;
    let bounds: Bounds;
    if (geometry) {
      playArea = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name },
            geometry,
          },
        ],
      };
      bounds = playAreaBounds(playArea);
    } else if (Array.isArray(item.boundingbox) && item.boundingbox.length === 4) {
      const [s, n, w, e] = item.boundingbox.map(Number);
      if (![w, s, e, n].every(Number.isFinite) || w === e || s === n) {
        continue;
      }
      bounds = [round6(w), round6(s), round6(e), round6(n)];
      playArea = rectanglePlayArea(bounds, name);
    } else {
      continue;
    }

    results.push({
      id: `${item.osm_type ?? "p"}-${item.osm_id ?? item.place_id}`,
      name,
      displayName,
      type: item.type ?? "place",
      bounds,
      playArea,
    });
  }
  return results;
}

// ── Client-side Overpass tag filter parser & matcher ─────────────────────────

type TagPredicate =
  | { kind: "eq"; key: string; value: string }
  | { kind: "neq"; key: string; value: string }
  | { kind: "exists"; key: string }
  | { kind: "not-exists"; key: string }
  | { kind: "regex"; key: string; regex: RegExp; negate: boolean };

const CLAUSE_RE = /^\[\s*(?:(!)\s*)?["']([^"']+)["']\s*(?:(=|!=|~|!~)\s*["']([^"']*)["'])?\s*\]/;

/**
 * Parses a standard Overpass tag filter chain such as
 * `["aeroway"="aerodrome"]["iata"]` into local tag predicates so multiple
 * POI categories can be fetched in a single batched Overpass query and split
 * back into layers client-side. Returns `null` if the filter uses syntax
 * outside simple bracket clauses (falling back to a dedicated query).
 */
export function parseSimpleOsmFilter(filter: string): TagPredicate[] | null {
  let rest = filter.trim();
  if (!rest) return null;
  const predicates: TagPredicate[] = [];
  while (rest.length > 0) {
    const match = CLAUSE_RE.exec(rest);
    if (!match) return null;
    const [, bang, key, op, val] = match;
    if (bang && op) return null;
    if (!op) {
      predicates.push({
        kind: bang ? "not-exists" : "exists",
        key,
      });
    } else if (op === "=") {
      predicates.push({ kind: "eq", key, value: val });
    } else if (op === "!=") {
      predicates.push({ kind: "neq", key, value: val });
    } else if (op === "~" || op === "!~") {
      try {
        // Overpass `~` / `!~` performs substring regex matching unless
        // the pattern itself includes `^` / `$` anchors.
        predicates.push({
          kind: "regex",
          key,
          regex: new RegExp(val),
          negate: op === "!~",
        });
      } catch {
        return null;
      }
    }
    rest = rest.slice(match[0].length).trim();
  }
  return predicates.length > 0 ? predicates : null;
}

export function matchesOsmPredicates(
  tags: Record<string, string> | undefined,
  predicates: readonly TagPredicate[],
): boolean {
  if (!tags) return false;
  for (const p of predicates) {
    const value = tags[p.key];
    switch (p.kind) {
      case "exists":
        if (value === undefined) return false;
        break;
      case "not-exists":
        if (value !== undefined) return false;
        break;
      case "eq":
        if (value !== p.value) return false;
        break;
      case "neq":
        if (value === p.value) return false;
        break;
      case "regex": {
        const matches = value !== undefined && p.regex.test(value);
        if (p.negate ? matches : !matches) return false;
        break;
      }
    }
  }
  return true;
}

/** Rejects obvious Overpass QL injection characters in user-provided tag filters. */
export function validateCustomOsmFilter(
  raw: string,
): { ok: true; filter: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'Enter an OSM tag filter (e.g. ["historic"="castle"]).' };
  }
  if (/[;\r\n()]/.test(trimmed)) {
    return {
      ok: false,
      error: 'Tag filters can only contain bracket clauses like ["key"="value"].',
    };
  }
  if (!parseSimpleOsmFilter(trimmed)) {
    return {
      ok: false,
      error:
        'Use Overpass bracket syntax like ["tourism"="museum"] or ["railway"="station"]["station"!="subway"].',
    };
  }
  return { ok: true, filter: trimmed };
}

/**
 * Executes an Overpass QL query directly in the browser with fast round-robin
 * failover across mirrors (trying each mirror immediately on 429/5xx/timeout
 * before waiting to retry a second pass).
 */
export async function runOverpassQuery(
  query: string,
  {
    customEndpoint,
    signal,
    onStatus,
  }: {
    customEndpoint?: string;
    signal?: AbortSignal;
    onStatus?: (message: string) => void;
  } = {},
): Promise<{ elements: OverpassElement[]; endpoint: string }> {
  const endpoints = customEndpoint?.trim()
    ? [customEndpoint.trim()]
    : [...DEFAULT_OVERPASS_ENDPOINTS];

  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };

  const passes = endpoints.length > 1 ? [0, 4] : [0, 4, 12];
  let lastError: Error | null = null;

  for (let passIdx = 0; passIdx < passes.length; passIdx++) {
    const waitSec = passes[passIdx];
    if (waitSec > 0) {
      onStatus?.(
        endpoints.length > 1
          ? `All Overpass mirrors busy, retrying in ${waitSec}s…`
          : `${hostOf(endpoints[0])} is busy, retrying in ${waitSec}s…`,
      );
      await sleep(waitSec * 1000, signal);
    }

    for (let idx = 0; idx < endpoints.length; idx++) {
      const endpoint = endpoints[idx];
      const host = hostOf(endpoint);
      const attemptAbort = new AbortController();
      let timedOut = false;
      const onCallerAbort = () => attemptAbort.abort();
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timeoutMatch = query.match(/\[timeout:(\d+)\]/i);
      const attemptTimeoutMs =
        (timeoutMatch ? Math.min(Number(timeoutMatch[1]), 90) : 30) * 1000 + 8000;
      const timer = setTimeout(() => {
        timedOut = true;
        attemptAbort.abort();
      }, attemptTimeoutMs);
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          body: new URLSearchParams({ data: query }),
          signal: attemptAbort.signal,
        });
        if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
          lastError = new Error(`Overpass (${host}) returned HTTP ${res.status}`);
        } else if (!res.ok) {
          const snippet = (await res.text().catch(() => "")).slice(0, 160);
          const err = new Error(
            `Overpass (${host}) failed (${res.status}): ${snippet || res.statusText}`,
          );
          // Syntax error (400) or single-endpoint 403: stop immediately.
          // Multi-mirror 403 (WAF/geo block) falls through to try the next mirror.
          if (res.status === 400 || (res.status === 403 && endpoints.length === 1)) {
            throw err;
          }
          lastError = err;
        } else {
          const data = (await res.json()) as {
            elements?: OverpassElement[];
            remark?: string;
          };
          if (
            typeof data.remark === "string" &&
            /runtime error|timed out|out of memory|too many/i.test(data.remark)
          ) {
            lastError = new Error(`Overpass (${host}) error: ${data.remark.slice(0, 160)}`);
          } else {
            return {
              elements: Array.isArray(data.elements) ? data.elements : [],
              endpoint,
            };
          }
        }
      } catch (err: unknown) {
        if (signal?.aborted) {
          throw err instanceof DOMException ? err : new DOMException("Aborted", "AbortError");
        }
        if (timedOut) {
          lastError = new Error(
            `Overpass (${host}) timed out after ${Math.round(attemptTimeoutMs / 1000)}s`,
          );
        } else {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw err;
          }
          const errorObj = err instanceof Error ? err : new Error(String(err));
          if (
            errorObj.message.includes("(400)") ||
            (errorObj.message.includes("(403)") && endpoints.length === 1)
          ) {
            throw errorObj;
          }
          lastError = errorObj;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
      }

      if (idx + 1 < endpoints.length) {
        onStatus?.(`${host} unavailable, trying ${hostOf(endpoints[idx + 1])}…`);
      }
    }
  }

  throw lastError ?? new Error("Overpass query failed. Please try again in a moment.");
}

function extractElementPoint(
  el: OverpassElement,
  preferEnglishName: boolean,
): { name: string; lng: number; lat: number; osmId: string } | null {
  const tags = el.tags;
  const rawName = preferEnglishName
    ? (tags?.["name:en"] ?? tags?.name)
    : (tags?.name ?? tags?.["name:en"]);
  const name = rawName?.trim();
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    name,
    lng: round6(lon!),
    lat: round6(lat!),
    osmId: `${el.type}/${el.id}`,
  };
}

/**
 * Deduplicates points by:
 * 1) Same normalized name within `sameNameMeters` (handles OSM having separate
 *    mainline + metro + halt nodes for the same station), and
 * 2) Exact/near-identical coordinates within `nearCoordMeters`.
 */
export function dedupePointItems(
  items: readonly CreatorPointItem[],
  {
    sameNameMeters = 250,
    nearCoordMeters = 25,
  }: { sameNameMeters?: number; nearCoordMeters?: number } = {},
): { items: CreatorPointItem[]; mergedCount: number } {
  const kept: CreatorPointItem[] = [];
  const keptNormNames: string[] = [];
  let mergedCount = 0;

  const maxDistKm = Math.max(sameNameMeters, nearCoordMeters) / 1000;
  const latDelta = maxDistKm / 110.57 + 0.001;

  for (const item of items) {
    const norm = normalizeMatchName(item.name);
    const pt = turf.point([item.lng, item.lat]);
    const cosLat = Math.max(0.05, Math.cos((item.lat * Math.PI) / 180));
    const lngDelta = maxDistKm / (111.32 * cosLat) + 0.001;
    let duplicate = false;

    for (let i = 0; i < kept.length; i++) {
      const other = kept[i];
      if (Math.abs(item.lat - other.lat) > latDelta || Math.abs(item.lng - other.lng) > lngDelta) {
        continue;
      }
      const distMeters =
        turf.distance(pt, turf.point([other.lng, other.lat]), {
          units: "kilometers",
        }) * 1000;
      if (
        distMeters <= nearCoordMeters ||
        (norm !== "" && norm === keptNormNames[i] && distMeters <= sameNameMeters)
      ) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      mergedCount++;
    } else {
      kept.push(item);
      keptNormNames.push(norm);
    }
  }

  return { items: kept, mergedCount };
}

function pointInPlayArea(lng: number, lat: number, playArea: PlayAreaFeatureCollection): boolean {
  const pt = turf.point([lng, lat]);
  return playArea.features.some((f) => turf.booleanPointInPolygon(pt, f.geometry));
}

export function buildStationOverpassQuery(filters: readonly string[], bounds: Bounds): string {
  const [w, s, e, n] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const clauses = filters.map((f) => `  nwr${f}["name"](${bbox});`).join("\n");
  return `[out:json][timeout:90];\n(\n${clauses}\n);\nout center tags;`;
}

/**
 * Fetches transit stations / hiding zones from Overpass inside the play area,
 * filters to points inside the play area polygon, and deduplicates overlapping
 * OSM station nodes.
 */
export async function fetchStationsFromOsm({
  filters,
  playArea,
  dedupeMeters = 250,
  preferEnglishName = false,
  customEndpoint,
  rawQueryOverride,
  signal,
  onStatus,
}: {
  filters: readonly string[];
  playArea: PlayAreaFeatureCollection;
  dedupeMeters?: number;
  preferEnglishName?: boolean;
  customEndpoint?: string;
  rawQueryOverride?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<StationFetchResult> {
  const customQuery = rawQueryOverride?.trim();
  if (!customQuery && filters.length === 0) {
    throw new Error("Choose a station preset or enter an OSM tag filter.");
  }
  const bounds = playAreaBounds(playArea);
  const query = customQuery || buildStationOverpassQuery(filters, bounds);
  onStatus?.("Querying OpenStreetMap for stations…");
  const { elements, endpoint } = await runOverpassQuery(query, {
    customEndpoint,
    signal,
    onStatus,
  });

  const inside: CreatorPointItem[] = [];
  let outsideCount = 0;
  for (const el of elements) {
    const pt = extractElementPoint(el, preferEnglishName);
    if (!pt) continue;
    if (!pointInPlayArea(pt.lng, pt.lat, playArea)) {
      outsideCount++;
      continue;
    }
    inside.push({
      uid: `st-${pt.osmId}`,
      name: pt.name,
      lng: pt.lng,
      lat: pt.lat,
      enabled: true,
      osmId: pt.osmId,
    });
  }

  // Prefer nodes over ways/relations when deduplicating stations so exact
  // stop pins take precedence over sprawling station building centroids.
  inside.sort((a, b) => {
    const rank = (uid: string) =>
      uid.startsWith("st-node/") ? 0 : uid.startsWith("st-way/") ? 1 : 2;
    return rank(a.uid) - rank(b.uid) || a.name.localeCompare(b.name);
  });

  const { items, mergedCount } = dedupePointItems(inside, {
    sameNameMeters: dedupeMeters,
    nearCoordMeters: 25,
  });
  items.sort((a, b) => a.name.localeCompare(b.name));

  return { stations: items, mergedCount, outsideCount, endpoint };
}

export function buildBatchedPoiOverpassQuery(
  layers: readonly PoiLayerQuerySpec[],
  bounds: Bounds,
): string {
  const [w, s, e, n] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const clauses: string[] = [];
  for (const layer of layers) {
    const base = layer.osmFilter.trim();
    if (layer.notableOnly) {
      clauses.push(`  nwr${base}["name"]["wikidata"](${bbox});`);
      clauses.push(`  nwr${base}["name"]["wikipedia"](${bbox});`);
    } else {
      clauses.push(`  nwr${base}["name"](${bbox});`);
    }
  }
  return `[out:json][timeout:120];\n(\n${clauses.join("\n")}\n);\nout center tags;`;
}

/**
 * Fetches all selected POI feature layers in ONE batched Overpass query and
 * classifies returned OSM elements back into their respective layers locally.
 */
export async function fetchPoiLayersFromOsm({
  layers,
  playArea,
  bufferKm = 2,
  preferEnglishName = false,
  customEndpoint,
  signal,
  onStatus,
}: {
  layers: readonly PoiLayerQuerySpec[];
  playArea: PlayAreaFeatureCollection;
  bufferKm?: number;
  preferEnglishName?: boolean;
  customEndpoint?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<PoiFetchResult> {
  if (layers.length === 0) {
    return { byLayerId: {}, endpoint: "" };
  }
  const bounds = expandBoundsKm(playAreaBounds(playArea), bufferKm);
  const parsedLayers = layers.map((layer) => {
    const predicates = parseSimpleOsmFilter(layer.osmFilter);
    if (!predicates) {
      throw new Error(`Layer "${layer.name}" has an unsupported OSM filter: ${layer.osmFilter}`);
    }
    return { layer, predicates };
  });

  const query = buildBatchedPoiOverpassQuery(layers, bounds);
  onStatus?.(
    `Querying OpenStreetMap for ${layers.length} feature layer${layers.length === 1 ? "" : "s"}…`,
  );
  const { elements, endpoint } = await runOverpassQuery(query, {
    customEndpoint,
    signal,
    onStatus,
  });

  const buckets = new Map<string, CreatorPointItem[]>();
  for (const layer of layers) buckets.set(layer.id, []);

  for (const el of elements) {
    const pt = extractElementPoint(el, preferEnglishName);
    if (!pt) continue;
    for (const { layer, predicates } of parsedLayers) {
      if (!matchesOsmPredicates(el.tags, predicates)) continue;
      if (layer.notableOnly && !el.tags?.wikidata && !el.tags?.wikipedia) {
        continue;
      }
      buckets.get(layer.id)!.push({
        uid: `poi-${layer.id}-${pt.osmId}`,
        name: pt.name,
        lng: pt.lng,
        lat: pt.lat,
        enabled: true,
        osmId: pt.osmId,
      });
    }
  }

  const byLayerId: Record<string, CreatorPointItem[]> = {};
  for (const layer of layers) {
    const raw = buckets.get(layer.id) ?? [];
    const { items } = dedupePointItems(raw, {
      sameNameMeters: 150,
      nearCoordMeters: 20,
    });
    items.sort((a, b) => a.name.localeCompare(b.name));
    byLayerId[layer.id] = items;
  }

  return { byLayerId, endpoint };
}

/**
 * Runs an arbitrary user-edited Overpass QL query and converts all returned
 * elements with coordinates into deduplicated point items for a single layer.
 */
export async function fetchRawPoiQueryFromOsm({
  query,
  preferEnglishName = false,
  customEndpoint,
  signal,
  onStatus,
}: {
  query: string;
  preferEnglishName?: boolean;
  customEndpoint?: string;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<{ items: CreatorPointItem[]; endpoint: string }> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Enter an Overpass QL query to run.");
  }
  onStatus?.("Running custom Overpass QL query…");
  const { elements, endpoint } = await runOverpassQuery(trimmed, {
    customEndpoint,
    signal,
    onStatus,
  });
  const raw: CreatorPointItem[] = [];
  for (const el of elements) {
    const pt = extractElementPoint(el, preferEnglishName);
    if (!pt) continue;
    raw.push({
      uid: `raw-poi-${pt.osmId}`,
      name: pt.name,
      lng: pt.lng,
      lat: pt.lat,
      enabled: true,
      osmId: pt.osmId,
    });
  }
  const { items } = dedupePointItems(raw, {
    sameNameMeters: 150,
    nearCoordMeters: 25,
  });
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, endpoint };
}
