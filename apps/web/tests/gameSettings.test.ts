import type { Game } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { gameSettingsUpdate } from "@/components/GameSettingsDialog";

const game: Game = {
    id: "g1",
    gameKey: "paris-2026",
    serverId: "s1",
    name: "Paris 15-08",
    size: "medium",
    unlisted: false,
    currentRevisionId: "r1",
};

describe("gameSettingsUpdate", () => {
    it("sends only the fields that changed", () => {
        expect(gameSettingsUpdate(game, { name: "Paris 16-08", size: "medium" })).toEqual({
            baseRevisionId: "r1",
            name: "Paris 16-08",
        });
        expect(gameSettingsUpdate(game, { name: game.name, size: "large" })).toEqual({
            baseRevisionId: "r1",
            size: "large",
        });
    });

    it("trims the name before comparing and sending", () => {
        expect(gameSettingsUpdate(game, { name: "  Paris 15-08 ", size: "medium" })).toBeNull();
        expect(gameSettingsUpdate(game, { name: " Lyon ", size: "medium" })).toEqual({
            baseRevisionId: "r1",
            name: "Lyon",
        });
    });

    it("has nothing to save for a blank name or a game without a revision", () => {
        expect(gameSettingsUpdate(game, { name: "   ", size: "large" })).toBeNull();
        expect(
            gameSettingsUpdate({ ...game, currentRevisionId: null }, { name: "Lyon", size: "medium" }),
        ).toBeNull();
    });
});
