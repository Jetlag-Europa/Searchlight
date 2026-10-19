import { OpenLocationCode } from "open-location-code";
import { describe, expect, it } from "vitest";

import { splitPlusCode } from "@/lib/plusCode";
import { GEOCODER_API } from "@/maps/api/constants";
import { geocodeUrl } from "@/maps/api/geocode";

describe("geocodeUrl", () => {
    it("encodes the query so &, # and + stay part of it", () => {
        const url = new URL(geocodeUrl("Bahnhof & Post #2 + 1", "en"));
        expect(url.origin + url.pathname).toBe(GEOCODER_API);
        expect(url.searchParams.get("q")).toBe("Bahnhof & Post #2 + 1");
        expect(url.searchParams.get("lang")).toBe("en");
        expect(url.hash).toBe("");
    });
});

describe("splitPlusCode", () => {
    it("keeps the whole locality after the code", () => {
        expect(splitPlusCode("Q9CM+3P Narita, Chiba, Japan")).toEqual({
            code: "Q9CM+3P",
            locality: "Narita, Chiba, Japan",
        });
    });

    it("trims and collapses whitespace", () => {
        expect(splitPlusCode("  Q9CM+3P   Bad   Homburg ")).toEqual({
            code: "Q9CM+3P",
            locality: "Bad Homburg",
        });
    });

    it("drops a comma right after the code", () => {
        // Typed as static methods, called on an instance (as in LatLngPicker).
        const olc = new OpenLocationCode() as typeof OpenLocationCode;
        const short = splitPlusCode("9G8F+6X, Zürich");
        expect(short).toEqual({ code: "9G8F+6X", locality: "Zürich" });
        expect(olc.isValid(short.code) && olc.isShort(short.code)).toBe(true);

        // A full code decodes on its own; its locality isn't geocoded.
        const full = splitPlusCode("8FVC9G8F+6X, Zürich");
        expect(full).toEqual({ code: "8FVC9G8F+6X", locality: "Zürich" });
        expect(olc.isFull(full.code)).toBe(true);
        const { latitudeCenter, longitudeCenter } = olc.decode(full.code);
        expect(latitudeCenter).toBeCloseTo(47.3656, 3);
        expect(longitudeCenter).toBeCloseTo(8.5249, 3);
    });

    it("gives an empty locality for a code alone", () => {
        expect(splitPlusCode("8Q7XQ9CM+3P")).toEqual({
            code: "8Q7XQ9CM+3P",
            locality: "",
        });
        expect(splitPlusCode("")).toEqual({ code: "", locality: "" });
    });
});
