// ── Paris bundled admin divisions ────────────────────────────────────────────
//
// The Paris 15-08 game answers its arrondissement questions entirely from
// bundled GeoJSON — no Overpass at play time:
//   arrondissement  the 20 Paris arrondissements, plus "Outer"
//
// Both question families start from the same lookup — the ONE region containing
// the seeker (findParisArrondissement):
//   matching   → that region's polygon
//   measuring  → that region's border ring (parisArrondissementBorderLines)
//
// Measuring is scoped to the seeker's OWN arrondissement, the belgium-province /
// zurich-canton / graz-district behaviour: "distance to the arrondissement
// border" means the border of the one you are standing in. This is deliberately
// NOT the london-borough all-boroughs reading — Jules picked own-division here,
// as he has every time he has been asked. Don't collapse the two.
//
// "Outer" is not an administrative division: it is the play-area rectangle with
// Paris punched out as a hole, covering everything beyond the city limits. It is
// a first-class 21st region on purpose (Jules' call). 186 of the 412 hiding
// zones sit out there, so without it the questions would be unanswerable for
// nearly half the board; with it, two hiders both outside the city match, and
// measuring gives them the distance to the city limits (or the map edge).
//
// The 21 regions tile the play area exactly — the generator asserts zero
// pairwise overlap, a 0.0000% symmetric difference against the boundary, and
// that all 412 hiding zones land in exactly one — so the lookup is unambiguous
// and always succeeds inside the map.

import * as turf from "@turf/turf";

export const PARIS_ADMIN_FILES: Record<string, string> = {
    "paris-arrondissement": "paris-arrondissements.geojson",
};

export const PARIS_ADMIN_LABELS: Record<string, string> = {
    "paris-arrondissement": "arrondissement",
};

// Measuring buffers the border geometry geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadParisAdminFC = async (type: string): Promise<any | undefined> => {
    const file = PARIS_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:paris-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/**
 * The bundled arrondissement containing [lng, lat], or undefined outside the
 * play area. Inside it this always resolves: "Outer" covers everything that is
 * not one of the 20.
 */
export const findParisArrondissement = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadParisAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the arrondissement the seeker is standing in — its outer ring
 * plus any interior rings. Undefined if the point falls outside the play area.
 *
 * Note this is the seeker's OWN arrondissement only, not every border.
 *
 * For "Outer" the interior ring matters: that region is the map rectangle with
 * Paris removed, so its border is the city limits AND the map edge. Both are
 * returned, which is the honest answer — a seeker in the near suburbs is
 * genuinely close to the Paris boundary.
 */
export const parisArrondissementBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const region = await findParisArrondissement(type, lat, lng);
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
        `[taibled:paris-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
