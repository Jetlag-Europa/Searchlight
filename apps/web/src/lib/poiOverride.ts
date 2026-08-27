// ── POI override choke point ──────────────────────────────────────────────────
//
// Single place that decides whether a POI-backed question should use a bundled
// game's custom POIs (from gamePOIData) instead of querying Overpass.
//
// Rule (per product spec): when the active game provides custom POIs for a
// category, ALL questions in that category use them and Overpass is never
// queried. Categories the game does not provide fall back to Overpass as usual.
//
// gamePOIData is keyed by category strings produced from each game's POI KML
// folder map (see GAME_REGISTRY[].poiFolders). Question identifiers reach those
// keys through two small helpers below:
//   - resolveCategory(key)          — for tentacles, whose locationType already
//                                     is the category (identity + aliases).
//   - categoryForQuestionType(type) — for matching/measuring question `type`s,
//                                     which carry a "-full" suffix and use
//                                     "peak" for the mountain category.

import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point } from "geojson";

import { gamePOIData } from "@/lib/context";

// Base question types (sans the "-full" suffix) that are POI-backed. The map
// value is the gamePOIData category key the type resolves to.
const POI_BASE_TYPE_TO_CATEGORY: Record<string, string> = {
    airport: "airport",
    aquarium: "aquarium",
    zoo: "zoo",
    theme_park: "theme_park",
    // The mountain question type is "peak"; games store mountains under "mountain".
    peak: "mountain",
    museum: "museum",
    hospital: "hospital",
    cinema: "cinema",
    library: "library",
    golf_course: "golf_course",
    consulate: "consulate",
    park: "park",
};

// Aliases for identifiers that don't equal their category key: legacy
// game-prefixed types still present in the schema, plus tentacle prefixes.
const CATEGORY_ALIASES: Record<string, string> = {
    peak: "mountain",
    "sl-camping": "camping",
    "sl-mill": "mill",
    "buch-train_station": "train_station",
    "bern-mountain": "mountain",
    "bern-park": "park",
    covrigarie: "covrigarie",
    "budapest-castle": "castle",
    "budapest-stadium": "stadium",
    "budapest-rail": "train_station",
    "belgium-castle": "castle",
    "london-stadium": "stadium",
    // NOT "train_station": that key overrides the generic same-train-line /
    // same-length-station questions, which must see all 271 London stations.
    "london-rail": "rail_terminus",
    // "ikea" is a game-specific category, not one of the 13 rulebook ones —
    // same shape as "castle" and "covrigarie". Only this question reads it.
    "stockholm-ikea": "ikea",
    // Milan. "castle" is the same key Belgium and Budapest use. The other two
    // are Milan-only keys chosen to avoid collisions: NOT "train_station"
    // (which would hijack the generic same-train-line questions with only 26 of
    // Milan's 269 stations) and NOT "water" (which the KML importer skips).
    "milan-castle": "castle",
    "milan-train": "rail_station",
    "milan-water": "water_body",
    // Brighton's 7 mainline stations. NOT "train_station", which would hijack
    // the generic same-train-line / same-length-station questions — those must
    // see all 132 of the map's stops, not just these 7.
    "brighton-rail": "rail_station",
};

/** Resolve a raw category/locationType key to its gamePOIData category. */
export function resolveCategory(key: string): string {
    return CATEGORY_ALIASES[key] ?? key;
}

/**
 * Resolve a matching/measuring question `type` to its gamePOIData category, or
 * null when the type is not POI-backed. Handles the "-full" suffix and the
 * peak→mountain rename.
 */
export function categoryForQuestionType(type: string): string | null {
    if (type in CATEGORY_ALIASES) return CATEGORY_ALIASES[type];
    const base = type.endsWith("-full") ? type.slice(0, -"-full".length) : type;
    return POI_BASE_TYPE_TO_CATEGORY[base] ?? null;
}

/** Custom POIs for a category, or null when the active game provides none. */
export function getCustomPOIs(
    category: string,
): Array<{ name: string; lat: number; lon: number }> | null {
    const arr = gamePOIData.get()[category];
    return arr && arr.length ? arr : null;
}

/** Custom POIs as turf points, or null when none. */
export function customPOIPoints(category: string): Feature<Point>[] | null {
    const arr = getCustomPOIs(category);
    if (!arr) return null;
    return arr.map((p) => turf.point([p.lon, p.lat], { name: p.name }));
}

/** Custom POIs as a turf FeatureCollection of points, or null when none. */
export function customPOIFeatureCollection(
    category: string,
): FeatureCollection<Point> | null {
    const pts = customPOIPoints(category);
    if (!pts) return null;
    return turf.featureCollection(pts) as FeatureCollection<Point>;
}
