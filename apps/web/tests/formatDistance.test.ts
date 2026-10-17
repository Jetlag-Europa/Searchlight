import { describe, expect, it } from "vitest";

import { formatDistance } from "@/lib/utils";

describe("formatDistance", () => {
    it("shows short kilometre distances in meters", () => {
        expect(formatDistance(849.6, "kilometers")).toBe("850 m");
        expect(formatDistance(999.7, "kilometers")).toBe("1.000 km");
        expect(formatDistance(1_123.4, "kilometers")).toBe("1.123 km");
        // Rounded to the meter first, so a half meter doesn't fall to float error.
        expect(formatDistance(1_123.5, "kilometers")).toBe("1.124 km");
        expect(formatDistance(12_345, "kilometers")).toBe("12.345 km");
    });

    it("keeps meters when they are the player's unit", () => {
        expect(formatDistance(12_345.4, "meters")).toBe("12,345 m");
    });

    it("shows short mile distances in feet", () => {
        expect(formatDistance(128, "miles")).toBe("420 ft");
        expect(formatDistance(1609.344 * 3.45678, "miles")).toBe("3.457 mi");
    });
});
