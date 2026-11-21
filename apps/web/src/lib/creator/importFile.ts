import {
    type GameDefinition,
    type GeoJsonGeometry,
    type PlayAreaFeatureCollection,
    type Position,
    validateGameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";

import {
    countGeometryVertices,
    type CreatorGeoFeatureItem,
} from "@/lib/creator/osmGeometry";
import type { CreatorPointItem } from "@/lib/creator/overpass";

export type GeometryFamily = "points" | "lines" | "polygons";

export interface ImportedRawFeature {
    name: string;
    tier?: string;
    geometry: GeoJsonGeometry;
    family: GeometryFamily;
    /** KML `<styleUrl>` (e.g. `#icon-1807-FF5252`) when imported from KML. */
    styleUrl?: string;
    /** Stringified ExtendedData / GeoJSON properties / CSV columns for grouping. */
    attributes?: Record<string, string>;
}

export interface FolderSplitOption {
    key: string;
    label: string;
    groupCount: number;
}

export interface SplitFeatureGroup {
    key: string;
    suggestedName: string;
    features: ImportedRawFeature[];
    family: GeometryFamily;
}

export interface ImportedFolder {
    name: string;
    features: ImportedRawFeature[];
    counts: Record<GeometryFamily, number>;
}

export type ParsedImportFile =
    | {
          ok: true;
          kind: "folders";
          format: "kml" | "geojson" | "csv";
          folders: ImportedFolder[];
      }
    | {
          ok: true;
          kind: "game-definition";
          definition: GameDefinition;
      }
    | { ok: false; error: string };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
let importSeq = 0;
const nextImportUid = (prefix: string) => `${prefix}-${Date.now()}-${++importSeq}`;

function validPosition(raw: unknown): Position | null {
    if (!Array.isArray(raw) || raw.length < 2) return null;
    if (typeof raw[0] !== "number" || typeof raw[1] !== "number") return null;
    const lng = raw[0];
    const lat = raw[1];
    if (
        !Number.isFinite(lng) ||
        !Number.isFinite(lat) ||
        Math.abs(lng) > 180 ||
        Math.abs(lat) > 90
    ) {
        return null;
    }
    return [round6(lng), round6(lat)];
}

function parseCoordNumber(raw: string | undefined): number | null {
    const trimmed = raw?.trim() ?? "";
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
}

function cleanPath(coords: unknown): Position[] {
    if (!Array.isArray(coords)) return [];
    const out: Position[] = [];
    for (const item of coords) {
        const p = validPosition(item);
        if (!p) continue;
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) {
            out.push(p);
        }
    }
    return out;
}

function cleanRing(coords: unknown): Position[] | null {
    const r = cleanPath(coords);
    if (r.length >= 3) {
        const first = r[0];
        const last = r[r.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            r.push([first[0], first[1]]);
        }
    }
    return r.length >= 4 ? r : null;
}

function cleanPolygon(rings: unknown): Position[][] | null {
    if (!Array.isArray(rings) || rings.length === 0) return null;
    const outer = cleanRing(rings[0]);
    if (!outer) return null;
    const holes = rings
        .slice(1)
        .map(cleanRing)
        .filter((r): r is Position[] => r !== null);
    return [outer, ...holes];
}

function familyOf(geom: GeoJsonGeometry): GeometryFamily {
    if (geom.type === "Point") return "points";
    if (geom.type === "LineString" || geom.type === "MultiLineString") {
        return "lines";
    }
    return "polygons";
}

function normalizeAnyGeometry(raw: unknown): GeoJsonGeometry[] {
    if (!raw || typeof raw !== "object") return [];
    const g = raw as {
        type?: string;
        coordinates?: unknown;
        geometries?: unknown[];
    };
    switch (g.type) {
        case "Point": {
            const p = validPosition(g.coordinates);
            return p ? [{ type: "Point", coordinates: p }] : [];
        }
        case "MultiPoint":
            return Array.isArray(g.coordinates)
                ? g.coordinates.flatMap((c) => {
                      const p = validPosition(c);
                      return p ? [{ type: "Point" as const, coordinates: p }] : [];
                  })
                : [];
        case "LineString": {
            const line = cleanPath(g.coordinates);
            return line.length >= 2
                ? [{ type: "LineString", coordinates: line }]
                : [];
        }
        case "MultiLineString": {
            if (!Array.isArray(g.coordinates)) return [];
            const lines = g.coordinates
                .map(cleanPath)
                .filter((l) => l.length >= 2);
            if (lines.length === 0) return [];
            return lines.length === 1
                ? [{ type: "LineString", coordinates: lines[0] }]
                : [{ type: "MultiLineString", coordinates: lines }];
        }
        case "Polygon": {
            const poly = cleanPolygon(g.coordinates);
            return poly ? [{ type: "Polygon", coordinates: poly }] : [];
        }
        case "MultiPolygon": {
            if (!Array.isArray(g.coordinates)) return [];
            const polys = g.coordinates
                .map(cleanPolygon)
                .filter((p): p is Position[][] => p !== null);
            if (polys.length === 0) return [];
            return polys.length === 1
                ? [{ type: "Polygon", coordinates: polys[0] }]
                : [{ type: "MultiPolygon", coordinates: polys }];
        }
        case "GeometryCollection": {
            if (!Array.isArray(g.geometries)) return [];
            const parts = g.geometries.flatMap(normalizeAnyGeometry);
            const points = parts.filter((p) => p.type === "Point");
            const lineCoords = parts.flatMap((p) =>
                p.type === "LineString"
                    ? [p.coordinates]
                    : p.type === "MultiLineString"
                      ? p.coordinates
                      : [],
            );
            const polyCoords = parts.flatMap((p) =>
                p.type === "Polygon"
                    ? [p.coordinates]
                    : p.type === "MultiPolygon"
                      ? p.coordinates
                      : [],
            );
            const merged: GeoJsonGeometry[] = [...points];
            if (lineCoords.length === 1) {
                merged.push({ type: "LineString", coordinates: lineCoords[0] });
            } else if (lineCoords.length > 1) {
                merged.push({
                    type: "MultiLineString",
                    coordinates: lineCoords,
                });
            }
            if (polyCoords.length === 1) {
                merged.push({ type: "Polygon", coordinates: polyCoords[0] });
            } else if (polyCoords.length > 1) {
                merged.push({
                    type: "MultiPolygon",
                    coordinates: polyCoords,
                });
            }
            return merged;
        }
        default:
            return [];
    }
}

function summarizeFolder(
    name: string,
    features: ImportedRawFeature[],
): ImportedFolder {
    const counts: Record<GeometryFamily, number> = {
        points: 0,
        lines: 0,
        polygons: 0,
    };
    for (const f of features) counts[f.family]++;
    return { name, features, counts };
}

// ── KML parser (browser DOMParser, zero extra deps) ──────────────────────────

function parseKmlCoordinateText(text: string): Position[] {
    const out: Position[] = [];
    for (const token of text.trim().split(/\s+/)) {
        if (!token) continue;
        const parts = token.split(",");
        if (parts.length < 2) continue;
        const lng = parseCoordNumber(parts[0]);
        const lat = parseCoordNumber(parts[1]);
        if (lng === null || lat === null) continue;
        const p = validPosition([lng, lat]);
        if (!p) continue;
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) {
            out.push(p);
        }
    }
    return out;
}

function directChildrenByLocalName(el: Element, localName: string): Element[] {
    const out: Element[] = [];
    for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        if (child.localName === localName) out.push(child);
    }
    return out;
}

function directChildText(el: Element, localName: string): string {
    const child = directChildrenByLocalName(el, localName)[0];
    return child?.textContent?.trim() ?? "";
}

function extractKmlGeometries(node: Element): GeoJsonGeometry[] {
    const geometries: GeoJsonGeometry[] = [];
    for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        switch (child.localName) {
            case "Point": {
                const coords = parseKmlCoordinateText(
                    directChildText(child, "coordinates"),
                );
                if (coords.length > 0) {
                    geometries.push({ type: "Point", coordinates: coords[0] });
                }
                break;
            }
            case "LineString": {
                const coords = parseKmlCoordinateText(
                    directChildText(child, "coordinates"),
                );
                if (coords.length >= 2) {
                    geometries.push({
                        type: "LineString",
                        coordinates: coords,
                    });
                }
                break;
            }
            case "Polygon": {
                const outerEl = directChildrenByLocalName(
                    child,
                    "outerBoundaryIs",
                )[0];
                const outerLr = outerEl
                    ? directChildrenByLocalName(outerEl, "LinearRing")[0]
                    : undefined;
                const outer = outerLr
                    ? cleanRing(
                          parseKmlCoordinateText(
                              directChildText(outerLr, "coordinates"),
                          ),
                      )
                    : null;
                if (!outer) break;
                const holes: Position[][] = [];
                for (const innerEl of directChildrenByLocalName(
                    child,
                    "innerBoundaryIs",
                )) {
                    const lr = directChildrenByLocalName(
                        innerEl,
                        "LinearRing",
                    )[0];
                    if (!lr) continue;
                    const ring = cleanRing(
                        parseKmlCoordinateText(
                            directChildText(lr, "coordinates"),
                        ),
                    );
                    if (ring) holes.push(ring);
                }
                geometries.push({
                    type: "Polygon",
                    coordinates: [outer, ...holes],
                });
                break;
            }
            case "MultiGeometry": {
                const sub = extractKmlGeometries(child);
                geometries.push(
                    ...normalizeAnyGeometry({
                        type: "GeometryCollection",
                        geometries: sub,
                    }),
                );
                break;
            }
        }
    }
    return geometries;
}

function extractKmlExtendedData(placemark: Element): Record<string, string> {
    const out: Record<string, string> = {};
    for (const ext of directChildrenByLocalName(placemark, "ExtendedData")) {
        for (const dataEl of directChildrenByLocalName(ext, "Data")) {
            const key = dataEl.getAttribute("name")?.trim();
            const val = directChildText(dataEl, "value");
            if (key && val) out[key] = val;
        }
        for (const schemaData of directChildrenByLocalName(ext, "SchemaData")) {
            for (const simple of directChildrenByLocalName(
                schemaData,
                "SimpleData",
            )) {
                const key = simple.getAttribute("name")?.trim();
                const val = simple.textContent?.trim() ?? "";
                if (key && val) out[key] = val;
            }
        }
    }
    return out;
}

export function parseKmlText(xmlText: string): ParsedImportFile {
    if (typeof DOMParser === "undefined") {
        return {
            ok: false,
            error: "KML parsing requires a browser DOMParser.",
        };
    }
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) {
        return { ok: false, error: "Could not parse KML XML." };
    }

    const folderBuckets = new Map<string, ImportedRawFeature[]>();
    const add = (folderName: string, feature: ImportedRawFeature) => {
        const list = folderBuckets.get(folderName) ?? [];
        list.push(feature);
        folderBuckets.set(folderName, list);
    };

    const walk = (el: Element, topFolder: string | null) => {
        for (let i = 0; i < el.children.length; i++) {
            const child = el.children[i];
            if (child.localName === "Document") {
                walk(child, topFolder);
            } else if (child.localName === "Folder") {
                const name =
                    directChildText(child, "name") || "(Unnamed folder)";
                walk(child, topFolder ?? name);
            } else if (child.localName === "Placemark") {
                const name = directChildText(child, "name");
                const styleUrl = directChildText(child, "styleUrl") || undefined;
                const ext = extractKmlExtendedData(child);
                const tier = ext.tier || ext.Tier || undefined;
                const geoms = extractKmlGeometries(child);
                const hasAttrs = Object.keys(ext).length > 0;
                for (const geom of geoms) {
                    add(topFolder ?? "(Root)", {
                        name: name || ext.name || ext.Name || "Unnamed",
                        tier,
                        geometry: geom,
                        family: familyOf(geom),
                        ...(styleUrl && { styleUrl }),
                        ...(hasAttrs && { attributes: ext }),
                    });
                }
            }
        }
    };

    walk(doc.documentElement, null);
    const folders = [...folderBuckets.entries()]
        .filter(([, features]) => features.length > 0)
        .map(([name, features]) => summarizeFolder(name, features));

    if (folders.length === 0) {
        return {
            ok: false,
            error: "No supported placemarks found in that KML file.",
        };
    }
    return { ok: true, kind: "folders", format: "kml", folders };
}

// ── CSV parser (RFC 4180) ────────────────────────────────────────────────────

function detectCsvDelimiter(text: string): "," | ";" | "\t" {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    let inQuote = false;
    let commas = 0;
    let semicolons = 0;
    let tabs = 0;
    for (let i = 0; i < firstLine.length; i++) {
        const ch = firstLine[i];
        if (ch === '"') inQuote = !inQuote;
        else if (!inQuote) {
            if (ch === ",") commas++;
            else if (ch === ";") semicolons++;
            else if (ch === "\t") tabs++;
        }
    }
    if (commas === 0 && semicolons > 0) return ";";
    if (commas === 0 && semicolons === 0 && tabs > 0) return "\t";
    return ",";
}

function parseCsvRows(
    text: string,
    delimiter: "," | ";" | "\t",
): { ok: true; rows: string[][] } | { ok: false; error: string } {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    let quoteStartRow = 1;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') {
                quoted = false;
            } else {
                cell += ch;
            }
        } else if (ch === '"') {
            quoted = true;
            quoteStartRow = rows.length + 1;
        } else if (ch === delimiter) {
            row.push(cell);
            cell = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else {
            cell += ch;
        }
    }
    if (quoted) {
        return {
            ok: false,
            error: `CSV has an unclosed quote starting on row ${quoteStartRow}.`,
        };
    }
    if (cell !== "" || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return { ok: true, rows };
}

/** Parses WKT `POINT [Z|M|ZM] (lng lat ...)` used by Google My Maps CSV exports. */
function parseWktPoint(raw: string | undefined): Position | null {
    if (!raw) return null;
    const match = raw
        .trim()
        .match(
            /^POINT(?:\s+(?:Z|M|ZM))?\s*\(\s*([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?:\s+[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)*\s*\)$/i,
        );
    if (!match) return null;
    const lng = parseCoordNumber(match[1]);
    const lat = parseCoordNumber(match[2]);
    if (lng === null || lat === null) return null;
    return validPosition([lng, lat]);
}

export function parseCsvText(
    csvText: string,
    fileName = "CSV",
): ParsedImportFile {
    const clean = csvText.replace(/^\uFEFF/, "").trim();
    if (!clean) return { ok: false, error: "CSV file is empty." };
    const delimiter = detectCsvDelimiter(clean);
    const parsedRows = parseCsvRows(clean, delimiter);
    if (!parsedRows.ok) return parsedRows;
    const rows = parsedRows.rows;
    const header = rows.shift()!.map((h) => h.trim());
    const findCol = (...names: string[]) =>
        header.findIndex((h) => names.includes(h.toLowerCase()));
    const wktCol = findCol("wkt", "geometry", "geom");
    const latCol = findCol("lat", "latitude", "y");
    const lngCol = findCol("lng", "lon", "long", "longitude", "x");
    const nameCol = findCol("name", "title", "station", "stop", "label");
    const tierCol = findCol("tier");

    const hasLatLng = latCol >= 0 && lngCol >= 0;
    const hasWkt = wktCol >= 0;

    if (!hasLatLng && !hasWkt) {
        return {
            ok: false,
            error: "CSV must have `lat`/`latitude` and `lng`/`lon`/`longitude` columns (or a Google My Maps `WKT` column).",
        };
    }

    const features: ImportedRawFeature[] = [];
    for (const row of rows) {
        if (!row.some((c) => c.trim() !== "")) continue;
        let pos: Position | null = null;
        if (hasLatLng) {
            const lat = parseCoordNumber(row[latCol]);
            const lng = parseCoordNumber(row[lngCol]);
            if (lat !== null && lng !== null) {
                pos = validPosition([lng, lat]);
            }
        }
        if (!pos && hasWkt) {
            pos = parseWktPoint(row[wktCol]);
        }
        if (!pos) continue;
        const name =
            (nameCol >= 0 ? row[nameCol]?.trim() : "") ||
            `Point ${features.length + 1}`;
        const tier = tierCol >= 0 ? row[tierCol]?.trim() || undefined : undefined;
        features.push({
            name,
            tier,
            geometry: { type: "Point", coordinates: pos },
            family: "points",
        });
    }

    if (features.length === 0) {
        return {
            ok: false,
            error: "No rows with valid latitude/longitude or WKT point coordinates found.",
        };
    }

    const baseName = fileName.replace(/\.(csv|tsv)$/i, "") || "CSV";
    return {
        ok: true,
        kind: "folders",
        format: "csv",
        folders: [summarizeFolder(baseName, features)],
    };
}

// ── GeoJSON / Searchlight game.json parser ───────────────────────────────────

export function parseJsonImportText(
    jsonText: string,
    fileName = "GeoJSON",
): ParsedImportFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        return {
            ok: false,
            error: `Invalid JSON: ${err instanceof Error ? err.message : "Parse error"}`,
        };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "File must contain a JSON object." };
    }
    const obj = parsed as Record<string, unknown>;

    // Detect a full Searchlight game.json file.
    if (obj.map && obj.hidingZones) {
        const candidate = { ...obj, serverId: obj.serverId || "home-games" };
        const valid = validateGameDefinition(candidate);
        if (valid.valid) {
            return {
                ok: true,
                kind: "game-definition",
                definition: candidate as GameDefinition,
            };
        }
        const firstErr = valid.errors[0];
        const formatted = firstErr
            ? `${firstErr.path && firstErr.path !== "/" ? `${firstErr.path}: ` : ""}${firstErr.message}`
            : "Schema validation failed.";
        return {
            ok: false,
            error: `Invalid Searchlight .game.json: ${formatted}`,
        };
    }

    let rawFeatures: Array<{
        geometry?: unknown;
        properties?: Record<string, unknown> | null;
    }>;
    if (obj.type === "FeatureCollection" && Array.isArray(obj.features)) {
        rawFeatures = obj.features as typeof rawFeatures;
    } else if (obj.type === "Feature") {
        rawFeatures = [obj as (typeof rawFeatures)[number]];
    } else if (
        (typeof obj.type === "string" && "coordinates" in obj) ||
        (obj.type === "GeometryCollection" && Array.isArray(obj.geometries))
    ) {
        rawFeatures = [{ geometry: obj, properties: {} }];
    } else {
        return {
            ok: false,
            error: "Not a GeoJSON FeatureCollection/Feature or valid Searchlight .game.json.",
        };
    }

    const features: ImportedRawFeature[] = [];
    for (const f of rawFeatures) {
        const props = (f?.properties ?? {}) as Record<string, unknown>;
        const rawName =
            typeof props.name === "string"
                ? props.name
                : typeof props.Name === "string"
                  ? props.Name
                  : typeof props.title === "string"
                    ? props.title
                    : "";
        const tier =
            typeof props.tier === "string"
                ? props.tier.trim() || undefined
                : typeof props.tier === "number"
                  ? String(props.tier)
                  : undefined;

        const attrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(props)) {
            if (typeof v === "string" && v.trim()) attrs[k] = v.trim();
            else if (typeof v === "number" && Number.isFinite(v)) {
                attrs[k] = String(v);
            }
        }
        const hasAttrs = Object.keys(attrs).length > 0;

        for (const geom of normalizeAnyGeometry(f?.geometry)) {
            features.push({
                name: rawName.trim() || `Feature ${features.length + 1}`,
                tier,
                geometry: geom,
                family: familyOf(geom),
                ...(hasAttrs && { attributes: attrs }),
            });
        }
    }

    if (features.length === 0) {
        return { ok: false, error: "No supported GeoJSON geometries found." };
    }

    const baseName = fileName.replace(/\.(geo)?json$/i, "") || "GeoJSON";
    return {
        ok: true,
        kind: "folders",
        format: "geojson",
        folders: [summarizeFolder(baseName, features)],
    };
}

/** Auto-detects `.kml`, `.csv`, `.geojson`, or `.json` and parses it. */
export function parseImportedFileText(
    fileName: string,
    text: string,
): ParsedImportFile {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".kml") || text.trimStart().startsWith("<")) {
        return parseKmlText(text);
    }
    if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
        return parseCsvText(text, fileName);
    }
    return parseJsonImportText(text, fileName);
}

/**
 * Merges line or polygon features sharing the same name into a single
 * MultiLineString / MultiPolygon feature each (matching game-tools.mjs).
 */
export function mergeImportedByName(
    features: readonly ImportedRawFeature[],
    family: GeometryFamily,
): CreatorGeoFeatureItem[] {
    const filtered = features.filter((f) => f.family === family);
    if (family === "points") {
        return filtered.map((f) => ({
            uid: nextImportUid("imp-pt"),
            name: f.name,
            geometry: f.geometry,
            enabled: true,
        }));
    }

    const grouped = new Map<string, GeoJsonGeometry[]>();
    const order: string[] = [];
    for (const f of filtered) {
        const key = f.name.trim() || `Feature ${order.length + 1}`;
        if (!grouped.has(key)) {
            grouped.set(key, []);
            order.push(key);
        }
        grouped.get(key)!.push(f.geometry);
    }

    return order.map((name) => {
        const geoms = grouped.get(name)!;
        if (family === "lines") {
            const parts = geoms.flatMap((g) =>
                g.type === "LineString"
                    ? [g.coordinates]
                    : g.type === "MultiLineString"
                      ? g.coordinates
                      : [],
            );
            return {
                uid: nextImportUid("imp-line"),
                name,
                geometry:
                    parts.length === 1
                        ? { type: "LineString", coordinates: parts[0] }
                        : { type: "MultiLineString", coordinates: parts },
                enabled: true,
            };
        }
        const parts = geoms.flatMap((g) =>
            g.type === "Polygon"
                ? [g.coordinates]
                : g.type === "MultiPolygon"
                  ? g.coordinates
                  : [],
        );
        return {
            uid: nextImportUid("imp-poly"),
            name,
            geometry:
                parts.length === 1
                    ? { type: "Polygon", coordinates: parts[0] }
                    : { type: "MultiPolygon", coordinates: parts },
            enabled: true,
        };
    });
}

function isValidPlayAreaPolygon(
    geom:
        | Extract<GeoJsonGeometry, { type: "Polygon" }>
        | Extract<GeoJsonGeometry, { type: "MultiPolygon" }>,
): boolean {
    const polys =
        geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    if (polys.length === 0) return false;
    for (const poly of polys) {
        try {
            const f = turf.polygon(poly);
            if (turf.kinks(f).features.length > 0) return false;
            if (turf.area(f) < 1) return false;
        } catch {
            return false;
        }
    }
    return true;
}

export function importedFeaturesToPlayArea(
    features: readonly ImportedRawFeature[],
): PlayAreaFeatureCollection | null {
    const polys = features.filter(
        (f) =>
            f.family === "polygons" &&
            isValidPlayAreaPolygon(
                f.geometry as
                    | Extract<GeoJsonGeometry, { type: "Polygon" }>
                    | Extract<GeoJsonGeometry, { type: "MultiPolygon" }>,
            ),
    );
    if (polys.length === 0) return null;
    return {
        type: "FeatureCollection",
        features: polys.map((f) => ({
            type: "Feature",
            geometry: f.geometry as
                | Extract<GeoJsonGeometry, { type: "Polygon" }>
                | Extract<GeoJsonGeometry, { type: "MultiPolygon" }>,
            properties: { name: f.name },
        })),
    };
}

export function importedFeaturesToStations(
    features: readonly ImportedRawFeature[],
): CreatorPointItem[] {
    const out: CreatorPointItem[] = [];
    for (const f of features) {
        if (f.geometry.type !== "Point") continue;
        out.push({
            uid: nextImportUid("imp-st"),
            name: f.name,
            lng: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
            tier: f.tier,
            enabled: true,
            custom: true,
        });
    }
    return out;
}

export function sumFeatureVertices(
    items: readonly Pick<CreatorGeoFeatureItem, "geometry">[],
): number {
    return items.reduce(
        (sum, item) => sum + countGeometryVertices(item.geometry),
        0,
    );
}

export const SPLIT_BY_STYLE_KEY = "__style__";

const PREFERRED_SPLIT_FIELDS = [
    "type",
    "category",
    "kind",
    "layer",
    "group",
    "class",
    "amenity",
    "tourism",
    "leisure",
];

const IGNORED_SPLIT_FIELDS = new Set([
    "name",
    "title",
    "description",
    "beschreibung",
    "id",
    "@id",
    "@geometry",
    "website",
    "url",
    "phone",
    "email",
    "opening_hours",
    "wikidata",
    "addr:city",
    "addr:street",
    "addr:postcode",
    "addr:housenumber",
    "addr:country",
]);

function humanizeLayerLabel(raw: string): string {
    const clean = raw
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!clean) return "Layer";
    const overrides: Record<string, string> = {
        hospitals: "Hospital",
        hospital: "Hospital",
        themeparks: "Theme Park",
        "theme parks": "Theme Park",
        "theme park": "Theme Park",
        zoos: "Zoo",
        museums: "Museum",
        libraries: "Library",
        cinemas: "Cinema",
        movies: "Cinema",
        movie: "Cinema",
        airports: "Airport",
        universities: "University",
        parks: "Park",
        aquariums: "Aquarium",
        consulates: "Consulate",
        "foreign consulate": "Foreign Consulate",
        "foreign consulates": "Foreign Consulate",
        golf: "Golf Course",
        "golf courses": "Golf Course",
    };
    const lower = clean.toLowerCase();
    if (overrides[lower]) return overrides[lower];
    return clean
        .split(" ")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ");
}

/**
 * Detects candidate attributes (e.g. KML ExtendedData `type`/`category`) or
 * KML `styleUrl` icons that partition a folder's features into 2–30 groups
 * (e.g. splitting Google My Maps "Public Amenities" into Hospital, Airport, …).
 */
export function detectFolderSplitFields(
    features: readonly ImportedRawFeature[],
): FolderSplitOption[] {
    if (features.length < 2) return [];
    const options: FolderSplitOption[] = [];

    // 1. Attribute-based split candidates
    const fieldValues = new Map<string, Set<string>>();
    const fieldCoverage = new Map<string, number>();
    for (const f of features) {
        if (!f.attributes) continue;
        for (const [key, val] of Object.entries(f.attributes)) {
            if (!val || IGNORED_SPLIT_FIELDS.has(key.toLowerCase())) continue;
            let set = fieldValues.get(key);
            if (!set) {
                set = new Set();
                fieldValues.set(key, set);
            }
            set.add(val.trim());
            fieldCoverage.set(key, (fieldCoverage.get(key) ?? 0) + 1);
        }
    }

    for (const [key, values] of fieldValues.entries()) {
        const coverage = fieldCoverage.get(key) ?? 0;
        // Require at least 2 distinct groups, <= 30 groups, and meaningful coverage (>= 50% of features)
        if (
            values.size >= 2 &&
            values.size <= 30 &&
            coverage >= Math.ceil(features.length * 0.5)
        ) {
            options.push({
                key,
                label: `Attribute "${key}"`,
                groupCount: values.size,
            });
        }
    }

    options.sort((a, b) => {
        const ai = PREFERRED_SPLIT_FIELDS.indexOf(a.key.toLowerCase());
        const bi = PREFERRED_SPLIT_FIELDS.indexOf(b.key.toLowerCase());
        if (ai !== -1 || bi !== -1) {
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        }
        return a.groupCount - b.groupCount;
    });

    // 2. KML styleUrl fallback (works even when a My Maps KML has no `type` column!)
    const styles = new Set<string>();
    for (const f of features) {
        if (f.styleUrl) styles.add(f.styleUrl);
    }
    if (styles.size >= 2 && styles.size <= 30) {
        options.push({
            key: SPLIT_BY_STYLE_KEY,
            label: "KML icon / style",
            groupCount: styles.size,
        });
    }

    return options;
}

/**
 * Splits a folder's features into named groups by an attribute key or
 * `SPLIT_BY_STYLE_KEY`, preserving insertion order.
 */
export function splitFeaturesByField(
    features: readonly ImportedRawFeature[],
    fieldKey: string,
): SplitFeatureGroup[] {
    const groups = new Map<string, ImportedRawFeature[]>();
    for (const f of features) {
        const rawKey =
            fieldKey === SPLIT_BY_STYLE_KEY
                ? f.styleUrl || "(Default style)"
                : f.attributes?.[fieldKey]?.trim() || "(Unspecified)";
        const list = groups.get(rawKey) ?? [];
        list.push(f);
        groups.set(rawKey, list);
    }

    let styleNum = 1;
    return [...groups.entries()].map(([key, list]) => {
        const counts = { points: 0, lines: 0, polygons: 0 };
        for (const f of list) counts[f.family]++;
        const family: GeometryFamily =
            counts.polygons >= counts.lines && counts.polygons >= counts.points
                ? "polygons"
                : counts.lines >= counts.points
                  ? "lines"
                  : "points";
        const suggestedName =
            fieldKey === SPLIT_BY_STYLE_KEY
                ? `Group ${styleNum++}`
                : humanizeLayerLabel(key);
        return {
            key,
            suggestedName,
            features: list.filter((f) => f.family === family),
            family,
        };
    });
}
