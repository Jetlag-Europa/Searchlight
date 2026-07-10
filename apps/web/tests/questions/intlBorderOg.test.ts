import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same faithful stub for arcBufferToPoint as measuring.test.ts: surviving region
// is "all points within (seeker→nearest-target distance) of the target". The
// border is densified below so vertex-nearest ≈ line-nearest and the stub is
// accurate for a LineString target. Distances are miles (DEFAULT_BUFFER_UNIT).
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
            return buffered.features.length < 2
                ? buffered.features[0]
                : turf.union(buffered as never);
        },
    };
});

// Force the bundled-asset path: an active game whose sentinel maps to a bundled
// international-border file. The fetch stub below supplies the line.
vi.mock("@/lib/games", () => ({
    currentGameId: { get: () => "south-limburg" },
    getGameById: () => ({ sentinelValue: "__bundled-south-limburg-2026__" }),
}));

import { hiderMode, mapGeoJSON } from "@/lib/context";
import { adjustPerMeasuring } from "@/maps/questions/measuring";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const MI = { units: "miles" as const };

// A densified ~N-S border line near the middle of the base (so vertex-nearest is
// a faithful proxy for distance-to-line).
const BORDER_LNG = 8.55;
const border = turf.lineString(
    Array.from({ length: 200 }, (_, i) => [
        BORDER_LNG,
        47.33 + (47.45 - 47.33) * (i / 199),
    ]),
    { name: "Test border" },
);
const borderFC = turf.featureCollection([border]);

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ json: async () => borderFC })),
    );
});
afterEach(() => {
    hiderMode.set(false);
    vi.unstubAllGlobals();
});

function question(seeker: [number, number], hiderCloser: boolean) {
    return {
        type: "international-border-og",
        lat: seeker[1],
        lng: seeker[0],
        hiderCloser,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

async function maskFor(
    base: Feature<Polygon>,
    seeker: [number, number],
    hiderCloser: boolean,
) {
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        question(seeker, hiderCloser) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe("adjustPerMeasuring — international-border-og (bundled line)", () => {
    const base = boundary(8.45, 47.33, 8.65, 47.45);
    const seeker: [number, number] = [8.52, 47.38]; // west of the border
    const seekerPt = turf.point(seeker);
    // Seeker's distance to the border = its radius for the kept band.
    const dMin = turf.pointToLineDistance(seekerPt, border, MI);

    function distToBorder(pt: Feature<Point>): number {
        return turf.pointToLineDistance(pt, border, MI);
    }

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distToBorder(pt);
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const closer = d <= dMin;
            const kept = hiderCloser ? closer : !closer;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("hiderCloser: keeps a band within d_min of the border", async () => {
        const mask = await maskFor(base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("!hiderCloser: keeps points beyond d_min of the border", async () => {
        const mask = await maskFor(base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("invariant: mask area ≤ base for both directions", async () => {
        expect(
            turf.area((await maskFor(base, seeker, true))!),
        ).toBeLessThanOrEqual(turf.area(base));
        expect(
            turf.area((await maskFor(base, seeker, false))!),
        ).toBeLessThanOrEqual(turf.area(base));
    });
});
