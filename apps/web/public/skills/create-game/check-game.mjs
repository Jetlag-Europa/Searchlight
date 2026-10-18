// Checks a Searchlight game definition before import. Node 18+, no dependencies.
//
//   node check-game.mjs my-game.game.json
//   node check-game.mjs --strict my-game.game.json
//
// ERROR  the import will reject the file (mirrors the server's validator).
// WARN   the file imports, but players will hit a problem the validator
//        doesn't catch (degenerate questions, zones outside the play area, ...).
// NOTE   worth a look, often intentional (file size, regions not covering zones).
// It finishes by listing the questions the game will offer, with their labels.
// Exit code 1 when there are errors. --strict also fails (FAIL instead of WARN)
// on the warnings in STRICT_CODES, which are always data defects: misplaced or
// swapped coordinates, duplicate IDs, undecoded names, single-feature matching
// and region layers no zone lies in. Searchlight's preloaded games must pass it.
//
// It can also be imported: checkGame(definition, { fileSize }) returns
// { errors, warnings, notes, questions }, each issue being { path, message, code }.
// Browsers import it too (Searchlight's import dialog and /designer page), so
// it loads node: modules only in Node (at the end). No shebang line either:
// Vite's dev server prepends imports to the file, which would break one.

/** WARN codes that --strict treats as failures. */
export const STRICT_CODES = new Set([
  "center-outside-play-area",
  "zones-outside-play-area",
  "layer-coordinates-swapped",
  "duplicate-zone-id",
  "duplicate-feature-id",
  "escaped-name",
  "single-feature-matching",
  "zones-outside-all-regions",
]);

const slug = (s) => String(s).toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const UNITS = ["meters", "kilometers", "miles"];
// Names copied out of KML/XML/HTML without decoding them.
const ESCAPED_NAME = /<!\[CDATA\[|\]\]>|&(amp|lt|gt|quot|apos|#\d+);/;
// Heuristic: the last word ends in a plain "s" (Districts, Museums), but not
// "ss", "us" or "is" (Glass, Campus, Paris).
const looksPlural = (name) => /^[a-z]+[^\W\d_isu]s$/i.test(name.trim().split(/\s+/).pop() ?? "");

/** The label the app gives a layer's question of `kind` (see compile.ts). */
export function questionLabel(name, kind, family) {
  if (kind === "matching") {
    return family === "polygons"
      ? (/^same\b/i.test(name) ? name : `Same ${name}`)
      : (/^nearest\b/i.test(name) ? name : `Nearest ${name}`);
  }
  if (kind === "measuring") {
    return family === "polygons" && !/boundary|border/i.test(name) ? `Distance to ${name} Boundary` : `Distance to ${name}`;
  }
  return /^tentacles?\b/i.test(name) ? name : `Tentacles: ${name}`;
}

/**
 * Checks a parsed game definition. `fileSize` (bytes) enables the file size
 * warning. Returns { errors, warnings, notes, questions }: issues are
 * { path, message, code }, and questions lists what the game offers as
 * { kind, label, id }.
 */
export function checkGame(def, { fileSize } = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message, code) => warnings.push({ path, message, code });
  const note = (path, message, code) => notes.push({ path, message, code });

  // ── Structure (what the server validator rejects) ──────────────────────────

  const ROOT_KEYS = ["$schema", "id", "revision", "name", "serverId", "size", "visibility",
    "unit", "map", "hidingZones", "radars", "thermometer", "features"];
  for (const key of Object.keys(def)) {
    if (!ROOT_KEYS.includes(key)) err(`/${key}`, "unknown root property");
  }
  if (typeof def.name !== "string" || !def.name || def.name.length > 120) {
    err("/name", "required string, 1-120 characters");
  }
  if (typeof def.serverId !== "string" || !def.serverId) err("/serverId", "required string");
  if (def.id !== undefined && (typeof def.id !== "string" || !def.id)) err("/id", "must be a non-empty string");
  if ((def.id ?? slug(def.name ?? "")).length < 2) err("/id", "id (or slug of name) must be at least 2 characters");
  if (def.revision !== undefined && !(Number.isInteger(def.revision) && def.revision >= 1)) {
    err("/revision", "must be an integer >= 1 (or leave it out)");
  }
  if (def.size !== undefined && !["small", "medium", "large"].includes(def.size)) err("/size", "small | medium | large");
  if (def.unit !== undefined && !UNITS.includes(def.unit)) err("/unit", UNITS.join(" | "));
  if (def.visibility !== undefined) {
    const v = def.visibility;
    if (!isObj(v) || !(v.kind === "server-members" ||
        (v.kind === "discord-role" && typeof v.guildId === "string" && v.guildId &&
         typeof v.roleId === "string" && v.roleId))) {
      err("/visibility", '{"kind":"server-members"} or {"kind":"discord-role","guildId":"...","roleId":"..."}');
    }
  }
  if (def.thermometer !== undefined && typeof def.thermometer !== "boolean") err("/thermometer", "must be boolean");
  if (def.radars !== undefined && typeof def.radars !== "boolean" &&
      !(Array.isArray(def.radars) && def.radars.length && def.radars.every((r) => typeof r === "number" && r > 0))) {
    err("/radars", "boolean or non-empty array of positive numbers");
  }

  function checkPosition(p, path) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "number" || typeof p[1] !== "number") {
      err(path, "position must be exactly [lng, lat] (no altitude)");
      return false;
    }
    if (Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
      err(path, `[${p}] out of range; positions are [lng, lat]`);
      return false;
    }
    return true;
  }
  function checkRings(rings, path) {
    if (!Array.isArray(rings) || rings.length === 0) return err(path, "polygon needs at least one ring");
    rings.forEach((r, i) => {
      if (!Array.isArray(r) || r.length < 4) return err(`${path}/${i}`, "ring needs at least 4 positions");
      if (!r.every((p, j) => checkPosition(p, `${path}/${i}/${j}`))) return;
      const a = r[0], b = r[r.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) err(`${path}/${i}`, "ring not closed (first position must equal last)");
    });
  }
  function checkLine(coords, path) {
    if (!Array.isArray(coords) || coords.length < 2) return err(path, "line needs at least 2 positions");
    coords.forEach((p, j) => checkPosition(p, `${path}/${j}`));
  }
  function checkGeometry(g, allowed, path) {
    if (!isObj(g) || !allowed.includes(g.type)) {
      const extra = g?.type === "MultiPoint" ? " (split MultiPoint into separate Points)"
        : g?.type === "GeometryCollection" ? " (merge parts into Multi* or split into features)" : "";
      return err(path, `geometry must be one of ${allowed.join(", ")}; got ${g?.type}${extra}`);
    }
    const c = g.coordinates;
    if (g.type === "Point") checkPosition(c, `${path}/coordinates`);
    else if (g.type === "LineString") checkLine(c, `${path}/coordinates`);
    else if (g.type === "MultiLineString") {
      if (!Array.isArray(c) || !c.length) err(`${path}/coordinates`, "needs at least one line");
      else c.forEach((l, i) => checkLine(l, `${path}/coordinates/${i}`));
    } else if (g.type === "Polygon") checkRings(c, `${path}/coordinates`);
    else if (g.type === "MultiPolygon") {
      if (!Array.isArray(c) || !c.length) err(`${path}/coordinates`, "needs at least one polygon");
      else c.forEach((rings, i) => checkRings(rings, `${path}/coordinates/${i}`));
    }
  }
  function checkCollection(fc, allowed, path) {
    if (!isObj(fc) || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) {
      err(path, "must be a GeoJSON FeatureCollection (not a bare Feature or geometry)");
      return [];
    }
    fc.features.forEach((f, i) => {
      const p = `${path}/features/${i}`;
      if (!isObj(f) || f.type !== "Feature") return err(p, 'must be {"type":"Feature",...}');
      if (f.id !== undefined && typeof f.id !== "string" && typeof f.id !== "number") err(`${p}/id`, "string or number");
      if (f.properties !== undefined && f.properties !== null && !isObj(f.properties)) err(`${p}/properties`, "object or null");
      checkGeometry(f.geometry, allowed, `${p}/geometry`);
    });
    return fc.features.filter((f) => isObj(f?.geometry) && allowed.includes(f.geometry.type));
  }

  if (!isObj(def.map)) err("/map", "required object");
  const center = def.map?.center;
  checkPosition(center, "/map/center");
  const bounds = def.map?.bounds;
  if (bounds !== undefined) {
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((n) => typeof n === "number")) {
      err("/map/bounds", "[west, south, east, north]");
    } else {
      if (bounds.some((n, i) => Math.abs(n) > (i % 2 ? 90 : 180))) {
        err("/map/bounds", `[${bounds}] out of range; bounds are [west, south, east, north] in degrees`);
      }
      if (bounds[0] > bounds[2]) err("/map/bounds", "west > east");
      if (bounds[1] > bounds[3]) err("/map/bounds", "south > north");
    }
  }
  const playArea = checkCollection(def.map?.playArea, ["Polygon", "MultiPolygon"], "/map/playArea");
  if (!isObj(def.hidingZones)) err("/hidingZones", "required object");
  const hz = def.hidingZones ?? {};
  if (hz.radius !== undefined && !(typeof hz.radius === "number" && hz.radius > 0)) err("/hidingZones/radius", "positive number");
  if (hz.unit !== undefined && !UNITS.includes(hz.unit)) err("/hidingZones/unit", UNITS.join(" | "));
  for (const [tier, r] of Object.entries(hz.tierOverrides ?? {})) {
    if (!tier || !(typeof r === "number" && r > 0)) err(`/hidingZones/tierOverrides/${tier}`, "positive number");
  }
  const zones = checkCollection(hz.features, ["Point", "Polygon", "MultiPolygon"], "/hidingZones/features");

  const LAYER_KEYS = ["name", "enabledFor", "data"];
  const KINDS = ["matching", "measuring", "tentacle"];
  const layers = Array.isArray(def.features) ? def.features : [];
  if (def.features !== undefined && !Array.isArray(def.features)) err("/features", "must be an array");
  const questionIds = new Map();
  const layerNames = new Set();
  const layerSlugs = new Map();
  const layerInfo = layers.map((layer, i) => {
    const p = `/features/${i}`;
    for (const key of Object.keys(layer ?? {})) {
      if (!LAYER_KEYS.includes(key)) err(`${p}/${key}`, "unknown layer property (layers take only name, enabledFor, data)");
    }
    const name = typeof layer?.name === "string" ? layer.name : "";
    if (!name) err(`${p}/name`, "required non-empty string");
    else if (layerNames.has(name)) err(`${p}/name`, `duplicate layer name "${name}"; every layer needs its own name`);
    layerNames.add(name);
    const kinds = Array.isArray(layer?.enabledFor) ? layer.enabledFor : [];
    if (!kinds.length || !kinds.every((k) => KINDS.includes(k))) {
      err(`${p}/enabledFor`, `non-empty array of ${KINDS.join(", ")}`);
    }
    if (layer?.data === undefined) err(`${p}/data`, "missing: layers must embed a GeoJSON FeatureCollection");
    const feats = layer?.data === undefined ? []
      : checkCollection(layer.data, ["Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"], `${p}/data`);
    const families = new Set(feats.map((f) =>
      f.geometry.type === "Point" ? "points" : f.geometry.type.includes("Line") ? "lines" : "polygons"));
    if (families.size > 1) err(`${p}/data`, `mixes ${[...families].join(" and ")}; one geometry family per layer`);
    const family = [...families][0] ?? "points";
    if (kinds.includes("tentacle") && feats.length && !families.has("points")) {
      err(`${p}/enabledFor`, "tentacle needs a Point layer");
    }
    const s = slug(name);
    if (name && !s) err(`${p}/name`, `"${name}" has no letters or digits to build a question ID from`);
    for (const kind of kinds) {
      const qid = `${kind}-${s}`;
      if (s && questionIds.has(qid)) err(`${p}/name`, `question ID "${qid}" collides with layer "${questionIds.get(qid)}"`);
      questionIds.set(qid, name);
    }
    if (s && layerSlugs.has(s) && layerSlugs.get(s) !== name) {
      warn(`${p}/name`, `"${name}" and "${layerSlugs.get(s)}" share the slug "${s}", so a question kind enabled on both gets the same ID; give each layer a distinct name`, "shared-slug");
    }
    if (s && !layerSlugs.has(s)) layerSlugs.set(s, name);
    return { name, kinds, feats, family, path: p };
  });

  // ── Quality (imports fine, plays badly) ────────────────────────────────────

  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inPolygon = (pt, rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h));
  function contains(geom, pt) {
    try {
      if (geom.type === "Polygon") return inPolygon(pt, geom.coordinates);
      if (geom.type === "MultiPolygon") return geom.coordinates.some((rings) => inPolygon(pt, rings));
    } catch { /* malformed geometry is already an error */ }
    return false;
  }
  const inPlayArea = (pt) => playArea.some((f) => contains(f.geometry, pt));
  const countPositions = (c) => (typeof c?.[0] === "number" ? 1 : Array.isArray(c) ? c.reduce((n, x) => n + countPositions(x), 0) : 0);
  function bboxOf(c, b = [Infinity, Infinity, -Infinity, -Infinity]) {
    if (typeof c?.[0] === "number") {
      b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]);
      b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]);
    } else if (Array.isArray(c)) c.forEach((x) => bboxOf(x, b));
    return b;
  }
  const swap = (c) => (typeof c?.[0] === "number" ? [c[1], c[0]] : c.map(swap));
  const tooPrecise = (c) => (typeof c?.[0] === "number"
    ? c.some((n) => String(n).split(".")[1]?.length > 6)
    : Array.isArray(c) && c.some(tooPrecise));
  const pointOf = (f) => f.geometry.type === "Point" ? f.geometry.coordinates : null;
  const escapedNames = (feats) => feats.map((f) => f.properties?.name)
    .filter((n) => typeof n === "string" && ESCAPED_NAME.test(n));
  const escapedHint = (names) => `${names.length} name(s) contain CDATA wrappers or XML/HTML entities (${names.slice(0, 3).map((n) => JSON.stringify(n)).join(", ")}${names.length > 3 ? ", ..." : ""}); decode them`;

  if (errors.length === 0) {
    if (ESCAPED_NAME.test(def.name)) warn("/name", `${JSON.stringify(def.name)} contains a CDATA wrapper or XML/HTML entity; decode it`, "escaped-name");
    if (def.unit !== undefined && def.unit !== (hz.unit ?? "meters")) {
      warn("/unit", `root unit "${def.unit}" overrides hidingZones.unit "${hz.unit ?? "meters"}": radius ${hz.radius ?? 400} is read as ${hz.radius ?? 400} ${def.unit}. Set only hidingZones.unit`, "root-unit");
    }
    if (def.radars === undefined) note("/radars", "omitted: the game has no radar questions (a game offers only what it declares)", "no-radars");
    if (def.thermometer === undefined) note("/thermometer", "omitted: the game has no thermometer questions", "no-thermometer");
    if (!playArea.length) warn("/map/playArea", "has no features: nothing is playable", "empty-play-area");
    const areaBox = playArea.length ? bboxOf(playArea.map((f) => f.geometry.coordinates)) : null;
    const outsideBox = (p, b) => p[0] < b[0] || p[0] > b[2] || p[1] < b[1] || p[1] > b[3];
    if (areaBox && Array.isArray(center) && outsideBox(center, areaBox)) {
      warn("/map/center", `[${center}] lies outside the play area's bbox [${areaBox}]; use the play area's centre`, "center-outside-play-area");
    }
    if (areaBox && bounds?.length === 4 && (bounds[2] - bounds[0] > 3 * (areaBox[2] - areaBox[0]) + 1 ||
        bounds[3] - bounds[1] > 3 * (areaBox[3] - areaBox[1]) + 1)) {
      warn("/map/bounds", `[${bounds}] is far larger than the play area's bbox [${areaBox}]; use that bbox plus a small margin`, "bounds-too-large");
    }

    // Hiding zones
    if (!zones.length) warn("/hidingZones/features", "no hiding zones", "no-zones");
    const polyZones = zones.filter((f) => f.geometry.type !== "Point");
    if (polyZones.length) {
      warn("/hidingZones/features", `${polyZones.length} Polygon/MultiPolygon zone(s): the app uses each as its own area (no radius or tier applies), and these checks can't tell whether they lie inside the play area`, "polygon-zones");
    }
    const pointZones = zones.filter(pointOf);
    const zoneIds = new Map();
    const tiers = hz.tierOverrides ?? {};
    const usedTiers = new Set();
    const outside = [];
    zones.forEach((f, i) => {
      const p = `/hidingZones/features/features/${i}`;
      const name = f.properties?.name;
      if (typeof name !== "string" || !name.trim()) warn(p, "no properties.name; the zone list will show a generic name", "unnamed-zone");
      const id = f.id ?? name;
      if (id === undefined) warn(p, "no id and no name; give every zone a unique id", "missing-zone-id");
      else if (zoneIds.has(String(id))) warn(p, `zone id "${id}" repeats ${zoneIds.get(String(id))}; zone ids must be unique`, "duplicate-zone-id");
      else zoneIds.set(String(id), p);
      const tier = f.properties?.tier;
      if (tier !== undefined && tier !== null) {
        if (typeof tier !== "string") {
          warn(`${p}/properties/tier`, `tier ${JSON.stringify(tier)} is a ${typeof tier}; tiers must be strings, like the tierOverrides keys`, "tier-not-string");
        }
        usedTiers.add(String(tier));
      }
      const r = f.properties?.radius;
      const validRadius = (typeof r === "number" && r > 0) ||
        (isObj(r) && typeof r.value === "number" && r.value > 0 && UNITS.includes(r.unit));
      if (r !== undefined && !validRadius) {
        warn(`${p}/properties/radius`, `per-zone radius must be a positive number in the game unit, or {"value": n, "unit": "${UNITS.join("|")}"}; the zone gets the base radius`, "invalid-zone-radius");
      }
      const pt = pointOf(f);
      if (pt && playArea.length && !inPlayArea(pt)) outside.push(name ?? id ?? i);
    });
    const escapedZones = escapedNames(zones);
    if (escapedZones.length) warn("/hidingZones/features", escapedHint(escapedZones), "escaped-name");
    for (const tier of Object.keys(tiers)) {
      if (usedTiers.has(tier)) continue;
      const near = [...usedTiers].find((t) => t.toLowerCase() === tier.toLowerCase());
      warn(`/hidingZones/tierOverrides/${tier}`, near !== undefined
        ? `no zone has tier "${tier}", but zones use "${near}"; tiers are case-sensitive, so those zones get the base radius`
        : "no zone has this tier", "unused-tier");
    }
    if (outside.length) {
      let hint = "";
      if (outside.length === pointZones.length) {
        const swappedArea = playArea.map((f) => ({ ...f.geometry, coordinates: swap(f.geometry.coordinates) }));
        const pts = pointZones.map(pointOf);
        if (pts.some((pt) => swappedArea.some((g) => contains(g, pt)))) hint = " (the play area's coordinates look swapped: [lat, lng] instead of [lng, lat])";
        else if (pts.some((pt) => inPlayArea([pt[1], pt[0]]))) hint = " (the zones' coordinates look swapped: [lat, lng] instead of [lng, lat])";
      }
      warn("/hidingZones/features", `${outside.length} zone(s) outside the play area${hint}: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`, "zones-outside-play-area");
    }

    // Layers
    for (const { name, kinds, feats, family, path } of layerInfo) {
      const label = `${path} "${name}"`;
      if (ESCAPED_NAME.test(name)) warn(label, "layer name contains a CDATA wrapper or XML/HTML entity; decode it", "escaped-name");
      if (looksPlural(name)) {
        note(label, `looks plural, and players see "${questionLabel(name, kinds[0], family)}"; name layers in the singular`, "plural-layer-name");
      }
      if (!feats.length) {
        warn(label, "empty layer; its questions will do nothing", "empty-layer");
        continue;
      }
      const unnamed = feats.filter((f) => typeof f.properties?.name !== "string" || !f.properties.name.trim()).length;
      if (unnamed) {
        (kinds.includes("matching") || kinds.includes("tentacle") ? warn : note)(label, `${unnamed} feature(s) without properties.name; players see the layer name instead`, "unnamed-features");
      }
      const escaped = escapedNames(feats);
      if (escaped.length) warn(label, escapedHint(escaped), "escaped-name");
      const ids = new Set();
      const repeatedIds = new Set();
      for (const f of feats) {
        if (f.id === undefined) continue;
        if (ids.has(String(f.id))) repeatedIds.add(String(f.id));
        ids.add(String(f.id));
      }
      if (repeatedIds.size) {
        const shown = [...repeatedIds].slice(0, 5).map((id) => `"${id}"`).join(", ");
        warn(label, `${repeatedIds.size} feature id(s) repeat within the layer (${shown}${repeatedIds.size > 5 ? ", ..." : ""}); feature ids must be unique per layer`, "duplicate-feature-id");
      }
      const positions = countPositions(feats.map((f) => f.geometry.coordinates));
      if (family !== "points" && positions > 20000) {
        warn(label, `${positions} vertices; simplify (~10 m tolerance) to keep measuring and matching responsive`, "heavy-geometry");
      }
      if (kinds.includes("matching") && feats.length < 2) {
        warn(label, "matching on a single feature always answers the same way; enable measuring only", "single-feature-matching");
      }
      if (kinds.includes("tentacle") && family === "points" && feats.length < 2) {
        warn(label, "tentacles on a single site only reveal whether the hider is within the radius of it; enable measuring only", "single-feature-tentacle");
      }
      if (family === "points") {
        const seen = new Set();
        let dup = 0;
        for (const f of feats) {
          const k = f.geometry.coordinates.join(",");
          if (seen.has(k)) dup++;
          seen.add(k);
        }
        if (dup) warn(label, `${dup} point(s) repeat another point's coordinates; dedupe them`, "duplicate-points");
        if (playArea.length && !feats.some((f) => inPlayArea(f.geometry.coordinates)) &&
            feats.some((f) => inPlayArea(swap(f.geometry.coordinates)))) {
          warn(label, "no point lies inside the play area, but swapped they do: write positions as [lng, lat]", "layer-coordinates-swapped");
        }
      }
      if (family !== "points" && kinds.includes("matching")) {
        const names = new Map();
        for (const f of feats) {
          const n = f.properties?.name;
          if (typeof n === "string") names.set(n, (names.get(n) ?? 0) + 1);
        }
        const repeated = [...names].filter(([, c]) => c > 1).map(([n]) => n);
        if (repeated.length) {
          warn(label, `matching treats each feature as its own ${family === "lines" ? "line" : "region"}, but names repeat (${repeated.slice(0, 5).join(", ")}); merge each into one Multi${family === "lines" ? "LineString" : "Polygon"} feature`, "repeated-names");
        }
      }
      if (family === "polygons" && pointZones.length) {
        let none = 0, many = 0;
        for (const z of pointZones) {
          const n = feats.filter((f) => contains(f.geometry, pointOf(z))).length;
          if (n === 0) none++;
          if (n > 1) many++;
        }
        if (none === pointZones.length) {
          warn(label, "no hiding zone lies in any of its regions, so every player gets the same answer (swapped coordinates?); for features nobody stands in, such as water, use a line or point layer", "zones-outside-all-regions");
        } else if (kinds.includes("matching")) {
          if (many) warn(label, `${many} hiding zone centre(s) fall in more than one region; regions overlap (the first in file order wins)`, "overlapping-regions");
          if (none) note(label, `${none} hiding zone centre(s) fall in no region; "outside every region" becomes its own answer`, "zones-outside-regions");
        }
      }
    }

    const precise = [def.map?.playArea, hz.features, ...layers.map((l) => l.data)]
      .some((fc) => fc?.features?.some((f) => tooPrecise(f.geometry?.coordinates)));
    if (precise) note("/", "coordinates carry more than 6 decimals (~0.1 m); rounding to 6 shrinks the file", "too-precise");
    const mb = (fileSize ?? 0) / 1024 / 1024;
    if (mb > 10) warn("/", `${mb.toFixed(1)} MB; simplify boundaries and drop unused properties (import limit 50 MB)`, "large-file");
  }

  // ── Questions offered ──────────────────────────────────────────────────────

  const questions = [];
  if (errors.length === 0) {
    if (Array.isArray(def.radars)) questions.push({ kind: "radar", label: `radii ${def.radars.join(", ")}` });
    else if (def.radars === true) questions.push({ kind: "radar", label: `${hz.radius ?? 400}` });
    if (def.thermometer === true) questions.push({ kind: "thermometer", label: "" });
    for (const { name, kinds, family } of layerInfo) {
      for (const kind of kinds) {
        if (kind === "tentacle" && family !== "points") continue;
        questions.push({ kind, label: questionLabel(name, kind, family), id: `${kind}-${slug(name)}` });
      }
    }
  }
  return { errors, warnings, notes, questions, zoneCount: zones.length, layerCount: layers.length };
}

// ── Command line ─────────────────────────────────────────────────────────────

function main(args, { readFileSync, statSync }) {
  const strict = args.includes("--strict");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node check-game.mjs [--strict] <file.game.json>");
    process.exit(2);
  }
  const def = JSON.parse(readFileSync(file, "utf8"));
  const { errors, warnings, notes, questions, zoneCount, layerCount } = checkGame(def, { fileSize: statSync(file).size });
  const failures = strict ? warnings.filter((w) => STRICT_CODES.has(w.code)) : [];

  for (const e of errors) console.log(`ERROR ${e.path}: ${e.message}`);
  for (const w of warnings) console.log(`${failures.includes(w) ? "FAIL " : "WARN "} ${w.path}: ${w.message}`);
  for (const n of notes) console.log(`NOTE  ${n.path}: ${n.message}`);
  if (errors.length === 0) {
    const gameId = def.id ?? slug(def.name);
    console.log(`\n${gameId}: ${zoneCount} hiding zones, ${layerCount} layers. Questions offered:`);
    for (const { kind, label, id } of questions) {
      console.log(`  ${kind.padEnd(12)} ${label}${id ? `  [${id}]` : ""}`.trimEnd());
    }
  }
  const failed = strict ? ` (${failures.length} fail under --strict)` : "";
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)${failed}, ${notes.length} note(s)`);
  process.exit(errors.length || failures.length ? 1 : 0);
}

// Module names in variables, so bundlers leave these imports alone.
const NODE_FS = "node:fs";
const NODE_URL = "node:url";
const script = globalThis.process?.argv?.[1];
if (script) {
  Promise.all([import(/* @vite-ignore */ NODE_FS), import(/* @vite-ignore */ NODE_URL)]).then(([fs, url]) => {
    if (import.meta.url === url.pathToFileURL(fs.realpathSync(script)).href) main(process.argv.slice(2), fs);
  });
}
