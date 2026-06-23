import { describe, expect, it, beforeEach } from "vitest";

import { gamePOIData } from "@/lib/context";
import {
    categoryForQuestionType,
    customPOIFeatureCollection,
    customPOIPoints,
    getCustomPOIs,
    resolveCategory,
} from "@/lib/poiOverride";

describe("categoryForQuestionType", () => {
    it("maps generic POI types to their category", () => {
        expect(categoryForQuestionType("zoo")).toBe("zoo");
        expect(categoryForQuestionType("museum-full")).toBe("museum");
        expect(categoryForQuestionType("airport")).toBe("airport");
        expect(categoryForQuestionType("consulate-full")).toBe("consulate");
        expect(categoryForQuestionType("aquarium")).toBe("aquarium");
    });

    it("renames the mountain question type peak → mountain", () => {
        expect(categoryForQuestionType("peak")).toBe("mountain");
        expect(categoryForQuestionType("peak-full")).toBe("mountain");
    });

    it("normalises legacy game-prefixed types", () => {
        expect(categoryForQuestionType("sl-camping")).toBe("camping");
        expect(categoryForQuestionType("bern-mountain")).toBe("mountain");
        expect(categoryForQuestionType("buch-train_station")).toBe("train_station");
        expect(categoryForQuestionType("covrigarie")).toBe("covrigarie");
    });

    it("returns null for non-POI question types", () => {
        expect(categoryForQuestionType("coastline")).toBeNull();
        expect(categoryForQuestionType("international-border")).toBeNull();
        expect(categoryForQuestionType("zone")).toBeNull();
        expect(categoryForQuestionType("same-train-line")).toBeNull();
    });
});

describe("resolveCategory", () => {
    it("is identity for canonical category keys", () => {
        expect(resolveCategory("museum")).toBe("museum");
        expect(resolveCategory("train_station")).toBe("train_station");
    });
    it("applies tentacle aliases", () => {
        expect(resolveCategory("bern-park")).toBe("park");
        expect(resolveCategory("bern-mountain")).toBe("mountain");
    });
});

describe("custom POI accessors", () => {
    beforeEach(() => gamePOIData.set({}));

    it("returns null when the active game provides no POIs for a category", () => {
        expect(getCustomPOIs("zoo")).toBeNull();
        expect(customPOIPoints("zoo")).toBeNull();
        expect(customPOIFeatureCollection("zoo")).toBeNull();
    });

    it("returns custom POIs when present", () => {
        gamePOIData.set({
            mountain: [
                { name: "Peak A", lat: 46.9, lon: 7.4 },
                { name: "Peak B", lat: 47.0, lon: 7.5 },
            ],
        });
        const pois = getCustomPOIs("mountain");
        expect(pois).toHaveLength(2);

        // peak / peak-full questions resolve to the mountain category, so a game
        // that bundles mountains drives the generic mountain question.
        const cat = categoryForQuestionType("peak-full")!;
        const fc = customPOIFeatureCollection(cat)!;
        expect(fc.features).toHaveLength(2);
        expect(fc.features[0].geometry.coordinates).toEqual([7.4, 46.9]);
    });

    it("treats an empty array as no override (falls back to Overpass)", () => {
        gamePOIData.set({ zoo: [] });
        expect(getCustomPOIs("zoo")).toBeNull();
    });
});
