import { describe, expect, it } from "vitest";

import { formatDistance } from "@/lib/utils";

describe("formatDistance", () => {
    it("shows short kilometre distances in meters", () => {
        expect(formatDistance(849.6, "kilometers")).toBe("850 m");
        expect(formatDistance(12_345, "kilometers")).toBe("12.35 km");
    });

    it("keeps meters when they are the player's unit", () => {
        expect(formatDistance(12_345.4, "meters")).toBe("12,345 m");
    });

    it("shows short mile distances in feet", () => {
        expect(formatDistance(128, "miles")).toBe("420 ft");
        expect(formatDistance(1609.344 * 3.456, "miles")).toBe("3.46 mi");
    });
});
