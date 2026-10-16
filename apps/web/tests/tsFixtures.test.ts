import { describe, expect, it } from "vitest";

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

describe("question schema", () => {
    // Older sessions may still hold questions from the retired built-in
    // catalogue; they no longer parse.
    it.each([
        ["matching", { type: "airport" }],
        ["matching", { type: "zone" }],
        ["matching", { type: "same-train-line" }],
        ["measuring", { type: "mcdonalds" }],
        ["measuring", { type: "museum-full" }],
        ["tentacles", { locationType: "theme_park" }],
    ] as const)("rejects the retired %s question %o", (id, data) => {
        expect(
            questionSchema.safeParse({ id, data: { lat: 0, lng: 0, ...data } })
                .success,
        ).toBe(false);
    });

    it("no longer defaults a matching question to an airport", () => {
        expect(
            questionSchema.safeParse({
                id: "matching",
                data: { lat: 0, lng: 0 },
            }).success,
        ).toBe(false);
    });

    it("parses game and player-drawn questions", () => {
        const tentacle = questionSchema.parse({
            id: "tentacles",
            data: { lat: 0, lng: 0, locationType: "tentacle-museums" },
        });
        expect(tentacle.data).toMatchObject({ radius: 15, location: false });
        for (const data of [
            { type: "matching-zones" },
            { type: "custom-zone", geo: null },
            { type: "custom-points", geo: [] },
        ])
            expect(
                questionSchema.safeParse({
                    id: "matching",
                    data: { lat: 0, lng: 0, ...data },
                }).success,
            ).toBe(true);
        expect(
            questionSchema.safeParse({
                id: "measuring",
                data: { lat: 0, lng: 0, type: "custom-measure", geo: null },
            }).success,
        ).toBe(true);
    });
});
