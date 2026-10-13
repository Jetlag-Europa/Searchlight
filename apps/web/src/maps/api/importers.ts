import type { Feature, FeatureCollection, Point } from "geojson";
import Papa from "papaparse";

import type { Units } from "@/maps/schema";

import type {
    CustomStation,
    StationPlace,
    StationPlaceProperties,
} from "./types";

function parseCSV(text: string): CustomStation[] {
    const { data, errors } = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.toLowerCase().trim(),
    });

    if (errors.length > 0) {
        throw new Error(`CSV parse error: ${errors[0].message}`);
    }

    const firstRow = data[0] ?? {};
    const headers = Object.keys(firstRow);

    const latKey = headers.find((h) => ["lat", "latitude"].includes(h));
    const lngKey = headers.find((h) =>
        ["lng", "lon", "long", "longitude"].includes(h),
    );
    const nameKey = headers.find((h) =>
        ["name", "title", "station", "label"].includes(h),
    );
    const idKey = headers.find((h) =>
        ["id", "station_id", "osm_id"].includes(h),
    );
    const tierKey = headers.find((h) =>
        ["tier", "level"].includes(h.toLowerCase()),
    );
    const radiusKey = headers.find((h) =>
        ["radius", "rad"].includes(h.toLowerCase()),
    );
    const unitKey = headers.find((h) =>
        ["unit", "units"].includes(h.toLowerCase()),
    );
    if (!latKey)
        throw new Error("CSV missing required 'lat' or 'latitude' column");
    if (!lngKey)
        throw new Error(
            "CSV missing required 'lng', 'lon', 'long', or 'longitude' column",
        );
    if (!nameKey)
        throw new Error(
            "CSV missing required 'name', 'title', 'station', or 'label' column",
        );

    const stations: CustomStation[] = [];
    for (const row of data) {
        const lat = parseFloat(row[latKey]);
        const lng = parseFloat(row[lngKey]);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        const name = row[nameKey];
        if (!name) continue;
        const id = idKey && row[idKey] ? row[idKey] : `${lat},${lng}`;
        const tier = tierKey && row[tierKey] ? row[tierKey] : undefined;
        const radiusNum = radiusKey && row[radiusKey] ? parseFloat(row[radiusKey]) : NaN;
        const radius = isFinite(radiusNum) ? radiusNum : undefined;
        const rawUnit = unitKey && row[unitKey] ? row[unitKey].toLowerCase().trim() : undefined;
        const unit: Units | undefined =
            rawUnit === "miles" || rawUnit === "kilometers" || rawUnit === "meters"
                ? rawUnit
                : undefined;
        stations.push({
            id,
            name,
            lat,
            lng,
            ...(tier ? { tier } : {}),
            ...(radius !== undefined ? { radius } : {}),
            ...(unit ? { unit } : {}),
        });
    }
    return stations;
}

function parseGeoJSON(obj: unknown): CustomStation[] {
    const stations: CustomStation[] = [];
    const pushFromFeature = (f: Feature<Point>) => {
        if (!f.geometry || f.geometry.type !== "Point") return;
        const [lng, lat] = f.geometry.coordinates;
        if (!isFinite(lat) || !isFinite(lng)) return;
        const props = (f.properties || {}) as Record<string, unknown>;
        const nameVal = props["name:en"] || props.name || props.title;
        const name = typeof nameVal === "string" ? nameVal : undefined;
        const idVal = props.id || props.osm_id || props["@id"] || `${lat},${lng}`;
        const id = String(idVal);
        const tierVal = props.tier || props.level;
        const tier = typeof tierVal === "string" || typeof tierVal === "number" ? String(tierVal) : undefined;
        const rawRadius = props.radius;
        const radiusObj = rawRadius && typeof rawRadius === "object" ? (rawRadius as Record<string, unknown>) : undefined;
        const radiusNum =
            typeof rawRadius === "number"
                ? rawRadius
                : typeof radiusObj?.value === "number"
                  ? radiusObj.value
                  : typeof rawRadius === "string"
                    ? parseFloat(rawRadius)
                    : NaN;
        const radius = isFinite(radiusNum) ? radiusNum : undefined;
        const rawUnit = typeof props.unit === "string" ? props.unit : typeof radiusObj?.unit === "string" ? radiusObj.unit : undefined;
        const unit: Units | undefined =
            rawUnit === "miles" || rawUnit === "kilometers" || rawUnit === "meters"
                ? rawUnit
                : undefined;
        stations.push({
            id,
            name,
            lat,
            lng,
            ...(tier ? { tier } : {}),
            ...(radius !== undefined ? { radius } : {}),
            ...(unit ? { unit } : {}),
        });
    };
    const geo = obj as { type?: string; features?: unknown[]; coordinates?: [number, number] } | null;
    if (geo?.type === "FeatureCollection" && Array.isArray(geo.features)) {
        geo.features.forEach((f) =>
            pushFromFeature(f as Feature<Point>),
        );
    } else if (geo?.type === "Feature") {
        pushFromFeature(geo as unknown as Feature<Point>);
    } else if (geo?.type === "Point" && Array.isArray(geo.coordinates)) {
        const [lng, lat] = geo.coordinates;
        stations.push({ id: `${lat},${lng}`, lat, lng });
    }
    return stations;
}

function parseKML(text: string): CustomStation[] {
    // Really light-weight parser for Point Placemarks; works for Google MyMaps export
    const stations: CustomStation[] = [];
    const placemarks = text.split(/<Placemark[\s>]/i).slice(1);
    for (const pm of placemarks) {
        const nameMatch = pm.match(/<name>([\s\S]*?)<\/name>/i);
        const coordsMatch = pm.match(
            /<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/i,
        );
        if (!coordsMatch) continue;
        // coordinates are lng,lat[,alt]
        const coordStr = coordsMatch[1].trim().split(/\s+/)[0];
        const parts = coordStr.split(",");
        const lng = parseFloat(parts[0]);
        const lat = parseFloat(parts[1]);
        if (!isFinite(lat) || !isFinite(lng)) continue;
        const name = nameMatch ? nameMatch[1].trim() : undefined;
        const tierMatch = pm.match(/<Data name="tier">\s*<value>([\s\S]*?)<\/value>/i);
        const tier = tierMatch ? tierMatch[1].trim() : undefined;
        const id = `${lat},${lng}`;
        stations.push({ id, name, lat, lng, tier });
    }
    return stations;
}

export function parseGPX(text: string): CustomStation[] {
    const stations: CustomStation[] = [];
    const wptRegex = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi;
    let match;
    while ((match = wptRegex.exec(text)) !== null) {
        const attrs = match[1];
        const body = match[2];
        const lat = parseFloat(attrs.match(/lat="([^"]+)"/)?.[1] ?? "");
        const lon = parseFloat(attrs.match(/lon="([^"]+)"/)?.[1] ?? "");
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/i);
        const name = nameMatch ? nameMatch[1].trim() : undefined;
        stations.push({ id: `${lat},${lon}`, name, lat, lng: lon });
    }
    return stations;
}

// Normalises common non-canonical folder names to the category key the
// questions expect. Folders already named with the canonical category pass
// through unchanged (identity). Add aliases here, not per-game.
const POI_FOLDER_ALIASES: Record<string, string> = {
    movie_theater: "cinema",
    movie_theatre: "cinema",
    amusement_park: "theme_park",
    peak: "mountain",
    golf: "golf_course",
};

const SKIPPED_POI_CATEGORIES = new Set(["administrative", "water"]);

/**
 * Parse a Folder-organised POI KML into `{ category: [{name,lat,lon}] }`.
 *
 * By convention each `<Folder>` is named with its canonical category, so the
 * folder name IS the category (after alias normalisation). Pass
 * `folderCategoryMap` only to override specific folder names (e.g. numeric
 * folders from some exports); folders absent from the map fall back to the
 * normalised folder name.
 */
export function parseKMLFolderPOI(
    text: string,
    folderCategoryMap: Record<string, string> = {},
): Record<string, Array<{ name: string; lat: number; lon: number }>> {
    const result: Record<string, Array<{ name: string; lat: number; lon: number }>> = {};
    const folderBlocks = text.split(/<Folder>/i).slice(1);
    for (const block of folderBlocks) {
        const folderNameMatch = block.match(/<name>([\s\S]*?)<\/name>/i);
        if (!folderNameMatch) continue;
        const folderName = folderNameMatch[1].trim();
        const mapped = folderCategoryMap[folderName] ?? folderName.toLowerCase();
        const category = POI_FOLDER_ALIASES[mapped] ?? mapped;
        if (!category || SKIPPED_POI_CATEGORIES.has(category)) continue;
        const placemarks = block.split(/<Placemark[\s>]/i).slice(1);
        for (const pm of placemarks) {
            const coordsMatch = pm.match(
                /<Point>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>[\s\S]*?<\/Point>/i,
            );
            if (!coordsMatch) continue;
            const parts = coordsMatch[1].trim().split(/\s+/)[0].split(",");
            const lon = parseFloat(parts[0]);
            const lat = parseFloat(parts[1]);
            if (!isFinite(lat) || !isFinite(lon)) continue;
            const nameMatch = pm.match(/<name>([\s\S]*?)<\/name>/i);
            const name = nameMatch ? nameMatch[1].trim() : "";
            if (!result[category]) result[category] = [];
            result[category].push({ name, lat, lon });
        }
    }
    return result;
}

export function parseCustomStationsFromText(
    text: string,
    contentTypeHint?: string,
): CustomStation[] {
    // Try by hint
    const hint = (contentTypeHint || "").toLowerCase();
    try {
        if (hint.includes("json")) {
            return parseGeoJSON(JSON.parse(text));
        }
        if (
            hint.includes("kml") ||
            text.includes("<kml") ||
            text.includes("<Placemark")
        ) {
            return parseKML(text);
        }
        if (
            hint.includes("csv") ||
            text.includes(",lat") ||
            text.match(/lat[,;\t ]+lon|latitude/i)
        ) {
            return parseCSV(text);
        }
    } catch {
        // Fall through
    }

    // Try generic detection
    try {
        const obj = JSON.parse(text);
        return parseGeoJSON(obj);
    } catch {
        // Not JSON
    }
    if (text.includes("<kml")) {
        return parseKML(text);
    }
    return parseCSV(text);
}

export function normalizeToStationFeatures(
    stations: CustomStation[],
): FeatureCollection<Point, StationPlaceProperties> {
    // Return GeoJSON FeatureCollection of Points carrying properties { id, name, tier, radius, unit }
    const features: StationPlace[] = stations.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: {
            id: s.id,
            name: s.name,
            ...(s.tier ? { tier: s.tier } : {}),
            ...(s.radius !== undefined ? { radius: s.radius } : {}),
            ...(s.unit ? { unit: s.unit } : {}),
        },
    }));
    return { type: "FeatureCollection", features };
}
