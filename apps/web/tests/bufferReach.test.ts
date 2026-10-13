import * as turf from "@turf/turf";
import type { BBox, Feature, LineString } from "geojson";
import { describe, expect, it } from "vitest";

import {
    bboxReach,
    bufferDeviation,
    featuresReaching,
} from "@/maps/geo-utils/bufferReach";

const inside = ([west, south, east, north]: BBox, [lng, lat]: number[]) =>
    lng >= west && lng <= east && lat >= south && lat <= north;

describe("measuring buffer pre-filter", () => {
    it.each([
        ["London", [-0.51, 51.29, 0.33, 51.69] as BBox, 12],
        ["Stockholm", [17.7, 59.2, 18.3, 59.45] as BBox, 40],
        ["Tromsø", [18.7, 69.5, 19.2, 69.8] as BBox, 150],
        ["Quito", [-78.6, -0.35, -78.4, -0.05] as BBox, 25],
        ["Ushuaia", [-68.4, -54.85, -68.2, -54.75] as BBox, 60],
    ])(
        "contains every point within the distance of the %s box",
        (_, bbox, km) => {
            const reach = bboxReach(bbox, km);
            const [west, south, east, north] = bbox;
            for (let step = 0; step < 400; step++) {
                // Points on and inside the box, sent the whole distance out.
                const origin = turf.point([
                    west + ((east - west) * ((step * 7) % 11)) / 10,
                    south + ((north - south) * ((step * 3) % 5)) / 4,
                ]);
                const far = turf.destination(origin, km, (step * 37) % 360, {
                    units: "kilometers",
                });
                expect(inside(reach, far.geometry.coordinates)).toBe(true);
            }
            // ...and no wider than about the distance needed.
            expect(reach[1]).toBeGreaterThan(south - (km / 111) * 1.02 - 0.01);
            expect(reach[3]).toBeLessThan(north + (km / 111) * 1.02 + 0.01);
        },
    );

    it("takes every longitude near a pole or across the antimeridian", () => {
        expect(bboxReach([10, 88.5, 20, 88.8], 100)).toEqual([
            -180,
            expect.closeTo(87.58, 2),
            180,
            expect.closeTo(89.72, 2),
        ]);
        const [west, , east] = bboxReach([179.5, -17, 179.9, -16.5], 50);
        expect([west, east]).toEqual([-180, 180]);
    });

    it("keeps only parts of a layer that can reach the box, by their own bbox", () => {
        const map: BBox = [0, 0, 0.1, 0.1];
        const line = (coordinates: number[][]) =>
            turf.lineString(coordinates) as Feature<LineString>;
        const parts = [
            line([
                [0.05, 0.05],
                [0.06, 0.06],
            ]), // inside
            line([
                [0.2, 0.05],
                [0.3, 0.05],
            ]), // ~11 km east
            line([
                [-0.5, -0.5],
                [0.6, -0.4],
            ]), // passes ~44 km south
            line([
                [1, 1],
                [1.1, 1.1],
            ]), // ~140 km away
        ];
        expect(featuresReaching(parts, map, 5)).toEqual([0]);
        expect(featuresReaching(parts, map, 12)).toEqual([0, 1]);
        expect(featuresReaching(parts, map, 50)).toEqual([0, 1, 2]);
        expect(featuresReaching(parts, map, 200)).toEqual([0, 1, 2, 3]);
    });

    it("loosens the buffer tolerance with the distance, never below 3 ft", () => {
        expect(bufferDeviation(0.1, "miles")).toBeCloseTo(3 / 5280, 8);
        expect(bufferDeviation(10, "miles")).toBeCloseTo(0.005, 8);
        expect(bufferDeviation(16, "kilometers")).toBeCloseTo(0.008, 8);
    });
});
