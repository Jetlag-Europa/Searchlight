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
import { activeSessionData, activeSessionId } from "@/lib/activeSession";
import {
    additionalMapGeoLocations,
    customStations,
    disabledStations,
    displayHidingZones,
    displayHidingZonesOptions,
    displayHidingZonesStyle,
    gameDefinitionReady,
    hidingRadius,
    hidingRadiusUnits,
    hidingZoneFocusedStationID,
    includeDefaultStations,
    mapGeoJSON,
    permanentOverlay,
    polyGeoJSON,
    questions,
    tierRadiusOverrides,
    trainStations,
    useCustomStations,
} from "@/lib/context";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import { readStorage, writeStorage } from "@/lib/safeStorage";
import { clearTentacleCache } from "@/maps/questions/tentacles";
import type { Units } from "@/maps/schema";
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

const GAME_SS_KEY = "taibled-current-game-id";
let gameSwitchGeneration = 0;
interface PendingGameSwitch {
    key: string;
    definition: Promise<GameDefinition> | undefined;
    promise: Promise<boolean>;
}
let pendingGameSwitch: PendingGameSwitch | undefined;
let publishedGameOptions: string[] | undefined;

// Tab-local game ID — sessionStorage so each tab tracks its own game independently.
export const currentGameId = atom<string>(
    readStorage("sessionStorage", GAME_SS_KEY) ?? "",
);

export async function fetchGames(serverId: string): Promise<GameOption[]> {
    const request = ++latestCatalogRequest;
    activeCatalogRequests++;
    gamesLoadingAtom.set(true);
    try {
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

        const defs = gamesData.games.map((g): GameOption => {
            return {
                id: g.id,
                gameKey: g.gameKey,
                label: g.name,
                serverId: g.serverId,
                serverName,
                size: (g.size as "small" | "medium" | "large") ?? "medium",
            };
        });

        if (request === latestCatalogRequest) gamesAtom.set(defs);
        return defs;
    } finally {
        if (--activeCatalogRequests === 0) gamesLoadingAtom.set(false);
    }
}

// Derive the game key set from the live games atom.
export function getGameKeys(): ReadonlySet<string> {
    return new Set(gamesAtom.get().map((g) => g.gameKey));
}
export function getGameById(id: string): GameOption | undefined {
    return gamesAtom.get().find((g) => g.id === id);
}

/**
 * A session's game as described by the session itself, for games missing from
 * the caller's catalog. Summaries cached before sessions carried game details
 * fall back to the session's ids.
 */
export function sessionGameOption(
    session: Pick<
        GameSessionSummary,
        "gameId" | "gameName" | "gameKey" | "gameSize" | "serverId"
    >,
): GameOption {
    return {
        id: session.gameId,
        gameKey: session.gameKey ?? session.gameId,
        label: session.gameName,
        serverId: session.serverId,
        serverName: session.serverId,
        size: session.gameSize ?? "medium",
    };
}

/**
 * The game a session plays. The server's catalog only names it: participants
 * may load the session's pinned revision without access to that catalog (403
 * for non-members, and unlisted games started from a game link are never in
 * it), and a Discord outage fails it too, so fall back to the session's own
 * description of its game instead of failing the load.
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
        getGameById(session.gameId) ??
        sessionGameOption(session)
    );
}

export function getGameByKey(value: string): GameOption | undefined {
    return gamesAtom.get().find((g) => g.gameKey === value);
}

export function applyGameDefinition(def: GameDefinition): void {
    setActiveGameDefinition(def);
    const compiled = compiledGameAtom.get()!;
    polyGeoJSON.set(compiled.playArea ?? null);
    mapGeoJSON.set(compiled.playArea ?? null);
    trainStations.set([]);
    if (compiled.hidingZones.stations?.length) {
        useCustomStations.set(true);
        includeDefaultStations.set(false);
        customStations.set(
            compiled.hidingZones.stations.map((s) => ({
                id: String(s.id),
                name: s.name,
                lat: s.coordinates[1],
                lng: s.coordinates[0],
                ...(s.tier ? { tier: s.tier } : {}),
                ...(s.explicitRadius !== undefined
                    ? { radius: s.explicitRadius }
                    : {}),
                unit:
                    (s.radius?.unit as Units) ??
                    (compiled.hidingZones.baseRadius.unit as Units),
            })),
        );
    } else {
        useCustomStations.set(false);
        includeDefaultStations.set(false);
        customStations.set([]);
    }
    hidingRadius.set(compiled.hidingZones.baseRadius.value);
    hidingRadiusUnits.set(compiled.hidingZones.baseRadius.unit);
    tierRadiusOverrides.set(def.hidingZones?.tierOverrides ?? {});

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

export interface SwitchToGameOptions {
    revisionId?: string | null;
    sessionId?: string | null;
}

export function activateGameStations(
    game: GameOption,
    options?: SwitchToGameOptions,
): void {
    // Ignore the selection published by switchToGame, not restored or user-edited
    // options. The current ID alone cannot distinguish those initialization paths.
    if (
        !options &&
        currentGameId.get() === game.id &&
        displayHidingZonesOptions.get() === publishedGameOptions
    )
        return;
    switchToGame(game, options);
}

/** True while switchToGame is loading a definition that hasn't been applied. */
export function isGameSwitchPending(): boolean {
    return pendingGameSwitch !== undefined;
}

export function switchToGame(
    game: GameOption,
    options?: SwitchToGameOptions,
): Promise<boolean> {
    // Resolve the scope before publishing selection. Session initialization may
    // supply a pin before activeSessionData has been populated.
    const currentSession = activeSessionData.get();
    const startingSessionId = activeSessionId.get();
    const isSessionGame = Boolean(
        currentSession &&
            (currentSession.gameId === game.id ||
                currentSession.gameId === game.gameKey),
    );
    const sessionId =
        options?.sessionId !== undefined
            ? (options.sessionId ?? undefined)
            : isSessionGame
              ? currentSession?.id
              : undefined;
    const targetRevisionId =
        options?.revisionId !== undefined
            ? (options.revisionId ?? undefined)
            : isSessionGame
              ? (currentSession?.gameRevisionId ?? undefined)
              : undefined;
    const isSession = Boolean(sessionId || isSessionGame);
    const key = JSON.stringify([
        game.id,
        targetRevisionId ?? null,
        sessionId ?? null,
        isSession,
    ]);
    if (pendingGameSwitch?.key === key) return pendingGameSwitch.promise;

    const generation = ++gameSwitchGeneration;
    // Register the switch before notifying atom subscribers so reentrant callers
    // share the same outcome instead of superseding the original caller.
    const selection: PendingGameSwitch = {
        key,
        definition:
            game.id && !(isSession && !targetRevisionId)
                ? loadGameDefinition(game.id, targetRevisionId, sessionId)
                : undefined,
        promise: Promise.resolve()
            .then(async () => {
                if (isSession && !targetRevisionId) {
                    console.warn(
                        "[games] Session game requires a pinned revision ID; refusing unpinned/fallback load",
                    );
                    return false;
                }
                if (!selection.definition) return false;

                try {
                    const definition = await selection.definition;
                    if (
                        generation !== gameSwitchGeneration ||
                        activeSessionId.get() !== startingSessionId
                    ) return false;
                    applyGameDefinition(definition);
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

    gameDefinitionReady.set(false);
    clearTentacleCache();
    setActiveGameDefinition(null);
    customStations.set([]);
    trainStations.set([]);
    useCustomStations.set(false);
    includeDefaultStations.set(false);
    polyGeoJSON.set(null);
    mapGeoJSON.set(null);
    additionalMapGeoLocations.set([]);
    disabledStations.set([]);
    permanentOverlay.set(null);
    hidingZoneFocusedStationID.set("");

    // The sidebar observes zone options; publish the owning selection first.
    writeStorage("sessionStorage", GAME_SS_KEY, game.id);
    currentGameId.set(game.id);
    publishedGameOptions = [game.gameKey];
    displayHidingZonesOptions.set(publishedGameOptions);
    displayHidingZones.set(true);
    displayHidingZonesStyle.set("zones");
    return selection.promise;
}
