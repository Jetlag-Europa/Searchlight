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
    it("stops Follow Me when the permission is refused", () => {
        expect(geoErrorAction(1, false)).toBe("stop");
        expect(geoErrorAction(1, true)).toBe("stop");
    });

    it("keeps searching on any other error before the first fix", () => {
        expect(geoErrorAction(2, false)).toBe("searching");
        expect(geoErrorAction(3, false)).toBe("searching");
    });

    it("drops the fix only when the position is unavailable", () => {
        expect(geoErrorAction(2, true)).toBe("lost"); // POSITION_UNAVAILABLE
        expect(geoErrorAction(3, true)).toBe("ignore"); // TIMEOUT
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
