import type { GameDefinition } from "@searchlight/shared";
import { afterEach, describe, expect, it } from "vitest";

import { setActiveGameDefinition } from "@/game-definition/store";
import {
    askedHints,
    askedVariants,
    firstUnasked,
    radarVariant,
} from "@/lib/askedQuestions";
import { addQuestion, questions } from "@/lib/context";
import type { Questions } from "@/maps/schema";

const point = (name: string, lng: number) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, 50] },
    properties: { name },
});
const layer = (name: string) => ({
    name,
    enabledFor: ["matching", "measuring", "tentacle"],
    data: {
        type: "FeatureCollection",
        features: [point(`${name} A`, 10), point(`${name} B`, 10.1)],
    },
});

const game = {
    id: "asked-questions",
    name: "Asked Questions",
    serverId: "home-games",
    map: {
        center: [10, 50],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 500,
        unit: "meters",
        features: { type: "FeatureCollection", features: [] },
    },
    radars: [500, 1000, 2000],
    features: [layer("Airport"), layer("Museum")],
} as unknown as GameDefinition;

// Only what identifies a question matters here.
const parse = (list: unknown[]) => list as Questions;

describe("askedVariants", () => {
    const list = parse([
        { id: "matching", key: 1, data: { type: "matching-airport" } },
        {
            id: "matching",
            key: 2,
            data: { type: "matching-museum", enabled: false },
        },
        { id: "matching", key: 3, data: { type: "custom-points" } },
        { id: "measuring", key: 4, data: { type: "measuring-airport" } },
        {
            id: "tentacles",
            key: 5,
            data: { locationType: "tentacle-museum" },
        },
        { id: "tentacles", key: 6, data: { locationType: "custom" } },
        { id: "radius", key: 7, data: { radius: 2, unit: "kilometers" } },
    ]);

    it("lists the types each family asked, disabled questions included", () => {
        expect(askedVariants(list, "matching")).toEqual(
            new Set(["matching-airport", "matching-museum"]),
        );
        expect(askedVariants(list, "measuring")).toEqual(
            new Set(["measuring-airport"]),
        );
        expect(askedVariants(list, "tentacles")).toEqual(
            new Set(["tentacle-museum"]),
        );
        expect(askedVariants(list, "radius")).toEqual(
            new Set([radarVariant(2, "kilometers")]),
        );
    });

    it("leaves out the asking question itself", () => {
        expect(askedVariants(list, "matching", 1)).toEqual(
            new Set(["matching-museum"]),
        );
        expect(askedHints(list, "matching", 2)).toEqual({
            "matching-airport": "✓ asked",
        });
    });

    it("tells radar sizes apart by unit", () => {
        const asked = askedVariants(list, "radius");
        expect(asked.has(radarVariant(2, "kilometers"))).toBe(true);
        expect(asked.has(radarVariant(2, "miles"))).toBe(false);
    });
});

describe("firstUnasked", () => {
    it("picks the first candidate not asked, or the first if all were", () => {
        const id = (s: string) => s;
        expect(firstUnasked(["a", "b", "c"], new Set(["a"]), id)).toBe("b");
        expect(firstUnasked(["a", "b"], new Set(["a", "b"]), id)).toBe("a");
        expect(firstUnasked([], new Set(), id)).toBeUndefined();
    });
});

describe("new questions default to one not asked yet", () => {
    afterEach(() => {
        setActiveGameDefinition(null);
        questions.set([]);
    });

    it("moves matching, measuring and tentacles to the next type", () => {
        setActiveGameDefinition(game);
        for (const id of ["matching", "measuring", "tentacles"] as const) {
            addQuestion({ id, data: { lat: 50, lng: 10 } });
            addQuestion({ id, data: { lat: 50, lng: 10 } });
            addQuestion({ id, data: { lat: 50, lng: 10 } });
        }
        const types = questions
            .get()
            .map((q: any) => q.data.type ?? q.data.locationType);
        expect(types).toEqual([
            "matching-airport",
            "matching-museum",
            // Every type was asked: back to the first.
            "matching-airport",
            "measuring-airport",
            "measuring-museum",
            "measuring-airport",
            "tentacle-airport",
            "tentacle-museum",
            "tentacle-airport",
        ]);
    });

    it("counts a disabled question as asked", () => {
        setActiveGameDefinition(game);
        addQuestion({
            id: "matching",
            data: { lat: 50, lng: 10, enabled: false },
        });
        addQuestion({ id: "matching", data: { lat: 50, lng: 10 } });
        expect((questions.get()[1].data as any).type).toBe("matching-museum");
    });

    it("keeps a type the caller picked", () => {
        setActiveGameDefinition(game);
        addQuestion({ id: "matching", data: { lat: 50, lng: 10 } });
        addQuestion({
            id: "matching",
            data: { lat: 50, lng: 10, type: "matching-airport" },
        });
        expect((questions.get()[1].data as any).type).toBe("matching-airport");
    });

    it("starts a radar at the first size not asked yet", () => {
        setActiveGameDefinition(game);
        addQuestion({
            id: "radius",
            data: { lat: 50, lng: 10, radius: 500, unit: "meters" },
        });
        addQuestion({ id: "radius", data: { lat: 50, lng: 10 } });
        expect(questions.get()[1].data).toMatchObject({
            radius: 1000,
            unit: "meters",
        });
    });
});
