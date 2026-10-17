import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import {
    GPS_FIX_MAX_AGE_MS,
    newQuestionPosition,
    newThermometerData,
} from "@/lib/questionPosition";

const center = { lat: 47.37, lng: 8.54 };
const now = 1_800_000_000_000;
const fix = { lat: 46.95, lng: 7.44, timestamp: now - 30_000 };

describe("newQuestionPosition", () => {
    it("uses a recent Follow Me fix", () => {
        expect(newQuestionPosition(center, true, fix, now)).toEqual({
            lat: 46.95,
            lng: 7.44,
        });
    });

    it("uses the map centre while Follow Me is off", () => {
        expect(newQuestionPosition(center, false, fix, now)).toEqual(center);
    });

    it("uses the map centre without a fix", () => {
        expect(newQuestionPosition(center, true, null, now)).toEqual(center);
    });

    it("uses the map centre once the fix is stale", () => {
        const at = (age: number) =>
            newQuestionPosition(
                center,
                true,
                { ...fix, timestamp: now - age },
                now,
            );
        expect(at(GPS_FIX_MAX_AGE_MS)).toEqual({ lat: 46.95, lng: 7.44 });
        expect(at(GPS_FIX_MAX_AGE_MS + 1)).toEqual(center);
    });
});

describe("newThermometerData", () => {
    it("starts at the given point and ends 5 km east of it", () => {
        const data = newThermometerData(center);
        expect(data.latA).toBe(center.lat);
        expect(data.lngA).toBe(center.lng);
        expect(data.lngB).toBeGreaterThan(center.lng);
        expect(data.latB).toBeCloseTo(center.lat, 2);
        expect(
            turf.distance([data.lngA, data.latA], [data.lngB, data.latB], {
                units: "kilometers",
            }),
        ).toBeCloseTo(5, 3);
    });
});
