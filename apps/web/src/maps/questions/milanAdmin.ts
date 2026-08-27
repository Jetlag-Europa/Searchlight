// ── Milan bundled admin divisions ────────────────────────────────────────────
//
// The Milan 29-08 game answers its municipio questions entirely from bundled
// GeoJSON — no Overpass at play time:
//   municipio   the 9 Comune di Milano Municipi, plus 3 "Outer" catch-alls
//
// Both question families start from the same lookup — the ONE region containing
// the seeker (findMilanMunicipio):
//   matching   → that region's polygon
//   measuring  → that region's border ring (milanMunicipioBorderLines)
//
// Measuring is scoped to the seeker's OWN municipio, the belgium-province /
// zurich-canton / graz-district / paris-arrondissement behaviour: "distance to
// the municipio border" means the border of the one you are standing in. This is
// deliberately NOT the london-borough all-divisions reading — Jules has picked
// own-division every time he has been asked. Don't collapse the two.
//
// The three "Outer" regions are not administrative divisions: the Municipi cover
// only the comune, which is a fraction of a 12 km play circle, so the author
// split the remainder into North / Southeast / Southwest. Same call as Paris'
// single "Outer" region, and for the same reason — 65 of the 269 hiding zones
// sit outside the comune, and without them a quarter of the board would have no
// answer. Unlike Paris' Outer these have no holes: the Municipi are adjacent to
// them, not enclosed by them.
//
// Source is Comune di Milano Open Data (ds379 infogeo municipi), supplied as
// full-resolution polygons. Checked before trusting it: vertex spacing is
// non-uniform, so this is genuine source geometry rather than the resampled
// rings of Entries 44/49 — no Overpass re-pull was needed, as with Graz.
//
// The 12 regions tile the play area exactly — the generator asserts zero
// pairwise overlap (after removing 206 m² of source slivers), a 0.0000%
// symmetric difference against the boundary, and that all 269 hiding zones land
// in exactly one — so the lookup is unambiguous and always succeeds inside the
// map.
//
// Measuring is lopsided by design: across all 269 zones the "hider closer to
// their own border" answer keeps a mean of 10.5% / median 9.3% of them. That
// sits between Stockholm's admin2 (15.8%) and admin3 (6.5%), both of which were
// measured and shipped deliberately, and is nothing like the belgium-
// arrondissement failure that kept 96% and was cut. It eliminates a lot when
// true, which means it is rarely true — unbalanced, not broken. Recorded here
// and pinned by a test so nobody rediscovers the figure in six months and
// deletes the question thinking it was an oversight.

import * as turf from "@turf/turf";

export const MILAN_ADMIN_FILES: Record<string, string> = {
    "milan-municipio": "milan-municipi.geojson",
};

export const MILAN_ADMIN_LABELS: Record<string, string> = {
    "milan-municipio": "municipio",
};

// Measuring buffers the border geometry geodesically, which is slow over a
// full-resolution ring (see the zurich-canton note in measuring.ts). ~55 m is
// far below what a distance band needs.
const MEASURE_SIMPLIFY_TOLERANCE = 0.0005;

const fcCache = new Map<string, any>();
const lineCache = new Map<string, any[]>();

const loadMilanAdminFC = async (type: string): Promise<any | undefined> => {
    const file = MILAN_ADMIN_FILES[type];
    if (!file) return undefined;

    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:milan-admin] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/**
 * The bundled municipio containing [lng, lat], or undefined outside the play
 * area. Inside it this always resolves: the three "Outer" regions cover
 * everything that is not one of the 9 Municipi.
 */
export const findMilanMunicipio = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const fc = await loadMilanAdminFC(type);
    if (!fc?.features?.length) return undefined;
    const pt = turf.point([lng, lat]);
    return fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
};

/**
 * The border of the municipio the seeker is standing in.
 *
 * Note this is the seeker's OWN municipio only, not every border.
 */
export const milanMunicipioBorderLines = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any[] | undefined> => {
    const region = await findMilanMunicipio(type, lat, lng);
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
        `[taibled:milan-admin] ${type} → border of "${name}" (${lines.length} line(s))`,
    );
    lineCache.set(key, lines);
    return lines;
};
