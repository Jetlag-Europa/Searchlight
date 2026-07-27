// ── Belgium bundled admin divisions ──────────────────────────────────────────
//
// The Belgium 01.08 game answers its admin-division questions entirely from
// bundled GeoJSON — no Overpass at play time. All assets come from OSM admin
// relations via scripts/gen-belgium-assets.py:
//   region         admin_level 4  (3:  Flanders, Wallonia, Brussels-Capital)
//   province       admin_level 6  (10, from the supplied 2nd Admin KML)
//   arrondissement admin_level 7  (43)
//
// Both question families start from the same lookup — the ONE division
// containing the seeker (findBelgiumAdminDivision):
//   matching   → that division's polygon        — province and arrondissement
//   measuring  → that division's border ring    — province
//                (belgiumAdminDivisionBorderLines)
//
// Measuring is deliberately scoped to the seeker's OWN division, matching the
// zurich-canton behaviour: "distance to the province border" means the border
// of the province you are standing in. An all-borders variant (nearest border
// of any division, anywhere) was tried and removed — it did not play well.
//
// Only province has a border-distance question. The same thing at
// arrondissement level was measured and dropped: 43 divisions make a dense
// enough mesh that the band covers ~96% of Belgium, so the question eliminates
// ~4% and isn't worth asking.

import * as turf from "@turf/turf";

export const BELGIUM_ADMIN_FILES: Record<string, string> = {
    "belgium-province": "belgium-provinces.geojson",
    "belgium-arrondissement": "belgium-arrondissements.geojson",
};

export const BELGIUM_ADMIN_LABELS: Record<string, string> = {
    "belgium-province": "province",
    "belgium-arrondissement": "arrondissement",
};

// Measuring buffers the border geometry geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadBelgiumAdminFC = async (type: string): Promise<any | undefined> => {
    const file = BELGIUM_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:belgium-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/** The bundled division containing [lng, lat], or undefined outside Belgium. */
export const findBelgiumAdminDivision = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadBelgiumAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the division the seeker is standing in — its outer ring plus
 * any interior rings (a province's ring around an enclave, say). Undefined if
 * the point falls outside every division.
 *
 * Note this is the seeker's OWN division only, not every border at the level.
 */
export const belgiumAdminDivisionBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const division = await findBelgiumAdminDivision(type, lat, lng);
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
        `[taibled:belgium-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
