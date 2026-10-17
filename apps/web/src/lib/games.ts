import {
    type Game as ServerGame,
    type GameDefinition,
    type GameSessionSummary,
} from "@searchlight/shared";
import { atom } from "nanostores";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    loadGameDefinition,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { activeSessionId } from "@/lib/activeSession";
import {
    disabledStations,
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

export interface GameOption {
    id: string;
    gameKey: string;
    label: string;
    serverId: string;
    serverName: string;
    size: "small" | "medium" | "large";
}

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
// Server-fetched games.
export const gamesAtom = atom<GameOption[]>([]);
export const gamesLoadingAtom = atom<boolean>(false);
let latestCatalogRequest = 0;
let activeCatalogRequests = 0;

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
 * A server's game catalog, without publishing it. The session picker browses
 * other servers' catalogs, while gamesAtom holds the active session's: the
 * zone sidebar reads its game's size there, which sets the zoom level from
 * which zone names show.
 */
export async function fetchGameCatalog(
    serverId: string,
): Promise<GameOption[]> {
    const [gamesRes, serversRes] = await Promise.all([
        fetch(`${API_BASE}/games?serverId=${serverId}`, {
            credentials: "include",
        }),
        fetch(`${API_BASE}/servers`, { credentials: "include" }),
    ]);
    if (!gamesRes.ok)
        throw new Error(`Failed to fetch games: ${gamesRes.status}`);
    const gamesData = (await gamesRes.json()) as { games: ServerGame[] };

    let serverName = serverId;
    if (serversRes.ok) {
        const serversData = (await serversRes.json()) as {
            servers: Array<{ id: string; name: string }>;
        };
        serverName =
            serversData.servers.find((s) => s.id === serverId)?.name ??
            serverId;
    }

    return gamesData.games.map((g): GameOption => {
        return {
            id: g.id,
            gameKey: g.gameKey,
            label: g.name,
            serverId: g.serverId,
            serverName,
            size: (g.size as "small" | "medium" | "large") ?? "medium",
        };
    });
}

/** The active session's server catalog, published as gamesAtom. */
export async function fetchGames(serverId: string): Promise<GameOption[]> {
    const request = ++latestCatalogRequest;
    activeCatalogRequests++;
    gamesLoadingAtom.set(true);
    try {
        const defs = await fetchGameCatalog(serverId);
        if (request === latestCatalogRequest) gamesAtom.set(defs);
        return defs;
    } finally {
        if (--activeCatalogRequests === 0) gamesLoadingAtom.set(false);
    }
}

export function getGameById(id: string): GameOption | undefined {
    return gamesAtom.get().find((g) => g.id === id);
}

/**
 * The game a session plays. The server's catalog only names it: participants
 * may load the session's pinned revision without access to that catalog (403
 * for non-members), and a Discord outage fails it too, so fall back to the
 * session's own ids instead of failing the load.
 */
export async function resolveSessionGame(
    session: GameSessionSummary,
): Promise<GameOption> {
    const games = await fetchGames(session.serverId).catch((err) => {
        console.warn("[searchlight:session] game catalog unavailable:", err);
        return [] as GameOption[];
    });
    return (
        games.find((game) => game.id === session.gameId) ??
        getGameById(session.gameId) ?? {
            id: session.gameId,
            gameKey: session.gameId,
            label: session.gameName || session.name,
            serverId: session.serverId,
            serverName: session.serverId,
            size: "medium",
        }
    );
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
 * still loading (a revision upgrade, say) and clear the board, so a load that
 * fails leaves no other game behind.
 */
export function leaveGame(): void {
    gameSwitchGeneration++;
    pendingGameSwitch = undefined;
    resetGameState();
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
    disabledStations.set([]);
    permanentOverlay.set(null);
    hidingZoneFocusedStationID.set("");
    writeStorage("sessionStorage", GAME_SS_KEY, "");
    currentGameId.set("");
}

export function switchToGame(
    game: GameOption,
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
    displayHidingZones.set(true);
    displayHidingZonesStyle.set("zones");
    return selection.promise;
}
