// Helpers for building a Searchlight game definition (*.game.json).
//
// Node 18+, ESM. GeoJSON and CSV need nothing else. KML additionally needs:
//   npm i @tmcw/togeojson@7.1.2 @xmldom/xmldom@0.9.12
// KMZ is a zip: unzip it and read the doc.kml inside.
//
// Typical use (see create-game.md, section 6):
//   import * as gt from "./game-tools.mjs";
//   const folders = await gt.readKmlFolders("map.kml");
//   const zones = gt.withIds(gt.normalize(folders.get("Stations"), { keep: ["name", "tier"] }));

import { readFileSync } from "node:fs";

/** Same slug rule Searchlight uses for game IDs and question IDs. */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Reading sources ──────────────────────────────────────────────────────────

/** Features of a GeoJSON file (FeatureCollection, Feature, or bare geometry). */
export function readGeoJson(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json.type === "FeatureCollection") return json.features;
  if (json.type === "Feature") return [json];
  return [{ type: "Feature", geometry: json, properties: {} }];
}

/**
 * KML placemarks grouped by top-level folder name (Google My Maps layers).
 * Placemarks in nested folders belong to their top-level folder; placemarks
 * outside any folder are under "(root)". ExtendedData values become properties.
 */
export async function readKmlFolders(path) {
  const { kmlWithFolders } = await import("@tmcw/togeojson");
  const { DOMParser } = await import("@xmldom/xmldom");
  const doc = new DOMParser().parseFromString(readFileSync(path, "utf8"), "text/xml");
  const folders = new Map();
  const add = (key, feature) => {
    if (!folders.has(key)) folders.set(key, []);
    folders.get(key).push(feature);
  };
  const walk = (node, key) => {
    for (const child of node.children ?? []) {
      if (child.type === "folder") walk(child, key ?? child.meta?.name ?? "(unnamed)");
      else add(key ?? "(root)", child);
    }
  };
  walk(kmlWithFolders(doc), undefined);
  return folders;
}

/**
 * Point features from a CSV with a header row. Recognised coordinate columns:
 * lat/latitude and lng/lon/long/longitude. Every other column is a property.
 * Rows whose lat or lng is blank or not a number are skipped (and counted on
 * stderr) rather than placed at [0, 0].
 */
export function readCsv(path) {
  const rows = parseCsv(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  const header = rows.shift().map((h) => h.trim());
  const find = (...names) => header.findIndex((h) => names.includes(h.toLowerCase()));
  const latCol = find("lat", "latitude");
  const lngCol = find("lng", "lon", "long", "longitude");
  if (latCol < 0 || lngCol < 0) throw new Error(`${path}: needs lat and lng/lon columns`);
  const coordinate = (cell) => (cell?.trim() ? Number(cell) : NaN); // Number("") is 0
  const features = [];
  let skipped = 0;
  for (const row of rows) {
    if (!row.some((cell) => cell.trim() !== "")) continue;
    const lng = coordinate(row[lngCol]);
    const lat = coordinate(row[latCol]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      skipped++;
      continue;
    }
    const properties = {};
    header.forEach((h, i) => {
      if (i !== latCol && i !== lngCol && row[i] !== undefined && row[i] !== "") {
        properties[h] = row[i].trim();
      }
    });
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties });
  }
  if (skipped) console.warn(`${path}: skipped ${skipped} row(s) without a numeric lat and lng`);
  return features;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') cell += text[++i];
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (row.push(cell), (cell = ""));
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell !== "" || row.length) row.push(cell), rows.push(row);
  return rows;
}

/**
 * OpenStreetMap tags for the rulebook POI categories, matching what Searchlight
 * queried before games carried their own data.
 */
export const OSM_TAGS = {
  airport: '["aeroway"="aerodrome"]["iata"]', // IATA code = commercial airport
  aquarium: '["tourism"="aquarium"]',
  cinema: '["amenity"="cinema"]',
  consulate: '["diplomatic"="consulate"]',
  golf_course: '["leisure"="golf_course"]',
  hospital: '["amenity"="hospital"]',
  library: '["amenity"="library"]',
  mountain: '["natural"="peak"]',
  museum: '["tourism"="museum"]',
  park: '["leisure"="park"]',
  theme_park: '["tourism"="theme_park"]',
  zoo: '["tourism"="zoo"]',
};

/**
 * Named OSM objects matching `filter` (e.g. OSM_TAGS.museum) inside
 * [west, south, east, north], as Point features (ways and relations use their
 * centre). Unnamed objects are skipped. Run normalize() and dedupePoints() after.
 * The public endpoint is shared: run queries one at a time. Busy responses
 * (429/504) are retried after 15 s and 45 s.
 */
export async function overpassPoints(filter, [w, s, e, n], endpoint = "https://overpass-api.de/api/interpreter") {
  const query = `[out:json][timeout:180];nwr${filter}(${s},${w},${n},${e});out center tags;`;
  let res;
  for (const wait of [0, 15, 45]) {
    if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "searchlight-game-builder" },
      body: new URLSearchParams({ data: query }),
    });
    if (res.status !== 429 && res.status !== 504) break;
  }
  if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { elements } = await res.json();
  return elements.flatMap((el) => {
    const name = el.tags?.["name:en"] ?? el.tags?.name;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat === undefined || lon === undefined) return [];
    return [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { name } }];
  });
}

// ── Normalizing geometry ─────────────────────────────────────────────────────

// 6 decimal places is ~0.1 m. Use fixed decimals, never significant digits:
// "%g"-style formatting leaves 4 decimals (~11 m) at latitudes above 10°.
const round = (n) => Math.round(n * 1e6) / 1e6;

function position(c) {
  const p = [round(Number(c[0])), round(Number(c[1]))]; // drops altitude
  return Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
    Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 ? p : null;
}

function path(coords) {
  const out = [];
  for (const c of coords ?? []) {
    const p = position(c);
    const last = out[out.length - 1];
    if (p && !(last && last[0] === p[0] && last[1] === p[1])) out.push(p);
  }
  return out;
}

function ring(coords) {
  const r = path(coords);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) {
    r.push([...r[0]]);
  }
  return r.length >= 4 ? r : null;
}

// Rings of one polygon; null when the outer ring is unusable. Bad holes are dropped.
function polygon(rings) {
  const outer = ring(rings?.[0]);
  return outer ? [outer, ...(rings.slice(1).map(ring).filter(Boolean))] : null;
}

function line(coords) {
  const l = path(coords);
  return l.length >= 2 ? l : null;
}

// Schema-valid geometries for any GeoJSON geometry. MultiPoint and point parts
// of a GeometryCollection become separate Points; line and polygon parts of a
// GeometryCollection merge into one MultiLineString / MultiPolygon.
function geometries(geom) {
  if (!geom) return [];
  switch (geom.type) {
    case "Point": {
      const p = position(geom.coordinates ?? []);
      return p ? [{ type: "Point", coordinates: p }] : [];
    }
    case "MultiPoint":
      return geom.coordinates.flatMap((c) => geometries({ type: "Point", coordinates: c }));
    case "LineString": {
      const l = line(geom.coordinates);
      return l ? [{ type: "LineString", coordinates: l }] : [];
    }
    case "MultiLineString":
      return lines(geom.coordinates.map(line).filter(Boolean));
    case "Polygon": {
      const p = polygon(geom.coordinates);
      return p ? [{ type: "Polygon", coordinates: p }] : [];
    }
    case "MultiPolygon":
      return polygons(geom.coordinates.map(polygon).filter(Boolean));
    case "GeometryCollection": {
      const parts = geom.geometries.flatMap(geometries);
      const points = parts.filter((g) => g.type === "Point");
      const lineParts = parts.flatMap((g) =>
        g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : []);
      const polyParts = parts.flatMap((g) =>
        g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);
      return [...points, ...lines(lineParts), ...polygons(polyParts)];
    }
    default:
      return [];
  }
}

const lines = (parts) =>
  parts.length === 0 ? [] : parts.length === 1
    ? [{ type: "LineString", coordinates: parts[0] }]
    : [{ type: "MultiLineString", coordinates: parts }];

const polygons = (parts) =>
  parts.length === 0 ? [] : parts.length === 1
    ? [{ type: "Polygon", coordinates: parts[0] }]
    : [{ type: "MultiPolygon", coordinates: parts }];

// Fails loudly on a missing input, e.g. kml.get("Stations") for a folder
// that is really called "Stations 2026", instead of building an empty layer.
function requireFeatures(features, fn) {
  if (!Array.isArray(features)) {
    throw new Error(`${fn}: expected an array of features, got ${features === null ? "null" : typeof features} (a mistyped KML folder name? Map.get() returns undefined for unknown names)`);
  }
  return features;
}

/**
 * Schema-valid copies of `features`: 2D positions rounded to 6 decimals, rings
 * closed, degenerate parts dropped, MultiPoint split, GeometryCollections
 * merged per geometry family. Properties are reduced to the `keep` keys, which
 * also drops the bulky descriptions and styles KML and OSM exports carry. A
 * numeric-looking `radius` (KML ExtendedData values are strings, e.g. "600")
 * becomes a number, since the app ignores string radii. Features with no
 * usable geometry are dropped. Throws if `features` isn't an array.
 *
 * A GeometryCollection mixing families (a KML placemark with both a pin and
 * a shape) comes out as one feature per family, so filter the result by
 * `f.geometry.type` before putting it in a layer: a layer holds one family.
 */
export function normalize(features, { keep = ["name"] } = {}) {
  const out = [];
  for (const f of requireFeatures(features, "normalize")) {
    const properties = {};
    for (const key of keep) {
      let value = f.properties?.[key];
      if (typeof value === "string") value = value.trim();
      if (key === "radius" && typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
        value = Number(value);
      }
      if (value !== undefined && value !== null && value !== "") properties[key] = value;
    }
    for (const geometry of geometries(f.geometry)) {
      out.push({ type: "Feature", geometry, properties: { ...properties } });
    }
  }
  return out;
}

/** Drops Points whose coordinates repeat an earlier Point (keeps the first). */
export function dedupePoints(features) {
  const seen = new Set();
  return features.filter((f) => {
    if (f.geometry.type !== "Point") return true;
    const key = f.geometry.coordinates.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Assigns unique, stable string IDs from properties.name (slugged), suffixing
 * repeats with -2, -3, ... Features without a name get `${fallback}-N`.
 */
export function withIds(features, fallback = "feature") {
  const used = new Set();
  return features.map((f, i) => {
    const base = slug(f.properties?.name ?? "") || `${fallback}-${i + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { ...f, id };
  });
}

// ── Assembling ───────────────────────────────────────────────────────────────

export const collection = (features) => ({ type: "FeatureCollection", features });

const family = (f) => f.geometry.type === "Point" ? "points" : f.geometry.type.includes("Line") ? "lines" : "polygons";

/**
 * One question layer. enabledFor: any of "matching", "measuring", "tentacle".
 * Throws if the features mix geometry families, which the import rejects.
 */
export function layer(name, enabledFor, features) {
  const families = new Set(requireFeatures(features, `layer("${name}")`).map(family));
  if (families.size > 1) {
    throw new Error(`layer("${name}"): mixes ${[...families].join(" and ")}; a layer holds one geometry family, so filter the features by geometry.type`);
  }
  return { name, enabledFor, data: collection(features) };
}

/** [west, south, east, north] of the features. Throws if there are none. */
export function bbox(features) {
  if (!requireFeatures(features, "bbox").length) throw new Error("bbox: no features to measure");
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c) => {
    if (typeof c[0] === "number") {
      b[0] = Math.min(b[0], c[0]);
      b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]);
      b[3] = Math.max(b[3], c[1]);
    } else c.forEach(visit);
  };
  for (const f of features) visit(f.geometry.coordinates);
  return b.map(round);
}

/** Centre [lng, lat] of a bbox. */
export const center = ([w, s, e, n]) => [round((w + e) / 2), round((s + n) / 2)];
