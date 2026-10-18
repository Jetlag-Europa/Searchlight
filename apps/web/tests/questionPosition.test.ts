import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import {
    geoErrorAction,
    newQuestionPosition,
    newThermometerData,
} from "@/lib/questionPosition";

const center = { lat: 47.37, lng: 8.54 };
const fix = { lat: 46.95, lng: 7.44 };

describe("newQuestionPosition", () => {
    it("uses the Follow Me fix, however old", () => {
        expect(newQuestionPosition(center, true, fix)).toEqual(fix);
    });

    it("uses the map centre while Follow Me is off", () => {
        expect(newQuestionPosition(center, false, fix)).toEqual(center);
    });

    it("uses the map centre without a fix", () => {
        expect(newQuestionPosition(center, true, null)).toEqual(center);
    });
});

describe("geoErrorAction", () => {
    it("stops Follow Me only when the permission is refused", () => {
        expect(geoErrorAction(1)).toBe("stop"); // PERMISSION_DENIED
        expect(geoErrorAction(2)).toBe("keep"); // POSITION_UNAVAILABLE
        expect(geoErrorAction(3)).toBe("keep"); // TIMEOUT
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
