// ── Greater Manchester bundled regions ───────────────────────────────────────
//
// The Greater Manchester 19-9 game answers these questions entirely from
// bundled GeoJSON — no Overpass at play time:
//   borough   the 10 metropolitan boroughs (1st admin division)
//   ward      the 215 ONS 2024 wards (2nd admin division)
//   hsl       matching only: the play area split by which of the two West Coast
//             Main Line stretches is nearer (gm-hsl-regions.geojson). Measuring
//             reads the lines themselves (gm-hsl.geojson) in measuring.ts.
//
// All start from the same lookup — the ONE region containing the seeker
// (findGmRegion), keyed by question type the way brightonAdmin.ts does it:
//   matching   → that region's polygon
//   measuring  → that region's border ring (gmRegionBorderLines)
//
// Measuring is scoped to the seeker's OWN region — the brighton-ward /
// graz-district / paris-arrondissement behaviour, not the london-borough
// all-borders reading.
//
// ## Boroughs are built from the wards
//
// The supplied borough polygons overlap each other by 0.61 km² and leave
// 0.77 km² of gaps, while the wards tile cleanly. So gen-greater-manchester-
// assets.py dissolves the wards by council instead: the two layers agree
// exactly, both tile the play area with no "Outer", and every one of the 168
// hiding zones is in exactly one ward and one borough. The only station whose
// borough differs from the supplied layer is Mills Hill (Rochdale here, Oldham
// in the hand-drawn polygon; the ONS answer is Rochdale).
//
// ## High-speed rail matching
//
// Both supplied lines are the same railway, so "same line" would always be
// true. Matching instead asks whether the nearest STRETCH is the same — south of
// Stockport or north of Wigan. That splits the board ~66/34 by area but 146/22
// by hiding zone, so it is a lopsided question by construction.

import * as turf from "@turf/turf";

export const GM_REGION_FILES: Record<string, string> = {
    "gm-borough": "gm-boroughs.geojson",
    "gm-ward": "gm-wards.geojson",
    "gm-hsl": "gm-hsl-regions.geojson",
};

// Measuring buffers the border geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadGmRegionFC = async (type: string): Promise<any | undefined> => {
    const file = GM_REGION_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:gm-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/**
 * The bundled borough / ward / HSL region containing [lng, lat], or undefined
 * outside the play area (the HSL regions extend a little beyond it).
 */
export const findGmRegion = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadGmRegionFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    const found = fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
    console.info(
        `[taibled:gm-admin] ${type} at ${lat.toFixed(5)},${lng.toFixed(5)} → ${
            found ? `"${found.properties?.name}"` : "none"
        }`,
    );
    return found;
};

/**
 * The border of the borough/ward the seeker is standing in — its outer ring
 * plus any interior rings. Undefined outside the play area.
 *
 * Note this is the seeker's OWN region only, not every border.
 */
export const gmRegionBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const region = await findGmRegion(type, lat, lng);
    if (!region) return undefined;

    const name = String(region.properties?.name ?? "?");
    const key = `${type}:${name}`;
    const cached = lineCache.get(key);
    if (cached) return cached;

    const simplified = turf.simplify(region, {
        tolerance: MEASURE_SIMPLIFY_TOLERANCE,
        highQuality: false,
    });
    const l = turf.polygonToLine(simplified);
    const lines = l.type === "FeatureCollection" ? l.features : [l];

    console.info(
        `[taibled:gm-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
