import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDefinition, GameSessionSummary } from "@searchlight/shared";
import * as turf from "@turf/turf";
import {
    applyGameDefinition,
    currentGameId,
    fetchGameCatalog,
    leaveGame,
    resetGameState,
    switchToGame,
} from "@/lib/games";
import {
    cacheRevisionDefinition,
    clearDefinitionCache,
    compiledGameAtom,
    getCachedRevisionDefinition,
    setActiveGameDefinition,
} from "@/game-definition/store";
import {
    activeSessionId,
    clearActiveSession,
    setActiveSession,
} from "@/lib/activeSession";
import {
    gameDefinitionReady,
    mapGeoJSON,
    polyGeoJSON,
    questions,
    trainStations,
} from "@/lib/context";
import { isQuestionSaveSuppressed } from "@/lib/questionSaveSuppress";
import { hidingZoneCircles } from "@/maps/geo-utils";
import type { Questions } from "@/maps/schema";

const game = {
    id: "loading-game",
    gameKey: "loading-game-key",
    label: "Loading game",
    serverId: "server",
    serverName: "Server",
    size: "medium",
};

function definition(radius: number): GameDefinition {
    return {
        id: game.id,
        name: `Game ${radius}`,
        serverId: game.serverId,
        map: {
            center: [0, 0],
            playArea: { type: "FeatureCollection", features: [] },
        },
        hidingZones: {
            radius,
            features: {
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        geometry: { type: "Point", coordinates: [0, 0] },
                        properties: { name: "Station" },
                    },
                ],
            },
        },
    };
}

// A session playing `game`, pinned to a revision.
const pinnedSession = {
    id: "session-one",
    name: "Session one",
    gameId: game.id,
    serverId: game.serverId,
    gameRevisionId: "revision-one",
} as GameSessionSummary;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function response(radius: number): Response {
    return new Response(JSON.stringify(definition(radius)), { status: 200 });
}

// Every switch loads a session's pinned revision.
const pinned = { revisionId: "revision-one", sessionId: "session-one" };

/** The game-wide hiding radius of the applied definition. */
const appliedRadius = () =>
    compiledGameAtom.get()?.hidingZones.baseRadius.value;

describe("game loading concurrency", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        });
        clearDefinitionCache();
        clearActiveSession();
        setActiveGameDefinition(null);
        currentGameId.set("");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        clearDefinitionCache();
        clearActiveSession();
        setActiveGameDefinition(null);
    });

    it("leaving a game cancels its switch still loading", async () => {
        setActiveSession(pinnedSession);
        const request = deferred<Response>();
        vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);
        // A revision upgrade is loading when another session is selected.
        const upgrade = switchToGame(game, {
            revisionId: "revision-two",
            sessionId: pinnedSession.id,
        });
        leaveGame();
        request.resolve(response(900));
        expect(await upgrade).toBe(false);
        expect(compiledGameAtom.get()).toBeNull();
        expect(gameDefinitionReady.get()).toBe(false);
        expect(currentGameId.get()).toBe("");
    });

    it("reads a server's game catalog", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
            String(input).includes("/games?")
                ? Response.json({
                      games: [{ ...game, id: "other-game", serverId: "other" }],
                  })
                : Response.json({ servers: [] }),
        );
        expect(
            (await fetchGameCatalog("other")).map((entry) => entry.id),
        ).toEqual(["other-game"]);
    });

    it("gives concurrent callers one successful selection", async () => {
        const request = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValue(request.promise);
        const first = switchToGame(game, pinned);
        const second = switchToGame(game, pinned);
        request.resolve(response(400));
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toContain(
            "/revisions/revision-one?sessionId=session-one",
        );
        expect(appliedRadius()).toBe(400);
        expect(gameDefinitionReady.get()).toBe(true);
    });

    it("reuses an in-flight target when selected again without allowing an intervening completion to overwrite it", async () => {
        const otherGame = { ...game, id: "other-game", gameKey: "other-key" };
        const firstRequest = deferred<Response>();
        const otherRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(firstRequest.promise)
            .mockReturnValueOnce(otherRequest.promise);
        const first = switchToGame(game, pinned);
        const other = switchToGame(otherGame, pinned);
        const latest = switchToGame(game, pinned);
        firstRequest.resolve(response(600));
        expect(await Promise.all([first, latest])).toEqual([false, true]);
        otherRequest.resolve(response(900));
        expect(await other).toBe(false);
        expect(currentGameId.get()).toBe(game.id);
        expect(appliedRadius()).toBe(600);
        expect(gameDefinitionReady.get()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not apply a pending revision after its active session is cleared", async () => {
        activeSessionId.set("session-one");
        const request = deferred<Response>();
        vi.spyOn(globalThis, "fetch").mockReturnValue(request.promise);
        const loaded = switchToGame(game, {
            revisionId: "revision-two",
            sessionId: "session-one",
        });
        clearActiveSession();
        request.resolve(response(900));

        expect(await loaded).toBe(false);
        expect(compiledGameAtom.get()).toBeNull();
        expect(gameDefinitionReady.get()).toBe(false);
    });

    it("isolates session access for the same pinned revision, including fulfilled cache entries", async () => {
        const firstRequest = deferred<Response>();
        const secondRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(firstRequest.promise)
            .mockReturnValueOnce(secondRequest.promise);
        const firstOptions = {
            revisionId: "revision-one",
            sessionId: "session-one",
        };
        const secondOptions = {
            revisionId: "revision-one",
            sessionId: "session-two",
        };
        const first = switchToGame(game, firstOptions);
        const second = switchToGame(game, secondOptions);
        secondRequest.resolve(response(700));
        expect(await second).toBe(true);
        firstRequest.resolve(response(300));
        expect(await first).toBe(false);
        expect(appliedRadius()).toBe(700);
        expect(await switchToGame(game, firstOptions)).toBe(true);
        expect(appliedRadius()).toBe(300);
        expect(await switchToGame(game, secondOptions)).toBe(true);
        expect(appliedRadius()).toBe(700);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("keeps concurrent revisions isolated", async () => {
        const firstRequest = deferred<Response>();
        const secondRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(firstRequest.promise)
            .mockReturnValueOnce(secondRequest.promise);
        const revisionTwo = { ...pinned, revisionId: "revision-two" };
        const first = switchToGame(game, pinned);
        const second = switchToGame(game, revisionTwo);
        secondRequest.resolve(response(800));
        expect(await second).toBe(true);
        firstRequest.resolve(response(200));
        expect(await first).toBe(false);
        expect(appliedRadius()).toBe(800);
        expect(await switchToGame(game, pinned)).toBe(true);
        expect(appliedRadius()).toBe(200);
        expect(
            fetchSpy.mock.calls.map(([url]) => new URL(String(url)).pathname),
        ).toEqual([
            `/games/${game.id}/revisions/revision-one`,
            `/games/${game.id}/revisions/revision-two`,
        ]);
    });

    it("clears stale game state after failure and evicts the failed request for retry", async () => {
        applyGameDefinition(definition(100));
        const failedRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(failedRequest.promise)
            .mockResolvedValueOnce(response(900));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const failed = switchToGame(game, pinned);
        failedRequest.reject(new Error("Connection lost"));
        expect(await failed).toBe(false);
        expect(compiledGameAtom.get()).toBeNull();
        expect(trainStations.get()).toEqual([]);
        expect(mapGeoJSON.get()).toBeNull();
        expect(gameDefinitionReady.get()).toBe(false);
        expect(await switchToGame(game, pinned)).toBe(true);
        expect(appliedRadius()).toBe(900);
        expect(gameDefinitionReady.get()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("hides unsupported questions without publishing them as a local edit", () => {
        const radius = { id: "radius", data: { lat: 1, lng: 2 } };
        const custom = {
            id: "matching",
            data: { type: "custom-points", lat: 1, lng: 2 },
        };
        questions.set([radius, custom] as unknown as Questions);
        try {
            // A session load applies the definition while the outgoing session
            // is still active; the filtered list must not be saved into it.
            applyGameDefinition(definition(100));
            expect(questions.get()).toEqual([custom]);
            expect(isQuestionSaveSuppressed(questions.get())).toBe(true);
            // The player's next edit publishes a new list, which still saves.
            expect(isQuestionSaveSuppressed([...questions.get()])).toBe(false);
        } finally {
            questions.set([]);
        }
    });

    it("uses the game-wide radius even when a zone with ID 0 has its own", () => {
        const zoned = definition(400);
        zoned.hidingZones.unit = "kilometers";
        Object.assign(zoned.hidingZones.features.features[0], {
            id: 0,
            properties: { name: "Station", radius: 2 },
        });
        applyGameDefinition(zoned);
        expect(compiledGameAtom.get()?.hidingZones.baseRadius).toEqual({
            value: 400,
            unit: "kilometers",
        });
        const [zone] = hidingZoneCircles(compiledGameAtom.get()!);
        expect(zone.properties.properties).toEqual({ id: "0", name: "Station" });
        // A 2 km circle, not the game-wide 400 km.
        const [west, , east] = turf.bbox(zone);
        expect(turf.distance([west, 0], [east, 0])).toBeCloseTo(4, 1);
    });

    it("bounds session-scoped full definitions while retaining recently visited revisions", () => {
        for (let index = 0; index < 5; index++) {
            cacheRevisionDefinition(
                game.id,
                `revision-${index}`,
                definition(index),
                `session-${index}`,
            );
        }
        expect(
            getCachedRevisionDefinition(game.id, "revision-0", "session-0"),
        ).toBeUndefined();
        expect(
            getCachedRevisionDefinition(game.id, "revision-1", "session-1"),
        ).toBeDefined();
        expect(
            getCachedRevisionDefinition(game.id, "revision-2", "session-2"),
        ).toBeDefined();
        cacheRevisionDefinition(
            game.id,
            "revision-5",
            definition(5),
            "session-5",
        );
        expect(
            getCachedRevisionDefinition(game.id, "revision-3", "session-3"),
        ).toBeUndefined();
        expect(
            getCachedRevisionDefinition(game.id, "revision-1", "session-1"),
        ).toBeDefined();
    });
});

describe("leaving a game", () => {
    beforeEach(() => {
        vi.stubGlobal("sessionStorage", {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setActiveGameDefinition(null);
    });

    it("clears the game's board, so a failed session switch leaves no other game behind", () => {
        applyGameDefinition(definition(500));
        currentGameId.set(game.id);
        trainStations.set(hidingZoneCircles(compiledGameAtom.get()!));
        expect(trainStations.get()).not.toEqual([]);
        expect(polyGeoJSON.get()).not.toBeNull();

        resetGameState();

        expect(compiledGameAtom.get()).toBeNull();
        expect(gameDefinitionReady.get()).toBe(false);
        expect(polyGeoJSON.get()).toBeNull();
        expect(mapGeoJSON.get()).toBeNull();
        expect(trainStations.get()).toEqual([]);
        expect(currentGameId.get()).toBe("");
    });
});
