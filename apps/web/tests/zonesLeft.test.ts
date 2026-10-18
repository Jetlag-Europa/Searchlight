import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { activeSessionId } from "@/lib/activeSession";
import {
    displayHidingZones,
    perQuestionMapData,
    questionFinishedMapData,
    setDisabledStations,
    trainStations,
} from "@/lib/context";
import { applyGameDefinition, resetGameState } from "@/lib/games";
import {
    countZonesLeft,
    hidingZonesCalculated,
    zonesLeft,
} from "@/lib/zonesLeft";
import { hidingZoneCircles } from "@/maps/geo-utils";

// A game of five station zones.
const definition: GameDefinition = {
    id: "zones-left-game",
    name: "Zones left",
    serverId: "server",
    map: {
        center: [0, 0],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 500,
        features: {
            type: "FeatureCollection",
            features: ["a", "b", "c", "d", "e"].map((id, index) => ({
                type: "Feature",
                id,
                geometry: { type: "Point", coordinates: [index, 0] },
                properties: { name: `Station ${id}` },
            })),
        },
    },
};

describe("countZonesLeft", () => {
    it("counts the zones the questions left out of the game's", () => {
        expect(countZonesLeft(["a", "b", "c"], [], 10)).toEqual({
            left: 3,
            total: 10,
            disabled: 0,
        });
    });

    it("takes out the zones disabled by hand", () => {
        expect(countZonesLeft(["a", "b", "c"], ["b"], 10)).toEqual({
            left: 2,
            total: 10,
            disabled: 1,
        });
    });

    it("doesn't count a disabled zone the questions already ruled out", () => {
        expect(countZonesLeft(["a", "b"], ["b", "x", "y"], 10)).toEqual({
            left: 1,
            total: 10,
            disabled: 1,
        });
    });

    it("counts none left when every zone is ruled out", () => {
        expect(countZonesLeft([], ["a"], 10)).toEqual({
            left: 0,
            total: 10,
            disabled: 0,
        });
    });
});

describe("zonesLeft", () => {
    // The zone sidebar's calculation: the zones the questions left.
    const calculate = (ids: string[]) => {
        trainStations.set(
            hidingZoneCircles(compiledGameAtom.get()!).filter((zone) =>
                ids.includes(zone.properties.properties.id),
            ),
        );
        hidingZonesCalculated.set(true);
    };

    beforeEach(() => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        });
        displayHidingZones.set(true);
        // Disabled zones are kept per session.
        activeSessionId.set("zones-left-session");
        setDisabledStations([]);
        applyGameDefinition(definition);
    });

    afterEach(() => {
        setDisabledStations([]);
        activeSessionId.set("");
        vi.unstubAllGlobals();
        resetGameState();
    });

    it("shows nothing until the zones are worked out", () => {
        expect(zonesLeft.get()).toBeNull();
        calculate([]);
        expect(zonesLeft.get()).toEqual({ left: 0, total: 5, disabled: 0 });
    });

    it("follows the zones disabled by hand", () => {
        calculate(["a", "b", "c"]);
        expect(zonesLeft.get()).toEqual({ left: 3, total: 5, disabled: 0 });
        setDisabledStations(["a", "c", "e"]);
        expect(zonesLeft.get()).toEqual({ left: 1, total: 5, disabled: 2 });
    });

    it("shows nothing while the zones are hidden", () => {
        calculate(["a"]);
        displayHidingZones.set(false);
        expect(zonesLeft.get()).toBeNull();
    });

    it("forgets the last game's count and question results on a session switch", () => {
        calculate(["a"]);
        questionFinishedMapData.set({
            type: "FeatureCollection",
            features: [],
        });
        perQuestionMapData.set([{ question: {}, region: null }]);

        resetGameState();
        expect(zonesLeft.get()).toBeNull();
        // The zone sidebar waits for the next session's results.
        expect(questionFinishedMapData.get()).toBeNull();
        expect(perQuestionMapData.get()).toEqual([]);

        // The next game loads; its zones aren't worked out yet.
        applyGameDefinition(definition);
        expect(zonesLeft.get()).toBeNull();
    });

    it("forgets the count when a new game definition is applied", () => {
        calculate(["a"]);
        applyGameDefinition({ ...definition });
        expect(zonesLeft.get()).toBeNull();
    });
});
