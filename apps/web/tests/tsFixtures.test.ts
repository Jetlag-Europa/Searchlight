import { describe, expect, it } from "vitest";

import { prettifyLocation } from "@/maps/api/geo";
import type { APILocations } from "@/maps/api/types";
import { questionSchema } from "@/maps/schema";

describe("thermometer question schema", () => {
    it("defaults enabled to true", () => {
        const q = questionSchema.parse({
            id: "thermometer",
            data: { latA: 0, lngA: 0, latB: 1, lngB: 1, warmer: true },
        });
        expect(q.data.enabled).toBe(true);
    });

    it("accepts an explicit enabled: false", () => {
        const q = questionSchema.parse({
            id: "thermometer",
            data: { latA: 0, lngA: 0, latB: 1, lngB: 1, warmer: true, enabled: false },
        });
        expect(q.data.enabled).toBe(false);
    });
});

describe("zone matching question schema", () => {
    it("carries cat.adminLevel with default 3", () => {
        const q = questionSchema.parse({
            id: "matching",
            data: { type: "zone", lat: 0, lng: 0, same: true },
        });
        expect((q.data as any).cat.adminLevel).toBe(3);
    });
});

describe("prettifyLocation", () => {
    it.each([
        ["aquarium", "Aquarium"],
        ["hospital", "Hospital"],
        ["cinema", "Cinema"],
        ["library", "Library"],
        ["golf_course", "Golf Course"],
        ["consulate", "Foreign Consulate"],
        ["park", "Park"],
        ["museum", "Museum"],
        ["theme_park", "Theme Park"],
        ["zoo", "Zoo"],
    ] as const)("prettifyLocation(%s) === %s", (loc: APILocations, expected: string) => {
        expect(prettifyLocation(loc)).toBe(expected);
    });

    it("pluralises library correctly", () => {
        expect(prettifyLocation("library", true)).toBe("Libraries");
    });

    it("pluralises other types with an s suffix", () => {
        expect(prettifyLocation("aquarium", true)).toBe("Aquariums");
        expect(prettifyLocation("museum", true)).toBe("Museums");
    });
});
