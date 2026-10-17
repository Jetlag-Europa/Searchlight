import type { Game, GameDefinition, GamesResponse } from "@searchlight/shared";
import { atom } from "nanostores";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    loadGameDefinition,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { activeSessionId } from "@/lib/activeSession";
import {
    boardGameId,
    displayHidingZones,
    displayHidingZonesStyle,
    gameDefinitionReady,
    hidingZoneFocusedStationID,
    mapGeoJSON,
    permanentOverlay,
    polyGeoJSON,
    questions,
    trainStations,
} from "@/lib/context";
import { GAME_SS_KEY } from "@/lib/gameView";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import { readStorage, writeStorage } from "@/lib/safeStorage";
const API_BASE = (import.meta.env?.PUBLIC_API_BASE ??
    (typeof process !== "undefined" ? process.env.PUBLIC_API_BASE : "") ??
    "") as string;

export function zoneLabelMinZoom(size?: "small" | "medium" | "large"): number {
    switch (size) {
        case "large":
            return 11;
        case "medium":
            return 13;
        case "small":
            return 17;
        default:
            return 13;
    }
}
let gameSwitchGeneration = 0;
interface PendingGameSwitch {
    key: string;
    promise: Promise<boolean>;
}
let pendingGameSwitch: PendingGameSwitch | undefined;

// Tab-local game ID — sessionStorage so each tab tracks its own game independently.
export const currentGameId = atom<string>(
    readStorage("sessionStorage", GAME_SS_KEY) ?? "",
);

/**
 * A server's game catalog, for starting a session. Only members of the
 * server may read it; a session's own game comes with the session.
 */
export async function fetchGameCatalog(serverId: string): Promise<Game[]> {
    const res = await fetch(`${API_BASE}/games?serverId=${serverId}`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to fetch games: ${res.status}`);
    return ((await res.json()) as GamesResponse).games;
}

export function applyGameDefinition(def: GameDefinition): void {
    setActiveGameDefinition(def);
    const compiled = compiledGameAtom.get()!;
    polyGeoJSON.set(compiled.playArea ?? null);
    mapGeoJSON.set(compiled.playArea ?? null);
    // The zone sidebar redraws the zones from the new definition.
    trainStations.set([]);

    const currentQuestions = questions.get();
    const visibleQuestions = filterSupportedQuestions(
        currentQuestions,
        compiled,
    );
    if (visibleQuestions.length !== currentQuestions.length) {
        // Hiding unsupported questions is a view of the session, not an edit:
        // during a session switch it would otherwise be saved into whichever
        // session is still active.
        questions.set(suppressQuestionSave(visibleQuestions));
    }
    gameDefinitionReady.set(true);
}

/** A session's game: its pinned revision, loaded with the session's access. */
export interface SwitchToGameOptions {
    revisionId: string;
    sessionId: string;
}

/**
 * Leave the active game before another session's game loads: cancel a switch
 * still loading (a revision upgrade, say) and clear the board and its overlay,
 * so a load that fails leaves no other game behind.
 */
export function leaveGame(): void {
    gameSwitchGeneration++;
    pendingGameSwitch = undefined;
    resetGameState();
    permanentOverlay.set(null);
    boardGameId.set("");
}

/**
 * Clear what the active game put on the board: its definition, play area,
 * zones and selection. switchToGame calls this after registering its own load;
 * leaveGame also cancels any switch in flight.
 */
export function resetGameState(): void {
    gameDefinitionReady.set(false);
    setActiveGameDefinition(null);
    trainStations.set([]);
    polyGeoJSON.set(null);
    mapGeoJSON.set(null);
    hidingZoneFocusedStationID.set("");
    writeStorage("sessionStorage", GAME_SS_KEY, "");
    currentGameId.set("");
}

export function switchToGame(
    game: { id: string },
    { revisionId, sessionId }: SwitchToGameOptions,
): Promise<boolean> {
    const startingSessionId = activeSessionId.get();
    const key = JSON.stringify([game.id, revisionId, sessionId]);
    if (pendingGameSwitch?.key === key) return pendingGameSwitch.promise;

    const generation = ++gameSwitchGeneration;
    const definition = loadGameDefinition(game.id, revisionId, sessionId);
    // Register the switch before notifying atom subscribers so reentrant callers
    // share the same outcome instead of superseding the original caller.
    const selection: PendingGameSwitch = {
        key,
        promise: Promise.resolve()
            .then(async () => {
                try {
                    const loaded = await definition;
                    if (
                        generation !== gameSwitchGeneration ||
                        activeSessionId.get() !== startingSessionId
                    ) return false;
                    applyGameDefinition(loaded);
                    return true;
                } catch (error) {
                    if (generation !== gameSwitchGeneration) return false;
                    console.warn(
                        "[games] Failed to load game definition",
                        error,
                    );
                    return false;
                }
            })
            .finally(() => {
                if (generation === gameSwitchGeneration)
                    pendingGameSwitch = undefined;
            }),
    };
    pendingGameSwitch = selection;

    resetGameState();

    writeStorage("sessionStorage", GAME_SS_KEY, game.id);
    currentGameId.set(game.id);
    // Reloading the session or upgrading its game's revision keeps the
    // overlay and how zones are shown; another game starts afresh.
    if (boardGameId.get() !== game.id) {
        boardGameId.set(game.id);
        permanentOverlay.set(null);
        displayHidingZones.set(true);
        displayHidingZonesStyle.set("zones");
    }
    return selection.promise;
}
