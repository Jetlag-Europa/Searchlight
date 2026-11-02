import * as turf from "@turf/turf";
import type { Feature, Point, Polygon } from "geojson";
import { afterEach, describe, expect, it } from "vitest";

// No arcBuffer here — thermometer is pure Voronoi + intersect, all of which run
// under Node — so nothing is mocked.
import { hiderMode } from "@/lib/context";
import {
    adjustPerThermometer,
    hiderifyThermometer,
    thermometerPlanningPolygon,
} from "@/maps/questions/thermometer";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";
import { failuresToBad, renderDebugSVG } from "./debugRender";

afterEach(() => hiderMode.set(false));

function thermoQuestion(
    a: [number, number],
    b: [number, number],
    warmer: boolean,
) {
    return {
        latA: a[1],
        lngA: a[0],
        latB: b[1],
        lngB: b[0],
        warmer,
        colorA: "red" as const,
        colorB: "blue" as const,
        drag: true as const,
        collapsed: false,
        enabled: true,
    };
}

function maskFor(
    base: Feature<Polygon>,
    a: [number, number],
    b: [number, number],
    warmer: boolean,
) {
    return adjustPerThermometer(
        thermoQuestion(a, b, warmer) as never,
        turf.featureCollection([base]),
    ) as Feature<Polygon> | null;
}

// Which physical half-plane the app keeps for `warmer` is *calibrated*
// empirically here (probe a point hard by A and one hard by B), then the rest of
// the grid is checked against the independent nearest-of-{A,B} rule, with an
// edge-margin band around the bisector treated as ambiguous. The calibration,
// the small scenario and the wide band date from when `geoSpatialVoronoi`
// reprojected a spherical Voronoi through Mercator, so that even for two points
// the cells overlapped near one site and gapped near the other. The cells are
// now exact on the sphere: the east–west tests below assert the kept side and
// hold the cells to a far narrower band.
describe("adjustPerThermometer — keeps one nearest-site half-plane", () => {
    // A (south) and B (north) ~9 km apart. A NORTH–SOUTH pair, as under the
    // old Mercator reprojection an EAST–WEST pair was degenerate (warmer and
    // cooler returned the identical mask); the east–west tests below check that
    // it now splits cleanly. The sampled base sits in the central band between
    // the two points; the bisector (lat ≈ 47.38) crosses the base, giving both
    // outcomes.
    const a: [number, number] = [8.55, 47.34];
    const b: [number, number] = [8.55, 47.42];
    const base = boundary(8.52, 47.36, 8.58, 47.4);
    const bisectorMargin = 0.35; // km band around the equidistant line → ambiguous

    function keptNearestSite(warmer: boolean): "A" | "B" {
        const mask = maskFor(base, a, b, warmer)!;
        const nearA = turf.point([8.55, 47.362]);
        const nearB = turf.point([8.55, 47.398]);
        const inA = turf.booleanPointInPolygon(nearA, mask);
        const inB = turf.booleanPointInPolygon(nearB, mask);
        // Exactly one extreme side must be kept — a genuine structural check.
        expect(inA).not.toBe(inB);
        return inA ? "A" : "B";
    }

    const verdictFor =
        (kept: "A" | "B") =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const dA = turf.distance(pt, turf.point(a));
            const dB = turf.distance(pt, turf.point(b));
            if (Math.abs(dA - dB) <= bisectorMargin) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const nearest = dA < dB ? "A" : "B";
            return inBase && nearest === kept ? "survives" : "eliminated";
        };

    it("warmer: kept half-plane agrees with the nearest-site oracle", () => {
        const kept = keptNearestSite(true);
        const mask = maskFor(base, a, b, true);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(kept));
        if (r.failures.length)
            renderDebugSVG("thermometer-warmer", {
                base,
                mask,
                sites: [turf.point(a, { name: "A" }), turf.point(b, { name: "B" })],
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("cooler keeps the opposite half-plane to warmer", () => {
        expect(keptNearestSite(false)).not.toBe(keptNearestSite(true));
    });

    it("cooler: kept half-plane agrees with the nearest-site oracle", () => {
        const kept = keptNearestSite(false);
        const mask = maskFor(base, a, b, false);
        const r = gridAgreement(mask, sampleGrid(base, 40), verdictFor(kept));
        if (r.failures.length)
            renderDebugSVG("thermometer-cooler", {
                base,
                mask,
                sites: [turf.point(a, { name: "A" }), turf.point(b, { name: "B" })],
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("invariant: area ≤ base for both directions", () => {
        expect(turf.area(maskFor(base, a, b, true)!)).toBeLessThanOrEqual(
            turf.area(base),
        );
        expect(turf.area(maskFor(base, a, b, false)!)).toBeLessThanOrEqual(
            turf.area(base),
        );
    });
});

// Directional consistency of the hider inference. A hider clearly on A's side
// and one clearly on B's side must resolve to opposite `warmer` values.
//
// The stronger "hider survives its own answer" invariant used to fail: the old
// Mercator-reprojected cells overlapped near one site and *gapped* near the
// other (Entry 35), so a hider in the gap was assigned `warmer` from the only
// cell it was outside of, then eliminated by the resulting mask. With exact
// cells it holds, and the east–west tests below check it.
describe("hiderifyThermometer — opposite sides resolve to opposite warmer", () => {
    const a: [number, number] = [8.55, 47.34];
    const b: [number, number] = [8.55, 47.42];

    function warmerForHider(lat: number): boolean {
        hiderMode.set({ latitude: lat, longitude: 8.55 } as never);
        return (
            hiderifyThermometer(thermoQuestion(a, b, true) as never) as {
                warmer: boolean;
            }
        ).warmer;
    }

    it("a hider on A's side and one on B's side give opposite values", () => {
        // One clearly south (A), one clearly north (B).
        expect(warmerForHider(47.35)).not.toBe(warmerForHider(47.41));
    });
});

// An EAST–WEST pair, A (west) and B (east) ~7.5 km apart on one parallel, so
// the bisector is the meridian between them. Warmer means the hider is now
// nearer B.
describe("thermometer — east–west pair with exact cells", () => {
    const a: [number, number] = [8.5, 47.38];
    const b: [number, number] = [8.6, 47.38];
    const base = boundary(8.45, 47.33, 8.65, 47.43);
    // Points whose distances to A and B differ by at most 1 m are ambiguous.
    const bisectorMargin = 0.001;

    const verdictFor =
        (warmer: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const dA = turf.distance(pt, turf.point(a));
            const dB = turf.distance(pt, turf.point(b));
            if (Math.abs(dA - dB) <= bisectorMargin) return "ambiguous";
            return dB < dA === warmer ? "survives" : "eliminated";
        };

    for (const warmer of [true, false]) {
        it(`${warmer ? "warmer keeps B's" : "cooler keeps A's"} side, up to 1 m from the bisector`, () => {
            const mask = maskFor(base, a, b, warmer);
            const r = gridAgreement(
                mask,
                sampleGrid(base, 40),
                verdictFor(warmer),
            );
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(100);
            expect(r.eliminated).toBeGreaterThan(100);
        });
    }

    it("a hider survives its own answer", () => {
        let checked = 0;
        for (const hider of sampleGrid(base, 20)) {
            const [longitude, latitude] = hider.geometry.coordinates;
            const dA = turf.distance(hider, turf.point(a));
            const dB = turf.distance(hider, turf.point(b));
            if (Math.abs(dA - dB) <= bisectorMargin) continue;
            hiderMode.set({ latitude, longitude } as never);
            const question = hiderifyThermometer(
                thermoQuestion(a, b, dB >= dA) as never,
            ) as ReturnType<typeof thermoQuestion>;
            expect(question.warmer).toBe(dB < dA);
            const mask = maskFor(base, a, b, question.warmer);
            expect(turf.booleanPointInPolygon(hider, mask!)).toBe(true);
            checked++;
        }
        expect(checked).toBeGreaterThan(400);
    });
});

// B dragged onto A: the hider's distance cannot have changed, so they are
// neither warmer nor colder.
describe("thermometer — A and B in the same place", () => {
    const a: [number, number] = [8.55, 47.38];
    const base = boundary(8.52, 47.36, 8.58, 47.4);

    it("eliminates nothing, keeps the hider's answer and draws no boundary", () => {
        const mapData = turf.featureCollection([base]);
        hiderMode.set({ latitude: 47.39, longitude: 8.56 } as never);
        for (const warmer of [true, false]) {
            const question = thermoQuestion(a, a, warmer);
            expect(adjustPerThermometer(question as never, mapData)).toBe(
                mapData,
            );
            expect(
                (
                    hiderifyThermometer({ ...question } as never) as {
                        warmer: boolean;
                    }
                ).warmer,
            ).toBe(warmer);
            expect(
                thermometerPlanningPolygon(question as never).features,
            ).toEqual([]);
        }
    });
});
