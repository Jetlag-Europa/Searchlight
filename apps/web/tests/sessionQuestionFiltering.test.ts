import { describe, expect, it } from "vitest";
import {
    filterSupportedQuestions,
    isQuestionSupported,
} from "@/game-definition/store";

function compiled(
    ...entries: Array<
        [string, "radius" | "thermometer" | "matching" | "measuring" | "tentacle"]
    >
) {
    return {
        questionMap: new Map(entries.map(([id, family]) => [id, { id, family }])),
    } as any;
}

const radius = { id: "radius", data: { lat: 1, lng: 2 } };
const thermometer = { id: "thermometer", data: { latA: 1, lngA: 2, latB: 3, lngB: 4 } };
const custom = { id: "matching", data: { type: "custom-points", lat: 1, lng: 2 } };
const legacy = { id: "matching", data: { type: "london-borough", lat: 1, lng: 2 } };
const canonical = { id: "matching", data: { type: "matching-borough", lat: 1, lng: 2 } };
const genericMatching = { id: "matching", data: { type: "airport", lat: 1, lng: 2 } };
const genericTentacle = { id: "tentacles", data: { locationType: "museum", lat: 1, lng: 2 } };
const customTentacle = { id: "tentacles", data: { locationType: "custom", lat: 1, lng: 2, places: [] } };

describe("session question support filtering", () => {
    it("keeps the game's declared questions and player-drawn custom questions", () => {
        const result = filterSupportedQuestions(
            [radius, custom, legacy],
            compiled(["radius-400", "radius"]),
        );
        expect(result).toEqual([radius, custom]);
    });

    it("drops radar and thermometer questions the game does not declare", () => {
        expect(filterSupportedQuestions([radius, thermometer, custom], compiled())).toEqual([custom]);
        expect(isQuestionSupported(thermometer, compiled(["thermometer", "thermometer"]))).toBe(true);
    });

    it("never falls back to generic OSM-backed questions, even while the definition is loading", () => {
        expect(isQuestionSupported(genericMatching, null)).toBe(false);
        expect(isQuestionSupported(genericTentacle, null)).toBe(false);
        expect(isQuestionSupported(genericMatching, compiled(["matching-museum", "matching"]))).toBe(false);
        expect(isQuestionSupported(genericTentacle, compiled(["tentacle-museum", "tentacle"]))).toBe(false);
        expect(isQuestionSupported(customTentacle, compiled(["tentacle-museum", "tentacle"]))).toBe(true);
    });

    it("keeps what the game may support while its definition is loading", () => {
        expect(isQuestionSupported(canonical, null)).toBe(true);
        expect(isQuestionSupported(
            { id: "tentacles", data: { locationType: "tentacle-museum", lat: 1, lng: 2 } },
            null,
        )).toBe(true);
        expect(isQuestionSupported(legacy, null)).toBe(false);
        expect(
            filterSupportedQuestions(
                [radius, thermometer, custom, customTentacle, genericMatching, legacy],
                null,
            ),
        ).toEqual([radius, thermometer, custom, customTentacle]);
    });

    it("requires canonical questions to belong to the ready game's family map", () => {
        expect(isQuestionSupported(canonical, compiled(["matching-borough", "matching"]))).toBe(true);
        expect(isQuestionSupported(canonical, compiled(["matching-other", "matching"]))).toBe(false);
        expect(isQuestionSupported(
            { id: "measuring", data: { type: "matching-borough" } },
            compiled(["matching-borough", "matching"]),
        )).toBe(false);
    });

    it("filters independently without discarding valid questions", () => {
        expect(
            filterSupportedQuestions([legacy, thermometer, custom], compiled(["thermometer", "thermometer"])),
        ).toEqual([thermometer, custom]);
    });
});
