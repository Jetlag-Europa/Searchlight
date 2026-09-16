// ── North London bundled regions and water ───────────────────────────────────
//
// The North London 26-09 game answers these from bundled GeoJSON, no Overpass
// at play time (see scripts/gen-north-london-assets.py):
//   constituency   12 parliamentary constituencies (1st admin) + "Outer"
//   ward           78 council wards (2nd admin) + "Outer"
//   water          OSM water edges and canal lines across Greater London
//
// Matching looks up the ONE region containing the seeker (findNlRegion).
// Measuring is to EVERY border — the london-borough reading, Jules' call — so it
// reads the deduped border networks through the bundled-line path in
// measuring.ts, not the seeker's own ring.
//
// ## "Outer"
//
// The play area is all of Greater London (1,582 km²) but the supplied layers
// cover only 127 km² (constituencies) and 78 km² (wards) around the hiding
// zones. "Outer" is the rest, so a seeker anywhere in the play area still
// resolves to a region. All 56 hiding zones are inside a real region, so Outer
// only ever matters as "the seeker is not in any supplied region". It is not
// part of the border networks.
//
// ## Water, and why it is filtered before buffering
//
// The water network is ~700 KB of edges. Measuring buffers it geodetically
// (arcBufferToPoint), which is far too slow over all of it. But only water
// within d of a hiding zone can change which zones survive, where d is the
// seeker's distance to the nearest water. So nlWaterLines keeps just the
// features whose bbox reaches the hiding-zone bbox grown by d — plus the
// seeker's nearest feature, so arcBufferToPoint still finds the same d. The
// result is exact inside every hiding zone; shading far outside them may be
// incomplete, which no question ever reads.

import * as turf from "@turf/turf";

import { trainStations } from "@/lib/context";

export const NL_REGION_FILES: Record<string, string> = {
    "nl-constituency": "nl-constituencies.geojson",
    "nl-ward": "nl-wards.geojson",
};

export const NL_LINE_FILES: Record<string, string> = {
    "nl-constituency": "nl-constituency-lines.geojson",
    "nl-ward": "nl-ward-lines.geojson",
    "nl-hsl": "nl-hsl.geojson",
    "nl-water": "nl-water.geojson",
};

const fcCache = new Map<string, any>();

const loadFC = async (file: string): Promise<any> => {
    let fc = fcCache.get(file);
    if (!fc) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        fc = await res.json();
        fcCache.set(file, fc);
        console.info(
            `[taibled:nl] loaded ${file} → ${fc.features?.length ?? 0} features`,
        );
    }
    return fc;
};

/**
 * The bundled constituency / ward containing [lng, lat] ("Outer" when it is in
 * Greater London but no supplied region), or undefined outside Greater London.
 */
export const findNlRegion = async (
    type: string,
    lat: number,
    lng: number,
): Promise<any | undefined> => {
    const file = NL_REGION_FILES[type];
    if (!file) return undefined;
    const fc = await loadFC(file);
    const pt = turf.point([lng, lat]);
    const found = fc.features?.find((f: any) => turf.booleanPointInPolygon(pt, f));
    console.info(
        `[taibled:nl] ${type} at ${lat.toFixed(5)},${lng.toFixed(5)} → ${
            found ? `"${found.properties?.name}"` : "none"
        }`,
    );
    return found;
};

/** The bundled line features a measuring question measures against. */
export const nlLines = async (type: string): Promise<any[]> => {
    const file = NL_LINE_FILES[type];
    if (!file) return [];
    return (await loadFC(file)).features ?? [];
};

/**
 * The water features that can affect the hiding zones for a seeker at
 * [lng, lat] — see the header comment. Falls back to every feature when no
 * hiding zones are loaded.
 */
export const nlWaterLines = async (lat: number, lng: number): Promise<any[]> => {
    const all = await nlLines("nl-water");
    if (!all.length) return all;

    const seeker = turf.point([lng, lat]);
    let nearest = all[0];
    let d = Infinity;
    for (const f of all) {
        const fd = turf.pointToLineDistance(seeker, f, { units: "kilometers" });
        if (fd < d) {
            d = fd;
            nearest = f;
        }
    }

    const zones = trainStations.get();
    if (!zones.length) {
        console.warn("[taibled:nl] water: no hiding zones loaded, buffering all water");
        return all;
    }
    const [w, s, e, n] = turf.bbox(turf.featureCollection(zones as any));
    const pad = d * 1.05 + 0.05; // km, with slack for the flat-degree conversion
    const dLat = pad / 110.574;
    const dLng = pad / (111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180));
    const box = [w - dLng, s - dLat, e + dLng, n + dLat];

    const kept = all.filter((f: any) => {
        if (f === nearest) return true;
        const [fw, fs, fe, fn] = turf.bbox(f);
        return !(fe < box[0] || fw > box[2] || fn < box[1] || fs > box[3]);
    });
    console.info(
        `[taibled:nl] water: seeker ${d.toFixed(3)} km from water → ${kept.length}/${all.length} features near the zones`,
    );
    return kept;
};
