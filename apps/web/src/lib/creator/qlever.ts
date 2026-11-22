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

import {
  buildPlayAreaMask,
  countGeometryVertices,
  type CreatorGeoFeatureItem,
  cropLineToPlayAreaMask,
  cropRegionToPlayAreaMask,
  type LineFetchResult,
  maskQueryBounds,
  MIN_LINE_CROP_BUFFER_KM,
  pointInPlayAreaMask,
  type RegionFetchResult,
  simplifyLineLayerTopology,
  simplifyPolygonLayerTopology,
} from "@/lib/creator/osmGeometry";
import {
  type CreatorPointItem,
  dedupePointItems,
  parseSimpleOsmFilter,
  playAreaBounds,
} from "@/lib/creator/overpass";

export const QLEVER_OSM_ENDPOINT = "https://qlever.dev/api/osm-planet";
export const QLEVER_WEB_UI_URL = "https://qlever.dev/osm-planet";

const OSM_KEY_PREFIX = "https://www.openstreetmap.org/wiki/Key:";
const OSM_NAME_EN_IRI = "<https://www.openstreetmap.org/wiki/Key:name:en>";
const OSM2RDF_PREFIX = "https://osm2rdf.cs.uni-freiburg.de/rdf#";
const OSM2RDF_KEY_PREFIX = "https://osm2rdf.cs.uni-freiburg.de/rdf/key#";
// Minimum ratio of sum(admin_level=4 child area) / country area required to
// treat a country as covered by admin_level=4 subdivisions (countries with
// large maritime EEZs like France sit around ~53%; partial adm4 countries like
// Portugal sit at ~2%, and adm4-less countries like Ireland/Liechtenstein at 0%).
const MIN_ADM4_COUNTRY_COVERAGE_RATIO = 0.35;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

interface SparqlBindingValue {
  type: string;
  value: string;
  datatype?: string;
}

interface SparqlJsonResponse {
  results?: {
    bindings?: Array<Record<string, SparqlBindingValue | undefined>>;
  };
  exception?: string;
}

function escapeSparqlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function isSafeOsmKey(key: string): boolean {
  return key.length > 0 && !/[\s<>"{}|^`\\]/.test(key);
}

function osmKeyIri(key: string): string {
  return `<${OSM_KEY_PREFIX}${key}>`;
}

function sparqlTagLiteral(key: string, value: string): string {
  // osm2rdf stores integer-typed tags like `admin_level` as numeric literals.
  if (key === "admin_level" && /^\d+$/.test(value)) {
    return String(Number(value));
  }
  return `"${escapeSparqlString(value)}"`;
}

function bboxToWktPolygon(bounds: Bounds): string {
  const w = Math.max(-180, Math.min(180, round6(bounds[0])));
  const s = Math.max(-89.9, Math.min(89.9, round6(bounds[1])));
  const e = Math.max(-180, Math.min(180, round6(bounds[2])));
  const n = Math.max(-89.9, Math.min(89.9, round6(bounds[3])));
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

/**
 * Converts a simple Overpass bracket filter chain such as
 * `["aeroway"="aerodrome"]["iata"]` into QLever `osm2rdf` SPARQL triple
 * patterns on `?s`. Returns `null` if any clause cannot be represented safely.
 */
export function osmFilterToSparqlPatterns(osmFilter: string): string | null {
  const predicates = parseSimpleOsmFilter(osmFilter);
  if (!predicates || predicates.length === 0) return null;

  const lines: string[] = [];
  for (let i = 0; i < predicates.length; i++) {
    const p = predicates[i];
    if (!isSafeOsmKey(p.key)) return null;
    const pred = osmKeyIri(p.key);
    switch (p.kind) {
      case "exists":
        lines.push(`  ?s ${pred} ?_ex${i} .`);
        break;
      case "not-exists":
        lines.push(`  FILTER NOT EXISTS { ?s ${pred} ?_nex${i} . }`);
        break;
      case "eq": {
        lines.push(`  ?s ${pred} ${sparqlTagLiteral(p.key, p.value)} .`);
        break;
      }
      case "neq": {
        lines.push(`  FILTER NOT EXISTS { ?s ${pred} ${sparqlTagLiteral(p.key, p.value)} . }`);
        break;
      }
      case "regex": {
        const escaped = escapeSparqlString(p.pattern);
        if (p.negate) {
          lines.push(
            `  FILTER NOT EXISTS { ?s ${pred} ?_rx${i} . FILTER(REGEX(STR(?_rx${i}), "${escaped}")) }`,
          );
        } else {
          lines.push(`  ?s ${pred} ?_rx${i} . FILTER(REGEX(STR(?_rx${i}), "${escaped}"))`);
        }
        break;
      }
    }
  }
  return lines.join("\n");
}

// ── Lightweight WKT parser (POINT, LINESTRING, POLYGON, MULTI*) ──────────────

function parseCoordinateSequence(text: string): Position[] {
  const out: Position[] = [];
  const parts = text.split(",");
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const lng = Number(tokens[0]);
    const lat = Number(tokens[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue;
    const pos: Position = [round6(lng), round6(lat)];
    const last = out[out.length - 1];
    if (!last || last[0] !== pos[0] || last[1] !== pos[1]) {
      out.push(pos);
    }
  }
  return out;
}

function closeRing(coords: Position[]): Position[] | null {
  if (coords.length < 3) return null;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const ring =
    first[0] === last[0] && first[1] === last[1]
      ? coords
      : [...coords, [first[0], first[1]] as Position];
  return ring.length >= 4 ? ring : null;
}

function splitTopLevelGroups(content: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        groups.push(content.slice(start, i));
        start = -1;
      }
    }
  }
  return groups;
}

function extractOuterParens(wkt: string): string | null {
  const open = wkt.indexOf("(");
  const close = wkt.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  return wkt.slice(open + 1, close).trim();
}

export function parseWktPoint(wkt: string): [number, number] | null {
  const match =
    /^\s*POINT\s*\(\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i.exec(
      wkt,
    );
  if (!match) return null;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  return [round6(lng), round6(lat)];
}

export function parseWktGeometry(wkt: string): GeoJsonGeometry | null {
  const trimmed = wkt.trim();
  const typeMatch = /^([A-Z]+)\b/i.exec(trimmed);
  if (!typeMatch) return null;
  const type = typeMatch[1].toUpperCase();

  if (type === "POINT") {
    const pt = parseWktPoint(trimmed);
    return pt ? { type: "Point", coordinates: pt } : null;
  }

  const body = extractOuterParens(trimmed);
  if (!body) return null;

  if (type === "LINESTRING") {
    const coords = parseCoordinateSequence(body);
    return coords.length >= 2 ? { type: "LineString", coordinates: coords } : null;
  }

  if (type === "MULTILINESTRING") {
    const lines = splitTopLevelGroups(body)
      .map(parseCoordinateSequence)
      .filter((l) => l.length >= 2);
    if (lines.length === 0) return null;
    return lines.length === 1
      ? ({ type: "LineString", coordinates: lines[0] } satisfies LineStringGeometry)
      : ({ type: "MultiLineString", coordinates: lines } satisfies MultiLineStringGeometry);
  }

  if (type === "POLYGON") {
    const rings = splitTopLevelGroups(body)
      .map((g) => closeRing(parseCoordinateSequence(g)))
      .filter((r): r is Position[] => r !== null);
    return rings.length > 0
      ? ({ type: "Polygon", coordinates: rings } satisfies PolygonGeometry)
      : null;
  }

  if (type === "MULTIPOLYGON") {
    const polys = splitTopLevelGroups(body)
      .map((polyStr) =>
        splitTopLevelGroups(polyStr)
          .map((g) => closeRing(parseCoordinateSequence(g)))
          .filter((r): r is Position[] => r !== null),
      )
      .filter((rings) => rings.length > 0);
    if (polys.length === 0) return null;
    return polys.length === 1
      ? ({ type: "Polygon", coordinates: polys[0] } satisfies PolygonGeometry)
      : ({ type: "MultiPolygon", coordinates: polys } satisfies MultiPolygonGeometry);
  }

  return null;
}

// ── SPARQL runner ────────────────────────────────────────────────────────────

export async function runQleverQuery(
  query: string,
  {
    signal,
    timeoutMs = 25_000,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<Array<Record<string, SparqlBindingValue | undefined>>> {
  const attemptAbort = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => attemptAbort.abort();
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    attemptAbort.abort();
  }, timeoutMs);

  try {
    const res = await fetch(QLEVER_OSM_ENDPOINT, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/sparql-results+json",
      },
      body: new URLSearchParams({ query }),
      signal: attemptAbort.signal,
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 160);
      throw new Error(`QLever returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
    }
    const data = (await res.json()) as SparqlJsonResponse;
    if (data.exception) {
      throw new Error(`QLever query error: ${data.exception.slice(0, 160)}`);
    }
    return Array.isArray(data.results?.bindings) ? data.results.bindings : [];
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw err instanceof DOMException ? err : new DOMException("Aborted", "AbortError");
    }
    if (timedOut) {
      throw new Error(`QLever timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

// ── Covering admin-region resolver (cached per rounded bbox) ─────────────────

const MAX_REGION_CACHE = 16;
const coveringRegionCache = new Map<string, string[]>();
const missingDirectRelationIds = new Set<number>();

export function clearQleverRegionCache(): void {
  coveringRegionCache.clear();
  missingDirectRelationIds.clear();
}

/**
 * Finds the minimal set of OSM administrative relations (`admin_level=4` plus
 * any intersecting `admin_level=2` country not substantially covered by
 * `admin_level=4` subdivisions inside the bbox, e.g. Ireland, Liechtenstein,
 * Portugal, Slovenia) whose union covers `bounds`.
 * Uses two fast queries (~0.35s + ~0.07s) and caches results by exact WKT box.
 */
export async function resolveQleverCoveringRegions(
  bounds: Bounds,
  {
    signal,
    onStatus,
  }: {
    signal?: AbortSignal;
    onStatus?: (message: string) => void;
  } = {},
): Promise<string[]> {
  const box = bboxToWktPolygon(bounds);
  const cached = coveringRegionCache.get(box);
  if (cached) return cached;

  onStatus?.("Resolving covering regions in QLever…");
  const findQuery = `PREFIX osmkey: <${OSM_KEY_PREFIX}>
PREFIX osm: <https://www.openstreetmap.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT DISTINCT ?r ?lvl WHERE {
  ?r a osm:relation ;
     osmkey:type "boundary" ;
     osmkey:boundary "administrative" ;
     osmkey:admin_level ?lvl ;
     geo:hasGeometry/geo:asWKT ?wkt .
  VALUES ?lvl { 2 4 }
  FILTER(geof:sfIntersects(?wkt, "${box}"^^geo:wktLiteral))
}`;

  const rows = await runQleverQuery(findQuery, { signal, timeoutMs: 20_000 });
  const adm2 = new Set<string>();
  const adm4 = new Set<string>();
  for (const row of rows) {
    const uri = row.r?.value;
    const lvl = row.lvl?.value;
    if (!uri) continue;
    if (lvl === "4") adm4.add(uri);
    else if (lvl === "2") adm2.add(uri);
  }

  let includedCountries: string[];
  if (adm4.size === 0 || adm2.size === 0) {
    includedCountries = [...adm2];
  } else {
    // Check which intersecting countries are actually covered by admin_level=4
    // subdivisions in this bbox (constraining ?sub to admin_level=4 keeps this
    // query around ~70ms on QLever). Any country with 0 in-bbox adm4 children
    // or < 35% adm4 area coverage (e.g. Ireland, Portugal, Liechtenstein) stays.
    const cVals = [...adm2].map((u) => `<${u}>`).join(" ");
    const rList = [...adm4].map((u) => `<${u}>`).join(", ");
    const coverageQuery = `PREFIX osmkey: <${OSM_KEY_PREFIX}>
PREFIX osm: <https://www.openstreetmap.org/>
PREFIX osm2rdf: <${OSM2RDF_PREFIX}>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT ?c (SUM(?a) AS ?adm4Area) (SAMPLE(?ca) AS ?cArea) (COUNT(?inBox) AS ?inBoxCnt) WHERE {
  VALUES ?c { ${cVals} }
  OPTIONAL { ?c osm2rdf:area ?ca . }
  OPTIONAL {
    ?sub a osm:relation ;
         osmkey:type "boundary" ;
         osmkey:boundary "administrative" ;
         osmkey:admin_level 4 ;
         osm2rdf:area ?a .
    ?c ogc:sfCovers ?sub .
    BIND(IF(?sub IN (${rList}), 1, ?unbound) AS ?inBox)
  }
} GROUP BY ?c`;
    const covRows = await runQleverQuery(coverageQuery, { signal, timeoutMs: 15_000 });
    const coveredCountries = new Set<string>();
    for (const row of covRows) {
      const uri = row.c?.value;
      if (!uri) continue;
      const inBoxCnt = Number(row.inBoxCnt?.value);
      const adm4Area = Number(row.adm4Area?.value);
      const cArea = Number(row.cArea?.value);
      if (
        Number.isFinite(inBoxCnt) &&
        inBoxCnt > 0 &&
        Number.isFinite(cArea) &&
        cArea > 0 &&
        Number.isFinite(adm4Area) &&
        adm4Area / cArea >= MIN_ADM4_COUNTRY_COVERAGE_RATIO
      ) {
        coveredCountries.add(uri);
      }
    }
    includedCountries = [...adm2].filter((uri) => !coveredCountries.has(uri));
  }

  const regions = [...adm4, ...includedCountries];
  if (coveringRegionCache.size >= MAX_REGION_CACHE) {
    const oldest = coveringRegionCache.keys().next().value;
    if (oldest !== undefined) coveringRegionCache.delete(oldest);
  }
  coveringRegionCache.set(box, regions);
  return regions;
}

function osmIdFromUri(uri: string | undefined, fallbackIdx: number): string {
  if (!uri) return `qlever/${fallbackIdx}`;
  const match = /openstreetmap\.org\/(node|way|relation)\/(\d+)$/.exec(uri);
  return match ? `${match[1]}/${match[2]}` : uri;
}

function pickBindingName(
  row: Record<string, SparqlBindingValue | undefined>,
  preferEnglishName: boolean,
): string | null {
  const local = row.name?.value?.trim();
  const en = row.name_en?.value?.trim();
  const chosen = preferEnglishName ? en || local : local || en;
  return chosen || null;
}

// ── POI fetching via QLever ──────────────────────────────────────────────────

export function buildQleverPoiQuery({
  osmFilter,
  bounds,
  regionIris,
  notableOnly = false,
  preferEnglishName = false,
}: {
  osmFilter: string;
  bounds: Bounds;
  regionIris: readonly string[];
  notableOnly?: boolean;
  preferEnglishName?: boolean;
}): string | null {
  const tagPatterns = osmFilterToSparqlPatterns(osmFilter);
  if (!tagPatterns) return null;

  const [w, s, e, n] = bounds.map(round6) as Bounds;
  const irisList = regionIris.map((u) => `<${u}>`).join(" ");
  const regionClause =
    regionIris.length > 0
      ? `  {\n    VALUES ?region { ${irisList} }\n    ?s ogc:sfIntersects ?region .\n  } UNION {\n    VALUES ?s { ${irisList} }\n  }\n`
      : "";
  const notableClause = notableOnly
    ? `  OPTIONAL { ?s <${OSM2RDF_KEY_PREFIX}wikidata> ?_wd . }\n  OPTIONAL { ?s <${OSM2RDF_KEY_PREFIX}wikipedia> ?_wp . }\n  FILTER(BOUND(?_wd) || BOUND(?_wp))\n`
    : "";
  const enSelect = preferEnglishName ? " ?name_en" : "";
  const enOptional = preferEnglishName ? `  OPTIONAL { ?s ${OSM_NAME_EN_IRI} ?name_en . }\n` : "";

  return `PREFIX osmkey: <${OSM_KEY_PREFIX}>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT DISTINCT ?s ?name${enSelect} (geof:centroid(?wkt) AS ?c) WHERE {
${regionClause}${tagPatterns}
  ?s osmkey:name ?name ;
     geo:hasGeometry/geo:asWKT ?wkt .
${enOptional}${notableClause}  BIND(geof:centroid(?wkt) AS ?pc)
  FILTER(geof:latitude(?pc) >= ${s} && geof:latitude(?pc) <= ${n} && geof:longitude(?pc) >= ${w} && geof:longitude(?pc) <= ${e})
}`;
}

export async function fetchPoiLayerFromQlever({
  id,
  name,
  osmFilter,
  notableOnly = false,
  playArea,
  playAreaOsmRelationId,
  bufferKm = 0,
  preferEnglishName = false,
  signal,
  onStatus,
}: {
  id: string;
  name: string;
  osmFilter: string;
  notableOnly?: boolean;
  playArea: PlayAreaFeatureCollection;
  playAreaOsmRelationId?: number | null;
  bufferKm?: number;
  preferEnglishName?: boolean;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<{ items: CreatorPointItem[]; endpoint: string }> {
  const mask = buildPlayAreaMask(playArea, bufferKm);
  const bounds = bufferKm > 0 ? maskQueryBounds(mask) : playAreaBounds(playArea);
  const useDirectRelation =
    Boolean(playAreaOsmRelationId) &&
    bufferKm <= 0 &&
    !missingDirectRelationIds.has(playAreaOsmRelationId!);

  const runWithRegions = async (regionIris: readonly string[]) => {
    if (regionIris.length === 0) {
      throw new Error(
        "No enclosing OSM boundary found in QLever for this area. Switch to Overpass or expand the play area.",
      );
    }
    const query = buildQleverPoiQuery({
      osmFilter,
      bounds,
      regionIris,
      notableOnly,
      preferEnglishName,
    });
    if (!query) {
      throw new Error(`Unsupported OSM filter for QLever: ${osmFilter}`);
    }
    onStatus?.(`Querying QLever for ${name}…`);
    return runQleverQuery(query, { signal, timeoutMs: 25_000 });
  };

  let rows: Array<Record<string, SparqlBindingValue | undefined>>;
  if (useDirectRelation) {
    const directIris = [`https://www.openstreetmap.org/relation/${playAreaOsmRelationId}`];
    rows = await runWithRegions(directIris);
    if (rows.length === 0) {
      // Fallback once in case Nominatim's relation ID is missing/unindexed in QLever's snapshot.
      const fallbackIris = await resolveQleverCoveringRegions(bounds, { signal, onStatus });
      if (fallbackIris.length > 0 && !fallbackIris.includes(directIris[0])) {
        const fallbackRows = await runWithRegions(fallbackIris);
        if (fallbackRows.length > 0) {
          missingDirectRelationIds.add(playAreaOsmRelationId!);
          rows = fallbackRows;
        }
      }
    }
  } else {
    const regionIris = await resolveQleverCoveringRegions(bounds, { signal, onStatus });
    rows = await runWithRegions(regionIris);
  }
  const raw: CreatorPointItem[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = pickBindingName(row, preferEnglishName);
    const wkt = row.c?.value;
    if (!label || !wkt) continue;
    const pt = parseWktPoint(wkt);
    if (!pt) continue;
    if (!pointInPlayAreaMask(pt[0], pt[1], mask)) continue;
    const osmId = osmIdFromUri(row.s?.value, i);
    raw.push({
      uid: `poi-${id}-${osmId}`,
      name: label,
      lng: pt[0],
      lat: pt[1],
      enabled: true,
      osmId,
    });
  }

  const { items } = dedupePointItems(raw, {
    sameNameMeters: 150,
    nearCoordMeters: 20,
  });
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, endpoint: QLEVER_OSM_ENDPOINT };
}

// ── Admin Region Polygons via QLever ─────────────────────────────────────────

export function buildQleverAdminRegionsQuery({
  adminLevel,
  bounds,
  preferEnglishName = false,
}: {
  adminLevel: number;
  bounds: Bounds;
  preferEnglishName?: boolean;
}): string {
  const box = bboxToWktPolygon(bounds);
  const enSelect = preferEnglishName ? " ?name_en" : "";
  const enOptional = preferEnglishName ? `  OPTIONAL { ?s ${OSM_NAME_EN_IRI} ?name_en . }\n` : "";
  return `PREFIX osmkey: <${OSM_KEY_PREFIX}>
PREFIX osm: <https://www.openstreetmap.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
SELECT DISTINCT ?s ?name${enSelect} ?wkt WHERE {
  ?s a osm:relation ;
     osmkey:type "boundary" ;
     osmkey:boundary "administrative" ;
     osmkey:admin_level ${Math.trunc(adminLevel)} ;
     osmkey:name ?name ;
     geo:hasGeometry/geo:asWKT ?wkt .
${enOptional}  FILTER(geof:sfIntersects(?wkt, "${box}"^^geo:wktLiteral))
}`;
}

export async function fetchAdminRegionsFromQlever({
  adminLevel,
  playArea,
  bufferKm = 0,
  toleranceMeters = 15,
  preferEnglishName = false,
  signal,
  onStatus,
}: {
  adminLevel: number;
  playArea: PlayAreaFeatureCollection;
  bufferKm?: number;
  toleranceMeters?: number;
  preferEnglishName?: boolean;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<RegionFetchResult> {
  const mask = buildPlayAreaMask(playArea, bufferKm);
  const bounds = bufferKm > 0 ? maskQueryBounds(mask) : playAreaBounds(playArea);
  const query = buildQleverAdminRegionsQuery({ adminLevel, bounds, preferEnglishName });
  onStatus?.(`Querying QLever for admin_level=${adminLevel} boundaries…`);
  const rows = await runQleverQuery(query, { signal, timeoutMs: 30_000 });

  onStatus?.("Cropping and simplifying region polygons…");
  const rawItems: CreatorGeoFeatureItem[] = [];
  const seenIds = new Set<string>();
  let skippedOutside = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = pickBindingName(row, preferEnglishName);
    const wkt = row.wkt?.value;
    if (!label || !wkt) continue;
    const osmId = osmIdFromUri(row.s?.value, i);
    if (seenIds.has(osmId)) continue;

    const geom = parseWktGeometry(wkt);
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) continue;

    const cropped = cropRegionToPlayAreaMask(geom, mask);
    if (!cropped) {
      skippedOutside++;
      continue;
    }

    seenIds.add(osmId);
    rawItems.push({
      uid: `osm-rel-${osmId}`,
      name: label,
      geometry: cropped,
      enabled: true,
    });
  }

  rawItems.sort((a, b) => a.name.localeCompare(b.name));
  const simplified = simplifyPolygonLayerTopology(rawItems, toleranceMeters);
  return {
    items: simplified.items,
    vertexCount: simplified.vertexCount,
    skippedOutside,
    endpoint: QLEVER_OSM_ENDPOINT,
  };
}

// ── Line Layers via QLever ───────────────────────────────────────────────────

export function buildQleverLineQuery({
  osmFilter,
  bounds,
  regionIris,
  preferEnglishName = false,
}: {
  osmFilter: string;
  bounds: Bounds;
  regionIris: readonly string[];
  preferEnglishName?: boolean;
}): string | null {
  const tagPatterns = osmFilterToSparqlPatterns(osmFilter);
  if (!tagPatterns) return null;

  const box = bboxToWktPolygon(bounds);
  const regionClause =
    regionIris.length > 0
      ? `  VALUES ?region { ${regionIris.map((u) => `<${u}>`).join(" ")} }\n  ?s ogc:sfIntersects ?region .\n`
      : "";
  const enSelect = preferEnglishName ? " ?name_en" : "";
  const enOptional = preferEnglishName ? `  OPTIONAL { ?s ${OSM_NAME_EN_IRI} ?name_en . }\n` : "";

  return `PREFIX osmkey: <${OSM_KEY_PREFIX}>
PREFIX osm: <https://www.openstreetmap.org/>
PREFIX geo: <http://www.opengis.net/ont/geosparql#>
PREFIX geof: <http://www.opengis.net/def/function/geosparql/>
PREFIX ogc: <http://www.opengis.net/rdf#>
SELECT DISTINCT ?s ?name${enSelect} ?ref ?wkt WHERE {
${regionClause}  ?s a osm:way .
${tagPatterns}
  ?s geo:hasGeometry/geo:asWKT ?wkt .
  OPTIONAL { ?s osmkey:name ?name . }
  OPTIONAL { ?s osmkey:ref ?ref . }
${enOptional}  FILTER(geof:sfIntersects(?wkt, "${box}"^^geo:wktLiteral))
}`;
}

export async function fetchLineLayerFromQlever({
  layerName,
  osmFilter,
  playArea,
  playAreaOsmRelationId,
  bufferKm = 0,
  toleranceMeters = 15,
  groupByName = true,
  preferEnglishName = false,
  signal,
  onStatus,
}: {
  layerName: string;
  osmFilter: string;
  playArea: PlayAreaFeatureCollection;
  playAreaOsmRelationId?: number | null;
  bufferKm?: number;
  toleranceMeters?: number;
  groupByName?: boolean;
  preferEnglishName?: boolean;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}): Promise<LineFetchResult> {
  const mask = buildPlayAreaMask(playArea, Math.max(bufferKm, MIN_LINE_CROP_BUFFER_KM));
  const bounds = maskQueryBounds(mask);
  const useDirectRelation =
    Boolean(playAreaOsmRelationId) &&
    bufferKm <= 0 &&
    !missingDirectRelationIds.has(playAreaOsmRelationId!);

  const runWithRegions = async (regionIris: readonly string[]) => {
    if (regionIris.length === 0) {
      throw new Error(
        "No enclosing OSM boundary found in QLever for this area. Switch to Overpass or expand the play area.",
      );
    }
    const query = buildQleverLineQuery({ osmFilter, bounds, regionIris, preferEnglishName });
    if (!query) {
      throw new Error(`Unsupported OSM filter for QLever: ${osmFilter}`);
    }
    onStatus?.(`Querying QLever for ${layerName}…`);
    return runQleverQuery(query, { signal, timeoutMs: 30_000 });
  };

  let rows: Array<Record<string, SparqlBindingValue | undefined>>;
  if (useDirectRelation) {
    const directIris = [`https://www.openstreetmap.org/relation/${playAreaOsmRelationId}`];
    rows = await runWithRegions(directIris);
    if (rows.length === 0) {
      const fallbackIris = await resolveQleverCoveringRegions(bounds, { signal, onStatus });
      if (fallbackIris.length > 0 && !fallbackIris.includes(directIris[0])) {
        const fallbackRows = await runWithRegions(fallbackIris);
        if (fallbackRows.length > 0) {
          missingDirectRelationIds.add(playAreaOsmRelationId!);
          rows = fallbackRows;
        }
      }
    }
  } else {
    const regionIris = await resolveQleverCoveringRegions(bounds, { signal, onStatus });
    rows = await runWithRegions(regionIris);
  }

  onStatus?.("Cropping and simplifying line features…");
  const seenIds = new Set<string>();
  const rawSegments: Array<{ id: string; name: string; lines: Position[][] }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const wkt = row.wkt?.value;
    if (!wkt) continue;
    const osmId = osmIdFromUri(row.s?.value, i);
    if (seenIds.has(osmId)) continue;

    const geom = parseWktGeometry(wkt);
    if (!geom || (geom.type !== "LineString" && geom.type !== "MultiLineString")) continue;

    const cropped = cropLineToPlayAreaMask(geom, mask);
    if (!cropped) continue;

    seenIds.add(osmId);
    const label = pickBindingName(row, preferEnglishName) || row.ref?.value?.trim() || layerName;
    const lines = cropped.type === "LineString" ? [cropped.coordinates] : cropped.coordinates;
    rawSegments.push({ id: osmId, name: label, lines });
  }

  let items: CreatorGeoFeatureItem[];
  if (groupByName) {
    const grouped = new Map<string, Position[][]>();
    for (const seg of rawSegments) {
      const existing = grouped.get(seg.name);
      if (existing) existing.push(...seg.lines);
      else grouped.set(seg.name, [...seg.lines]);
    }
    items = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, lines], idx) => ({
        uid: `osm-line-${idx}-${name}`,
        name,
        geometry:
          lines.length === 1
            ? ({ type: "LineString", coordinates: lines[0] } satisfies LineStringGeometry)
            : ({ type: "MultiLineString", coordinates: lines } satisfies MultiLineStringGeometry),
        enabled: true,
      }));
  } else {
    items = rawSegments.map((seg) => ({
      uid: `osm-way-${seg.id}`,
      name: seg.name,
      geometry:
        seg.lines.length === 1
          ? ({ type: "LineString", coordinates: seg.lines[0] } satisfies LineStringGeometry)
          : ({ type: "MultiLineString", coordinates: seg.lines } satisfies MultiLineStringGeometry),
      enabled: true,
    }));
  }

  const simplified = simplifyLineLayerTopology(items, toleranceMeters);
  const finalItems: CreatorGeoFeatureItem[] = [];
  for (const item of simplified.items) {
    if (
      toleranceMeters > 0 &&
      (item.geometry.type === "LineString" || item.geometry.type === "MultiLineString")
    ) {
      const reclipped = cropLineToPlayAreaMask(item.geometry, mask);
      if (!reclipped) continue;
      finalItems.push({ ...item, geometry: reclipped });
    } else {
      finalItems.push(item);
    }
  }
  const vertexCount = finalItems.reduce(
    (sum, item) => sum + countGeometryVertices(item.geometry),
    0,
  );
  return {
    items: finalItems,
    vertexCount,
    endpoint: QLEVER_OSM_ENDPOINT,
  };
}
