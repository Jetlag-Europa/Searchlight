import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, describe, expect, it, vi } from "vitest";

// `arcBuffer` builds the radius circle via @arcgis/core's WASM geodesic-buffer
// operator, which can't load under Node/Vitest. A geodesic buffer is exactly
// "all points within `radius` geodesic distance of the centre", which
// `turf.buffer` produces — so we swap it in and keep the real `modifyMapData`
// (safeUnion / intersect / holedMask) under test. Mirrors the tentacle harness.
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof import("@/maps/geo-utils")>();
    return {
        ...actual,
        arcBuffer: async (
            fc: FeatureCollection<Point>,
            radius: number,
            unit: turf.Units,
        ) => turf.buffer(fc.features[0], radius, { units: unit }),
    };
});

import { hiderMode } from "@/lib/context";
import { adjustPerRadius, hiderifyRadius } from "@/maps/questions/radius";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";
import { failuresToBad, renderDebugSVG } from "./debugRender";

afterEach(() => hiderMode.set(false));

// adjustPerRadius takes the inner question data + the base map FeatureCollection.
function radiusQuestion(
    seeker: [number, number],
    radius: number,
    unit: turf.Units,
    within: boolean,
) {
    return {
        lat: seeker[1],
        lng: seeker[0],
        radius,
        unit,
        within,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

async function maskFor(
    base: Feature<Polygon>,
    seeker: [number, number],
    radius: number,
    unit: turf.Units,
    within: boolean,
) {
    return (await adjustPerRadius(
        radiusQuestion(seeker, radius, unit, within) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe("adjustPerRadius — within (base ∩ circle)", () => {
    const base = boundary(8.5, 47.35, 8.6, 47.4);
    const seeker: [number, number] = [8.55, 47.375];
    const radius = 2;
    const unit: turf.Units = "kilometers";

    it("agrees with the oracle: survive iff in base ∧ within radius", async () => {
        const mask = await maskFor(base, seeker, radius, unit, true);
        const seekerPt = turf.point(seeker);
        const margin = radius * 0.04; // ~80 m around the circle edge is ambiguous
        const verdict = (pt: Feature<Point>) => {
            const d = turf.distance(seekerPt, pt, { units: unit });
            if (Math.abs(d - radius) <= margin) return "ambiguous" as const;
            const inBase = turf.booleanPointInPolygon(pt, base);
            return inBase && d < radius
                ? ("survives" as const)
                : ("eliminated" as const);
        };
        const r = gridAgreement(mask, sampleGrid(base, 36), verdict);
        if (r.failures.length)
            renderDebugSVG("radius-within", {
                base,
                mask,
                hider: seeker,
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("invariant: the within-mask never exceeds the circle and area ≤ base", async () => {
        const mask = await maskFor(base, seeker, radius, unit, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
        const seekerPt = turf.point(seeker);
        turf.coordEach(mask!, (c) => {
            const d = turf.distance(seekerPt, turf.point(c as [number, number]), {
                units: unit,
            });
            expect(d).toBeLessThanOrEqual(radius * 1.02);
        });
    });
});

describe("adjustPerRadius — outside (base − circle)", () => {
    const base = boundary(8.5, 47.35, 8.6, 47.4);
    const seeker: [number, number] = [8.55, 47.375];
    const radius = 2;
    const unit: turf.Units = "kilometers";

    it("agrees with the oracle: survive iff in base ∧ outside radius", async () => {
        const mask = await maskFor(base, seeker, radius, unit, false);
        const seekerPt = turf.point(seeker);
        const margin = radius * 0.04;
        const verdict = (pt: Feature<Point>) => {
            const d = turf.distance(seekerPt, pt, { units: unit });
            if (Math.abs(d - radius) <= margin) return "ambiguous" as const;
            const inBase = turf.booleanPointInPolygon(pt, base);
            return inBase && d > radius
                ? ("survives" as const)
                : ("eliminated" as const);
        };
        const r = gridAgreement(mask, sampleGrid(base, 36), verdict);
        if (r.failures.length)
            renderDebugSVG("radius-outside", {
                base,
                mask,
                hider: seeker,
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });
});

describe("hiderifyRadius — sets within from the hider's distance", () => {
    const base = boundary(8.5, 47.35, 8.6, 47.4);
    const seeker: [number, number] = [8.55, 47.375];
    const radius = 2;
    const unit: turf.Units = "kilometers";

    it("hider inside the radius ⇒ within = true", () => {
        hiderMode.set({ latitude: 47.378, longitude: 8.553 } as never);
        const q = hiderifyRadius(
            radiusQuestion(seeker, radius, unit, false) as never,
        );
        expect(q.within).toBe(true);
    });

    it("hider outside the radius ⇒ within = false", () => {
        hiderMode.set({ latitude: 47.4, longitude: 8.6 } as never);
        const q = hiderifyRadius(
            radiusQuestion(seeker, radius, unit, true) as never,
        );
        expect(q.within).toBe(false);
    });
});
