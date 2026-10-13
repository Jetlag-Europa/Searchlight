import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    acquireScopedLoading,
    isLoading,
    resetScopedLoading,
    setScopedLoading,
} from "../src/lib/context";
import { filterZoneIndexes } from "../src/maps/geo-utils/geometryClient";

describe("scoped loading ownership", () => {
    beforeEach(() => {
        resetScopedLoading();
    });

    it("keeps loading true while overlapping scopes are active and clears only when all complete", () => {
        expect(isLoading.get()).toBe(false);

        setScopedLoading("map", true);
        expect(isLoading.get()).toBe(true);

        setScopedLoading("zone", true);
        expect(isLoading.get()).toBe(true);

        // Map finishes first; zone is still active
        setScopedLoading("map", false);
        expect(isLoading.get()).toBe(true);

        // Zone finishes; now loading becomes false
        setScopedLoading("zone", false);
        expect(isLoading.get()).toBe(false);
    });

    it("handles multiple concurrent operations within the same scope", async () => {
        setScopedLoading("latLngPicker:clipboard", true);
        setScopedLoading("latLngPicker:clipboard", true);
        expect(isLoading.get()).toBe(true);

        setScopedLoading("latLngPicker:clipboard", false);
        expect(isLoading.get()).toBe(true);

        setScopedLoading("latLngPicker:clipboard", false);
        expect(isLoading.get()).toBe(false);
    });

    it("does not let an unmounted card's late completion unlock its replacement", () => {
        const oldCard = Symbol("matching-prefill");
        const replacement = Symbol("matching-prefill");
        setScopedLoading(oldCard, true);
        resetScopedLoading(oldCard);
        setScopedLoading(replacement, true);
        setScopedLoading(oldCard, false);
        expect(isLoading.get()).toBe(true);
        setScopedLoading(replacement, false);
        expect(isLoading.get()).toBe(false);
    });

    it("releases canceled selection work without unlocking its replacement", () => {
        const obsolete = acquireScopedLoading("zone:selection");
        const current = acquireScopedLoading("zone:selection");
        obsolete();
        obsolete();
        expect(isLoading.get()).toBe(true);
        current();
        expect(isLoading.get()).toBe(false);
    });
});

describe("geometryClient filterZoneIndexes contract", () => {
    const boundary = turf.polygon([
        [
            [7.4, 46.9],
            [7.56, 46.9],
            [7.56, 47.04],
            [7.4, 47.04],
            [7.4, 46.9],
        ],
    ]);

    const centerA: [number, number] = [7.46, 46.97];
    const centerB: [number, number] = [7.5, 46.97];
    const circleA = turf.circle(centerA, 2, { units: "kilometers" });
    const circleB = turf.circle(centerB, 2, { units: "kilometers" });

    const regionA = turf.featureCollection([
        turf.difference(turf.featureCollection([boundary, circleA])) as Feature<
            Polygon | MultiPolygon
        >,
    ]);
    const regionB = turf.featureCollection([
        turf.difference(turf.featureCollection([boundary, circleB])) as Feature<
            Polygon | MultiPolygon
        >,
    ]);

    const dodgeableZone = turf.circle([7.48, 46.97], 0.6, {
        units: "kilometers",
    });
    const deadZone = turf.circle(centerA, 0.3, { units: "kilometers" });

    it("filters zones using dodge-aware EACH region overlap", async () => {
        const circles = [dodgeableZone, deadZone];
        const regions = [regionA, regionB];

        const surviving = await filterZoneIndexes(circles, regions);
        // Only dodgeableZone (index 0) survives both regions independently
        expect(surviving).toEqual([0]);
    });

    it("yields empty array if any region has no features (eliminated everywhere)", async () => {
        const circles = [dodgeableZone];
        const emptyRegion = turf.featureCollection<Polygon | MultiPolygon>([]);
        const regions = [regionA, emptyRegion];

        const surviving = await filterZoneIndexes(circles, regions);
        expect(surviving).toEqual([]);
    });

    it("returns all indexes when regions array is empty", async () => {
        const circles = [dodgeableZone, deadZone];
        const surviving = await filterZoneIndexes(circles, []);
        expect(surviving).toEqual([0, 1]);
    });
});
