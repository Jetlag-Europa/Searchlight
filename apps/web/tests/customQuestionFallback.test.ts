import type { GameDefinition } from "@searchlight/shared";
import { afterEach, describe, expect, it } from "vitest";

import { setActiveGameDefinition } from "@/game-definition/store";
import { addQuestion, questions } from "@/lib/context";

const layerlessGame = {
    id: "no-layers",
    name: "No Layers",
    serverId: "home-games",
    map: {
        center: [10, 50],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        features: { type: "FeatureCollection", features: [] },
    },
} as unknown as GameDefinition;

describe("custom questions in a game without layers", () => {
    afterEach(() => {
        setActiveGameDefinition(null);
        questions.set([]);
    });

    it("adds the player-drawn variant of each layer-backed family", () => {
        setActiveGameDefinition(layerlessGame);
        addQuestion({ id: "matching", data: { lat: 50, lng: 10 } });
        addQuestion({ id: "measuring", data: { lat: 50, lng: 10 } });
        addQuestion({ id: "tentacles", data: { lat: 50, lng: 10 } });
        addQuestion({ id: "tentacles", data: { lat: 50, lng: 10 } });

        const [matching, measuring, tentacles, otherTentacles] =
            questions.get() as any[];
        expect(matching.data.type).toBe("custom-points");
        expect(measuring.data.type).toBe("custom-measure");
        expect(tentacles.data).toMatchObject({
            locationType: "custom",
            places: [],
        });
        // Each question gets its own list of drawn places.
        expect(tentacles.data.places).not.toBe(otherTentacles.data.places);
    });

    it("still rejects radar and thermometer the game does not declare", () => {
        setActiveGameDefinition(layerlessGame);
        expect(() =>
            addQuestion({ id: "radius", data: { lat: 50, lng: 10 } }),
        ).toThrow("not part of the active game");
        expect(questions.get()).toEqual([]);
    });
});
