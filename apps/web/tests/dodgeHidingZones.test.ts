import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

/**
 * Regression for "DissapearingAct": a hider may move within their hiding zone, so
 * a zone is valid as long as it overlaps EACH question's still-possible region
 * INDEPENDENTLY (the hider can dodge each question from a different edge of the
 * same zone). The old logic intersected all questions into one combined area and
 * required a single point to satisfy every question at once, which wiped out
 * dodgeable zones.
 *
 * These tests exercise the exact geometric decision the fix changes (mirroring
 * ZoneSidebar.initializeHidingZones), independent of the ArcGIS buffer pipeline.
 */

// Big game boundary around the two radars.
const boundary = turf.polygon([
    [
        [7.4, 46.9],
        [7.56, 46.9],
        [7.56, 47.04],
        [7.4, 47.04],
        [7.4, 46.9],
    ],
]);

// Two "radar" questions, each answered `within: false` (hider is OUTSIDE the
// 2 km circle). Centres are ~3 km apart so the circles overlap in the middle.
const centerA: [number, number] = [7.46, 46.97];
const centerB: [number, number] = [7.5, 46.97];
const circleA = turf.circle(centerA, 2, { units: "kilometers" });
const circleB = turf.circle(centerB, 2, { units: "kilometers" });

// allowedRegion for a `within: false` radar = boundary minus the circle.
const regionA = turf.difference(turf.featureCollection([boundary, circleA]))!;
const regionB = turf.difference(turf.featureCollection([boundary, circleB]))!;

// NEW (fixed) survival test: keep iff the zone overlaps every region.
const survivesPerQuestion = (zone: Feature<Polygon>) =>
    [regionA, regionB].every((r) => turf.booleanIntersects(zone, r));

// OLD (buggy) survival test: keep iff the zone is NOT fully inside the combined
// eliminated area (A ∪ B).
const eliminatedCombined = turf.union(
    turf.featureCollection([circleA, circleB]),
)!;
const survivesCombined = (zone: Feature<Polygon>) =>
    !turf.booleanWithin(zone, eliminatedCombined);

describe("dodge-aware hiding zone survival", () => {
    // 0.6 km zone at the midpoint: its right edge pokes outside circle A (but is
    // inside B) and its left edge pokes outside circle B (but is inside A); no
    // point is outside both. The hider can dodge radar A from one edge and radar
    // B from the other without leaving the zone.
    const dodgeableZone = turf.circle([7.48, 46.97], 0.6, {
        units: "kilometers",
    });

    it("keeps a zone that can dodge each radar independently", () => {
        expect(turf.booleanIntersects(dodgeableZone, regionA)).toBe(true);
        expect(turf.booleanIntersects(dodgeableZone, regionB)).toBe(true);
        expect(survivesPerQuestion(dodgeableZone)).toBe(true);
    });

    it("reproduces the old bug: combined-area logic would wipe it out", () => {
        // Every point of the zone lies inside A ∪ B, so the old test dropped it.
        expect(turf.booleanWithin(dodgeableZone, eliminatedCombined)).toBe(true);
        expect(survivesCombined(dodgeableZone)).toBe(false);
    });

    it("still drops a zone genuinely killed by a single radar", () => {
        // Entirely inside circle A → no point is outside A, so radar A
        // (within:false) eliminates the whole zone. Must stay dropped.
        const deadZone = turf.circle(centerA, 0.3, { units: "kilometers" });
        expect(turf.booleanIntersects(deadZone, regionA)).toBe(false);
        expect(survivesPerQuestion(deadZone)).toBe(false);
    });
});
