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

    it("gives an empty locality for a code alone", () => {
        expect(splitPlusCode("8Q7XQ9CM+3P")).toEqual({
            code: "8Q7XQ9CM+3P",
            locality: "",
        });
        expect(splitPlusCode("")).toEqual({ code: "", locality: "" });
    });
});
