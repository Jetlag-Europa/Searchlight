import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, describe, expect, it, vi } from "vitest";

// `arcBufferToPoint` uses @arcgis/core's WASM geodesic operators (no Node). It
// computes the min geodesic distance from the target geometry to the seeker,
// then buffers the target by that distance — i.e. the surviving region is "all
// points within (seeker→nearest-target distance) of ANY target". We stub it with
// the faithful turf equivalent and keep the real modifyMapData under test.
// DEFAULT_BUFFER_UNIT in the real helper is miles, so distances here are miles.
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof import("@/maps/geo-utils")>();
    return {
        ...actual,
        arcBufferToPoint: async (
            fc: FeatureCollection,
            lat: number,
            lng: number,
        ) => {
            const seeker = turf.point([lng, lat]);
            const verts = turf.explode(fc);
            let min = Infinity;
            turf.featureEach(verts, (p) => {
                const d = turf.distance(seeker, p, { units: "miles" });
                if (d < min) min = d;
            });
            const buffered = turf.buffer(fc, min, {
                units: "miles",
            }) as FeatureCollection<Polygon>;
            // The real helper unions everything into one feature; turf.union
            // needs ≥2 geometries, so short-circuit the single-feature case.
            return buffered.features.length < 2
                ? buffered.features[0]
                : turf.union(buffered as never);
        },
    };
});

import { hiderMode, mapGeoJSON } from "@/lib/context";
import { adjustPerMeasuring } from "@/maps/questions/measuring";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";
import { failuresToBad, renderDebugSVG } from "./debugRender";

afterEach(() => hiderMode.set(false));

const MI = { units: "miles" as const };

function poi(name: string, lng: number, lat: number): Feature<Point> {
    return turf.point([lng, lat], { name });
}

function measuringQuestion(
    seeker: [number, number],
    pois: Feature<Point>[],
    hiderCloser: boolean,
) {
    return {
        type: "custom-measure",
        lat: seeker[1],
        lng: seeker[0],
        hiderCloser,
        geo: turf.featureCollection(pois),
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

async function maskFor(
    base: Feature<Polygon>,
    seeker: [number, number],
    pois: Feature<Point>[],
    hiderCloser: boolean,
) {
    // determineMeasuringBoundary reads mapGeoJSON for a bbox before switching on
    // the question type, so it must be populated.
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        measuringQuestion(seeker, pois, hiderCloser) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe("adjustPerMeasuring — distance-to-nearest-POI bands", () => {
    const base = boundary(8.45, 47.33, 8.65, 47.45);
    const seeker: [number, number] = [8.55, 47.38];
    const pois = [
        poi("P1", 8.52, 47.37),
        poi("P2", 8.58, 47.39),
        poi("P3", 8.55, 47.41),
    ];
    // d_min = seeker's distance to its nearest POI; the kept circles have this
    // radius around each POI.
    const seekerPt = turf.point(seeker);
    const dMin = Math.min(
        ...pois.map((p) => turf.distance(seekerPt, p, MI)),
    );

    function nearestPoiDist(pt: Feature<Point>): number {
        return Math.min(...pois.map((p) => turf.distance(pt, p, MI)));
    }

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = nearestPoiDist(pt);
            // Near a circle edge (nearest-POI distance ≈ d_min) → ambiguous.
            if (Math.abs(d - dMin) <= dMin * 0.05) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const closer = d <= dMin; // within d_min of some POI
            const kept = hiderCloser ? closer : !closer;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("hiderCloser: keeps points within d_min of a POI", async () => {
        const mask = await maskFor(base, seeker, pois, true);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(true));
        if (r.failures.length)
            renderDebugSVG("measuring-closer", {
                base,
                mask,
                sites: pois,
                hider: seeker,
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("!hiderCloser: keeps points beyond d_min of every POI", async () => {
        const mask = await maskFor(base, seeker, pois, false);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(false));
        if (r.failures.length)
            renderDebugSVG("measuring-farther", {
                base,
                mask,
                sites: pois,
                hider: seeker,
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("invariant: area ≤ base for both directions", async () => {
        expect(
            turf.area((await maskFor(base, seeker, pois, true))!),
        ).toBeLessThanOrEqual(turf.area(base));
        expect(
            turf.area((await maskFor(base, seeker, pois, false))!),
        ).toBeLessThanOrEqual(turf.area(base));
    });
});
