// ── Belgium bundled admin divisions ──────────────────────────────────────────
//
// The Belgium 01.08 game answers its admin-division questions entirely from
// bundled GeoJSON — no Overpass at play time. All assets come from OSM admin
// relations via scripts/gen-belgium-assets.py:
//   region         admin_level 4  (3:  Flanders, Wallonia, Brussels-Capital)
//   province       admin_level 6  (10, from the supplied 2nd Admin KML)
//   arrondissement admin_level 7  (43)
//
// The two question families need different things from these assets, so both
// live here rather than being repeated across the handlers:
//   matching   → the ONE division containing the seeker (findBelgiumAdminDivision)
//                — province and arrondissement
//   measuring  → EVERY border at that level (belgiumAdminBorderLines) — region
//
// Measuring deliberately uses all borders, not just the seeker's own division:
// "distance to a region border" means the nearest region border anywhere, so a
// seeker in Flanders is measured against the Wallonia and Brussels borders too.
//
// Only region has a border-distance question. The same thing at arrondissement
// level was tried and dropped: 43 divisions make a dense enough mesh that the
// band covers ~96% of Belgium, so the question eliminates ~4% and isn't worth
// asking. Region bands eliminate ~86%.

import * as turf from "@turf/turf";

export const BELGIUM_ADMIN_FILES: Record<string, string> = {
    "belgium-region": "belgium-regions.geojson",
    "belgium-province": "belgium-provinces.geojson",
    "belgium-arrondissement": "belgium-arrondissements.geojson",
};

export const BELGIUM_ADMIN_LABELS: Record<string, string> = {
    "belgium-region": "region",
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
 * Every border line at this admin level — each division's outer ring plus any
 * interior rings (Flanders' ring around the Brussels enclave, say). Shared
 * borders appear twice, which is harmless for distance.
 */
export const belgiumAdminBorderLines = async (
    type: string,
): Promise<any[] | undefined> => {
    const file = BELGIUM_ADMIN_FILES[type];
    if (!file) return undefined;

    const cached = lineCache.get(file);
    if (cached) return cached;

    const fc = await loadBelgiumAdminFC(type);
    if (!fc?.features?.length) return undefined;

    const lines = fc.features.flatMap((f: any) => {
        const simplified = turf.simplify(f, {
            tolerance: MEASURE_SIMPLIFY_TOLERANCE,
            highQuality: false,
        });
        const l = turf.polygonToLine(simplified);
        return l.type === "FeatureCollection" ? l.features : [l];
    });
    console.info(
        `[taibled:belgium-admin] ${type} → ${lines.length} border line(s) from ${fc.features.length} divisions`,
    );
    lineCache.set(file, lines);
    return lines;
};
