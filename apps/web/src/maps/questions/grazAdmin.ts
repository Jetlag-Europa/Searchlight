// ── Graz bundled admin divisions ─────────────────────────────────────────────
//
// The Graz 08-08 game answers its district questions entirely from bundled
// GeoJSON — no Overpass at play time:
//   district  admin_level 9  (17 Bezirke, from the supplied feature map's
//                             "Administrative divisions" folder)
//
// Both question families start from the same lookup — the ONE district
// containing the seeker (findGrazDistrict):
//   matching   → that district's polygon
//   measuring  → that district's border ring (grazDistrictBorderLines)
//
// Measuring is scoped to the seeker's OWN district, the belgium-province /
// zurich-canton behaviour: "distance to the district border" means the border
// of the district you are standing in. This is deliberately NOT the
// london-borough all-boroughs reading — Jules picked own-division here, as he
// did for Belgium after playing both. Don't collapse the two.
//
// The 17 districts tile the city exactly (the generator asserts zero pairwise
// overlap, and that all 174 hiding zones land in one), so the lookup is
// unambiguous.

import * as turf from "@turf/turf";

export const GRAZ_ADMIN_FILES: Record<string, string> = {
    "graz-district": "graz-districts.geojson",
};

export const GRAZ_ADMIN_LABELS: Record<string, string> = {
    "graz-district": "district",
};

// Measuring buffers the border geometry geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadGrazAdminFC = async (type: string): Promise<any | undefined> => {
    const file = GRAZ_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:graz-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/** The bundled district containing [lng, lat], or undefined outside Graz. */
export const findGrazDistrict = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadGrazAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the district the seeker is standing in — its outer ring plus
 * any interior rings. Undefined if the point falls outside every district.
 *
 * Note this is the seeker's OWN district only, not every border at the level.
 */
export const grazDistrictBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const district = await findGrazDistrict(type, lat, lng);
    if (!district) return undefined;

    const name = String(district.properties?.name ?? "?");
    const key = `${type}:${name}`;
    const cached = lineCache.get(key);
    if (cached) return cached;

    const simplified = turf.simplify(district, {
        tolerance: MEASURE_SIMPLIFY_TOLERANCE,
        highQuality: false,
    });
    const l = turf.polygonToLine(simplified);
    const lines = l.type === "FeatureCollection" ? l.features : [l];

    console.info(
        `[taibled:graz-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
