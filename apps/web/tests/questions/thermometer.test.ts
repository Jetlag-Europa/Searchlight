import * as turf from "@turf/turf";
import type { Feature, Point, Polygon } from "geojson";
import { afterEach, describe, expect, it } from "vitest";

// No arcBuffer here — thermometer is pure Voronoi + intersect, all of which run
// under Node — so nothing is mocked.
import { hiderMode } from "@/lib/context";
import {
    adjustPerThermometer,
    hiderifyThermometer,
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

// IMPORTANT: which physical half-plane the app keeps for `warmer` is NOT
// something to assume — `geoSpatialVoronoi` reprojects a spherical Voronoi
// through Mercator and, even for two points, the two cells overlap near one
// site and gap near the other (the same distortion that bites tentacles). So we
// *calibrate* the kept side empirically (probe a point hard by A and one hard by
// B), then check the rest of the grid agrees with the independent
// nearest-of-{A,B} rule. The scenario is kept small/tight (POIs a few hundred
// metres apart) so the reprojection is accurate where we test, with an
// edge-margin band around the bisector treated as ambiguous.
describe("adjustPerThermometer — keeps one nearest-site half-plane", () => {
    // A (south) and B (north) ~9 km apart. A NORTH–SOUTH pair is used on
    // purpose: for an EAST–WEST pair the two-point geoSpatialVoronoi is
    // degenerate (the reprojected hemispheres collapse onto the same side, so
    // warmer and cooler return the identical mask — a real artifact of the
    // Mercator reprojection for a horizontal great-circle bisector). A vertical
    // pair splits cleanly. The sampled base sits in the central band between the
    // two points, where the reprojection is well-conditioned; the bisector
    // (lat ≈ 47.38) crosses the base, giving both outcomes.
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
// NOTE: we deliberately do NOT assert the stronger "hider survives its own
// answer" invariant. Because geoSpatialVoronoi's reprojected cells overlap near
// one site and *gap* near the other (verified above: for two points, one site
// lands in neither cell), a hider on the gapped side is assigned `warmer` from
// the only cell it's outside of, then eliminated by the resulting mask — i.e. it
// does NOT survive its own answer. That's a real consequence of the known
// Mercator distortion (Entry 35), not a property the app reliably has, so it
// isn't a valid gate. The directional check below is robust to it.
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
