import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setActiveGameDefinition } from "@/game-definition/store";
import { disabledStations } from "@/lib/context";
import { applyGameDefinition, resetGameState } from "@/lib/games";
import { countZonesLeft, survivingZones, zonesLeft } from "@/lib/zonesLeft";

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
        features: { type: "FeatureCollection", features: [] },
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
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        });
        survivingZones.set(null);
        disabledStations.set([]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setActiveGameDefinition(null);
        survivingZones.set(null);
        disabledStations.set([]);
    });

    it("shows nothing until the zones are worked out", () => {
        expect(zonesLeft.get()).toBeNull();
    });

    it("follows the zones disabled by hand", () => {
        survivingZones.set({ ids: ["a", "b", "c"], total: 5 });
        expect(zonesLeft.get()).toEqual({ left: 3, total: 5, disabled: 0 });
        disabledStations.set(["a", "c"]);
        expect(zonesLeft.get()).toEqual({ left: 1, total: 5, disabled: 2 });
    });

    it("forgets the count when another game loads or the board is cleared", () => {
        survivingZones.set({ ids: ["a"], total: 5 });
        applyGameDefinition(definition);
        expect(zonesLeft.get()).toBeNull();

        survivingZones.set({ ids: ["a"], total: 5 });
        resetGameState();
        expect(zonesLeft.get()).toBeNull();
    });
});
