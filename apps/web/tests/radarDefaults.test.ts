import type { GameDefinition } from "@searchlight/shared";
import { afterEach, describe, expect, it } from "vitest";

import { compileGameDefinition, radarRadii } from "@/game-definition/compile";
import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { addQuestion, questions } from "@/lib/context";
import { resolveCompiledQuestion } from "@/maps";

const baseGame = {
    id: "radar-defaults",
    name: "Radar Defaults",
    serverId: "home-games",
    map: {
        center: [10, 50],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 350,
        unit: "meters",
        features: { type: "FeatureCollection", features: [] },
    },
};

const game = (extra: object) =>
    ({ ...baseGame, ...extra }) as unknown as GameDefinition;

describe("declared radar radii", () => {
    afterEach(() => {
        setActiveGameDefinition(null);
        questions.set([]);
    });

    it("lists the declared radii, or the hiding radius for radars: true", () => {
        expect(radarRadii(compileGameDefinition(game({})))).toEqual([]);
        expect(
            radarRadii(compileGameDefinition(game({ radars: true }))),
        ).toEqual([{ value: 350, unit: "meters" }]);
        expect(
            radarRadii(
                compileGameDefinition(
                    game({ radars: [400, 600, 400], unit: "kilometers" }),
                ),
            ),
        ).toEqual([
            { value: 400, unit: "kilometers" },
            { value: 600, unit: "kilometers" },
        ]);
    });

    it("adds a radar at the game's first declared radius", () => {
        setActiveGameDefinition(game({ radars: [400, 600] }));
        addQuestion({ id: "radius", data: { lat: 50, lng: 10 } });
        const [added] = questions.get();
        expect(added.id).toBe("radius");
        expect(added.data).toMatchObject({ radius: 400, unit: "meters" });
    });

    it("keeps a radius the player picked", () => {
        setActiveGameDefinition(game({ radars: [400, 600] }));
        addQuestion({
            id: "radius",
            data: { lat: 50, lng: 10, radius: 600, unit: "meters" },
        });
        expect(questions.get()[0].data).toMatchObject({
            radius: 600,
            unit: "meters",
        });
    });

    it("starts radars: true at the base hiding radius", () => {
        setActiveGameDefinition(game({ radars: true }));
        addQuestion({ id: "radius", data: { lat: 50, lng: 10 } });
        expect(questions.get()[0].data).toMatchObject({
            radius: 350,
            unit: "meters",
        });
    });

    it("resolves radar questions of a radii-list game to a compiled radar", () => {
        setActiveGameDefinition(game({ radars: [400, 600], thermometer: true }));
        const compiled = compiledGameAtom.get()!;
        expect(
            resolveCompiledQuestion(
                { id: "radius", data: { radius: 600, unit: "meters" } },
                compiled,
            )?.family,
        ).toBe("radius");
        expect(
            resolveCompiledQuestion({ id: "thermometer", data: {} }, compiled)
                ?.family,
        ).toBe("thermometer");
    });
});
