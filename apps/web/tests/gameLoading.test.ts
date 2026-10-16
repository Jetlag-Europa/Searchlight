import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameDefinition } from "@searchlight/shared";
import {
    activateGameStations,
    applyGameDefinition,
    currentGameId,
    fetchGames,
    gamesAtom,
    gamesLoadingAtom,
    resolveSessionGame,
    switchToGame,
    type GameOption,
} from "@/lib/games";
import {
    cacheRevisionDefinition,
    clearDefinitionCache,
    compiledGameAtom,
    getCachedRevisionDefinition,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { activeSessionId, clearActiveSession } from "@/lib/activeSession";
import {
    customStations,
    displayHidingZonesOptions,
    gameDefinitionReady,
    hidingRadius,
    hidingRadiusUnits,
    mapGeoJSON,
    questions,
    useCustomStations,
} from "@/lib/context";
import { isQuestionSaveSuppressed } from "@/lib/questionSaveSuppress";
import type { Questions } from "@/maps/schema";

const game: GameOption = {
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
        displayHidingZonesOptions.set([]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        clearDefinitionCache();
        clearActiveSession();
        setActiveGameDefinition(null);
    });

    it("does not reenter a pinned switch when the sidebar observes its published selection", async () => {
        const request = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValue(request.promise);
        const unsubscribe = displayHidingZonesOptions.listen((options) => {
            if (options.includes(game.gameKey)) activateGameStations(game);
        });
        try {
            const loaded = switchToGame(game, {
                revisionId: "revision-one",
                sessionId: "session-one",
            });
            request.resolve(response(300));
            expect(await loaded).toBe(true);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(String(fetchSpy.mock.calls[0][0])).toContain(
                "/revisions/revision-one?sessionId=session-one",
            );
            expect(hidingRadius.get()).toBe(300);
            expect(gameDefinitionReady.get()).toBe(true);
        } finally {
            unsubscribe();
        }
    });

    it("activates a restored same-ID selection and reactivates it after deselection", async () => {
        currentGameId.set(game.id);
        displayHidingZonesOptions.set([game.gameKey]);
        const request = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(request.promise)
            .mockImplementation(async () => response(350));
        activateGameStations(game);
        const loaded = switchToGame(game);
        request.resolve(response(350));
        expect(await loaded).toBe(true);
        expect(useCustomStations.get()).toBe(true);

        displayHidingZonesOptions.set([]);
        useCustomStations.set(false);
        displayHidingZonesOptions.set([game.gameKey]);
        activateGameStations(game);
        expect(await switchToGame(game)).toBe(true);
        expect(useCustomStations.get()).toBe(true);
        // Selecting the game again loads its latest definition again.
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("gives concurrent callers one successful selection", async () => {
        const request = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValue(request.promise);
        const first = switchToGame(game);
        const second = switchToGame(game);
        request.resolve(response(400));
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(hidingRadius.get()).toBe(400);
    });

    it("loads a game's latest definition afresh, so a newly published revision applies", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValueOnce(response(100))
            .mockResolvedValueOnce(response(500));
        expect(await switchToGame(game)).toBe(true);
        expect(hidingRadius.get()).toBe(100);
        expect(await switchToGame(game)).toBe(true);
        expect(hidingRadius.get()).toBe(500);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("reuses an in-flight target when selected again without allowing an intervening completion to overwrite it", async () => {
        const otherGame = { ...game, id: "other-game", gameKey: "other-key" };
        const firstRequest = deferred<Response>();
        const otherRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(firstRequest.promise)
            .mockReturnValueOnce(otherRequest.promise);
        const first = switchToGame(game);
        const other = switchToGame(otherGame);
        const latest = switchToGame(game);
        firstRequest.resolve(response(600));
        expect(await Promise.all([first, latest])).toEqual([false, true]);
        otherRequest.resolve(response(900));
        expect(await other).toBe(false);
        expect(currentGameId.get()).toBe(game.id);
        expect(hidingRadius.get()).toBe(600);
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
        expect(hidingRadius.get()).toBe(700);
        expect(await switchToGame(game, firstOptions)).toBe(true);
        expect(hidingRadius.get()).toBe(300);
        expect(await switchToGame(game, secondOptions)).toBe(true);
        expect(hidingRadius.get()).toBe(700);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("honors explicit revisions without a session and keeps concurrent revisions isolated", async () => {
        const firstRequest = deferred<Response>();
        const secondRequest = deferred<Response>();
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockReturnValueOnce(firstRequest.promise)
            .mockReturnValueOnce(secondRequest.promise);
        const first = switchToGame(game, { revisionId: "revision-one" });
        const second = switchToGame(game, { revisionId: "revision-two" });
        secondRequest.resolve(response(800));
        expect(await second).toBe(true);
        firstRequest.resolve(response(200));
        expect(await first).toBe(false);
        expect(hidingRadius.get()).toBe(800);
        expect(await switchToGame(game, { revisionId: "revision-one" })).toBe(
            true,
        );
        expect(hidingRadius.get()).toBe(200);
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
        const failed = switchToGame(game);
        failedRequest.reject(new Error("Connection lost"));
        expect(await failed).toBe(false);
        expect(compiledGameAtom.get()).toBeNull();
        expect(customStations.get()).toEqual([]);
        expect(mapGeoJSON.get()).toBeNull();
        expect(gameDefinitionReady.get()).toBe(false);
        expect(await switchToGame(game)).toBe(true);
        expect(hidingRadius.get()).toBe(900);
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
        expect(hidingRadius.get()).toBe(400);
        expect(hidingRadiusUnits.get()).toBe("kilometers");
        expect(customStations.get()).toEqual([
            { id: "0", name: "Station", lat: 0, lng: 0, radius: 2, unit: "kilometers" },
        ]);
    });

    it("keeps the newest server catalog visible while older loads finish", async () => {
        const olderGames = deferred<Response>();
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = new URL(String(input));
            if (
                url.pathname === "/games" &&
                url.searchParams.get("serverId") === "older"
            ) {
                return olderGames.promise;
            }
            if (url.pathname === "/games") {
                return new Response(
                    JSON.stringify({
                        games: [
                            { ...game, id: "newer-game", serverId: "newer" },
                        ],
                    }),
                    { status: 200 },
                );
            }
            return new Response(JSON.stringify({ servers: [] }), {
                status: 200,
            });
        });
        const older = fetchGames("older");
        const newer = fetchGames("newer");
        await newer;
        expect(gamesAtom.get().map((entry) => entry.id)).toEqual([
            "newer-game",
        ]);
        expect(gamesLoadingAtom.get()).toBe(true);
        olderGames.resolve(
            new Response(
                JSON.stringify({
                    games: [{ ...game, id: "older-game", serverId: "older" }],
                }),
                { status: 200 },
            ),
        );
        await older;
        expect(gamesAtom.get().map((entry) => entry.id)).toEqual([
            "newer-game",
        ]);
        expect(gamesLoadingAtom.get()).toBe(false);
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

describe("resolveSessionGame", () => {
    const session = {
        id: "session-1",
        gameId: "game-db-id",
        serverId: "server-1",
        name: "Friday game",
        gameName: "Paris 2026",
    } as Parameters<typeof resolveSessionGame>[0];

    afterEach(() => {
        vi.restoreAllMocks();
        gamesAtom.set([]);
    });

    it("loads a session's game when the catalog refuses the participant", async () => {
        // A participant who joined by link may not belong to the game's server:
        // the catalog answers 403, but the pinned revision is still theirs.
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("Forbidden", { status: 403 }),
        );
        vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(await resolveSessionGame(session)).toEqual({
            id: "game-db-id",
            gameKey: "game-db-id",
            label: "Paris 2026",
            serverId: "server-1",
            serverName: "server-1",
            size: "medium",
        });
    });

    it("uses the catalog entry when the catalog is available", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
            String(input).includes("/games?")
                ? Response.json({
                      games: [
                          {
                              id: "game-db-id",
                              gameKey: "paris-2026",
                              name: "Paris 15-08",
                              serverId: "server-1",
                              size: "large",
                          },
                      ],
                  })
                : Response.json({ servers: [{ id: "server-1", name: "JetLag EU" }] }),
        );
        expect(await resolveSessionGame(session)).toMatchObject({
            gameKey: "paris-2026",
            label: "Paris 15-08",
            serverName: "JetLag EU",
        });
    });
});
