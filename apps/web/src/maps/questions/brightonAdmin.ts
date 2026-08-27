// ── Brighton bundled admin divisions ─────────────────────────────────────────
//
// The Brighton 29-08 game answers its admin questions entirely from bundled
// GeoJSON — no Overpass at play time. Two independent layers:
//   ward       24 ONS 2026 wards (Brighton & Hove plus edges of Lewes, Adur,
//              Mid Sussex and Horsham), plus "Outer"
//   postcode   8 BN districts, plus "Outer"
//
// Both start from the same lookup — the ONE region containing the seeker
// (findBrightonRegion), keyed by question type the way belgiumAdmin.ts and
// stockholmAdmin.ts do it:
//   matching   → that region's polygon
//   measuring  → that region's border ring (brightonRegionBorderLines)
//
// Measuring is scoped to the seeker's OWN region — the belgium-province /
// zurich-canton / graz-district / paris-arrondissement / milan-municipio
// behaviour. Deliberately NOT the london-borough all-divisions reading.
//
// ## "Outer"
//
// Both supplied layers were clipped to the ORIGINAL game area: the 24 wards
// tiled it exactly and the 8 postcodes covered 99.93% of it. The play area was
// then expanded to stop it clipping hiding zones (see gen-brighton-assets.py),
// so every square metre gained falls outside both layers, and the seafront
// already had postcode gaps. Each layer therefore carries one "Outer" region
// covering its leftovers — the Paris shape, and for the same reason: without it
// a seeker standing there could answer neither question.
//
// Outer is small and fragmented here, unlike Paris where it was nearly half the
// board — 48,163 m² in 24 parts for wards, 107,394 m² in 46 parts for
// postcodes, roughly 0.06% and 0.13% of the play area. No hiding zone sits in
// either: all 132 land in a real ward and a real postcode. It exists so the
// lookup always resolves, not because players will spend time there.
//
// ## Measuring balance, measured before shipping
//
// Across all 132 hiding zones, distance-to-own-border keeps:
//   postcode   mean 25.0% / median 22.7%  — the best-balanced admin measuring
//              of any bundled game. 8 coarse districts, Belgium-province-like.
//   ward       mean  5.4% / median  3.8%  — lopsided. 24 small wards averaging
//              3.4 km², so the band is narrow and the question eliminates ~95%
//              when true, i.e. it is rarely true. That is marginally tighter
//              than Stockholm's admin3 (6.5%), the most extreme figure shipped,
//              and is the OPPOSITE failure to belgium-arrondissement (96% kept,
//              eliminated almost nothing, and was cut). Unbalanced, not broken.
//              Shown to Jules and shipped deliberately; pinned by a test so the
//              figure is not later mistaken for an oversight.

import * as turf from "@turf/turf";

export const BRIGHTON_ADMIN_FILES: Record<string, string> = {
    "brighton-ward": "brighton-wards.geojson",
    "brighton-postcode": "brighton-postcodes.geojson",
};

export const BRIGHTON_ADMIN_LABELS: Record<string, string> = {
    "brighton-ward": "ward",
    "brighton-postcode": "postcode",
};

// Measuring buffers the border geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadBrightonAdminFC = async (type: string): Promise<any | undefined> => {
    const file = BRIGHTON_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:brighton-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/**
 * The bundled ward or postcode containing [lng, lat], or undefined outside the
 * play area. Inside it this always resolves: "Outer" covers whatever the
 * supplied layer does not.
 */
export const findBrightonRegion = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadBrightonAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the ward/postcode the seeker is standing in — its outer ring
 * plus any interior rings. Undefined outside the play area.
 *
 * Note this is the seeker's OWN region only, not every border.
 */
export const brightonRegionBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const region = await findBrightonRegion(type, lat, lng);
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
        `[taibled:brighton-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
