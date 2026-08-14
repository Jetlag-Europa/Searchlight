// ── Stockholm bundled admin divisions ────────────────────────────────────────
//
// The Stockholm 15-08 game answers its admin-division questions entirely from
// bundled GeoJSON — no Overpass at play time. All three levels come from the
// supplied KMZ via scripts/gen-stockholm-assets.py:
//   admin1   3 divisions   South / North-West / North-East
//   admin2   9 divisions   Innerstan, Västerort, Söderort East/West, Lidingö, …
//   admin3  25 divisions   14 kommuner (OSM level 7) + 11 Stockholm
//                          stadsdelsområden (level 9)
//
// These are the map author's own groupings, not clean OSM admin levels — which
// is why they are numbered rather than named after a Swedish division type.
// They do nest (each child is ≥99.9% inside one parent, asserted by the
// generator) and each level covers the whole play area.
//
// Both question families start from the same lookup — the ONE division
// containing the seeker (findStockholmAdminDivision):
//   matching   → that division's polygon
//   measuring  → that division's border ring (stockholmAdminDivisionBorderLines)
//
// Measuring is scoped to the seeker's OWN division at every level, the
// belgium-province / graz-district / paris-arrondissement behaviour. This is
// deliberately NOT the london-borough all-borders reading. Don't collapse them.
//
// All three levels get BOTH families — including admin3, and that was a
// considered call. Measured before building (the Entry 44 check that killed
// belgium-arrondissement measuring), distance-to-own-border keeps 35.8% / 15.8%
// / 6.5% of the 191 hiding zones at levels 1 / 2 / 3. Level 3 is lopsided: it
// eliminates ~93% when true, so it is rarely true. Jules was shown those
// numbers and chose to ship all three anyway. It is unbalanced, not broken —
// don't "discover" the 6.5% later and delete it.
//
// The divisions tile exactly (the generator trims the one overlapping pair at
// levels 1 and 2, then asserts zero pairwise overlap, and that all 191 hiding
// zones land in exactly one division at every level), so the lookup is
// unambiguous inside the play area.

import * as turf from "@turf/turf";

export const STOCKHOLM_ADMIN_FILES: Record<string, string> = {
    "stockholm-admin1": "stockholm-admin1.geojson",
    "stockholm-admin2": "stockholm-admin2.geojson",
    "stockholm-admin3": "stockholm-admin3.geojson",
};

export const STOCKHOLM_ADMIN_LABELS: Record<string, string> = {
    "stockholm-admin1": "1st admin division",
    "stockholm-admin2": "2nd admin division",
    "stockholm-admin3": "3rd admin division",
};

// Measuring buffers the border geometry geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadStockholmAdminFC = async (type: string): Promise<any | undefined> => {
    const file = STOCKHOLM_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:stockholm-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/** The bundled division containing [lng, lat], or undefined outside the map. */
export const findStockholmAdminDivision = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadStockholmAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the division the seeker is standing in — its outer ring plus
 * any interior rings. Undefined if the point falls outside the play area.
 *
 * Note this is the seeker's OWN division only, not every border at the level.
 */
export const stockholmAdminDivisionBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const division = await findStockholmAdminDivision(type, lat, lng);
    if (!division) return undefined;

    const name = String(division.properties?.name ?? "?");
    const key = `${type}:${name}`;
    const cached = lineCache.get(key);
    if (cached) return cached;

    const simplified = turf.simplify(division, {
        tolerance: MEASURE_SIMPLIFY_TOLERANCE,
        highQuality: false,
    });
    const l = turf.polygonToLine(simplified);
    const lines = l.type === "FeatureCollection" ? l.features : [l];

    console.info(
        `[taibled:stockholm-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
