import { readFileSync } from "node:fs";

import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    _resetLocalStoreForTests,
    clearLastLocalSessionId,
    createLocalSession,
    deleteLocalGame,
    deleteLocalSession,
    getLocalGameDefinition,
    getLocalSession,
    listLocalGames,
    listLocalSessions,
    readLastLocalSessionId,
    saveLocalGame,
    updateLocalSession,
    writeLastLocalSessionId,
} from "@/lib/localStore";

function makeMemoryStorage() {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
        clear: () => map.clear(),
    };
}

const parisFixture: GameDefinition = JSON.parse(
    readFileSync(
        new URL("./fixtures/games/paris-2026.game.json", import.meta.url),
        "utf8",
    ),
);

const stockholmFixture: GameDefinition = JSON.parse(
    readFileSync(
        new URL("./fixtures/games/stockholm-2026.game.json", import.meta.url),
        "utf8",
    ),
);

beforeEach(() => {
    _resetLocalStoreForTests();
    vi.stubGlobal("localStorage", makeMemoryStorage());
    vi.stubGlobal("sessionStorage", makeMemoryStorage());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("localStore", () => {
    it("deduplicates identical game definitions by content checksum", async () => {
        const first = await saveLocalGame(parisFixture, {
            kind: "file",
            label: "paris.game.json",
        });
        const second = await saveLocalGame(structuredClone(parisFixture), {
            kind: "url",
            label: "example.com",
            url: "https://example.com/paris.game.json",
        });

        expect(second.id).toBe(first.id);
        const games = await listLocalGames();
        expect(games).toHaveLength(1);
        expect(games[0].name).toBe(parisFixture.name);
        expect(games[0].zoneCount).toBe(
            parisFixture.hidingZones.features.features.length,
        );

        const loaded = await getLocalGameDefinition(first.id);
        expect(loaded?.name).toBe(parisFixture.name);
    });

    it("supports multiple local sessions per game and patches fields without clobbering", async () => {
        const game = await saveLocalGame(parisFixture, {
            kind: "file",
            label: "paris.game.json",
        });

        const s1 = await createLocalSession(game, "Round 1");
        const s2 = await createLocalSession(game, "Round 2");

        await updateLocalSession(s1.id, {
            disabledZones: ["zone-a"],
            planningMode: true,
        });
        await updateLocalSession(s1.id, {
            hiderMode: { latitude: 48.85, longitude: 2.35 },
        });

        const reloaded1 = await getLocalSession(s1.id);
        expect(reloaded1?.disabledZones).toEqual(["zone-a"]);
        expect(reloaded1?.planningMode).toBe(true);
        expect(reloaded1?.hiderMode).toEqual({
            latitude: 48.85,
            longitude: 2.35,
        });

        const reloaded2 = await getLocalSession(s2.id);
        expect(reloaded2?.disabledZones).toEqual([]);
        expect(reloaded2?.planningMode).toBe(false);

        const summaries = await listLocalSessions();
        expect(summaries.map((s) => s.name).sort()).toEqual([
            "Round 1",
            "Round 2",
        ]);
    });

    it("keeps the saved game when deleting a session, and cascades when deleting a game", async () => {
        const paris = await saveLocalGame(parisFixture, {
            kind: "file",
            label: "paris.game.json",
        });
        const stockholm = await saveLocalGame(stockholmFixture, {
            kind: "file",
            label: "stockholm.game.json",
        });

        const p1 = await createLocalSession(paris, "Paris 1");
        const p2 = await createLocalSession(paris, "Paris 2");
        const st1 = await createLocalSession(stockholm, "Stockholm 1");

        await deleteLocalSession(p1.id);
        expect(await getLocalSession(p1.id)).toBeNull();
        expect(await getLocalGameDefinition(paris.id)).not.toBeNull();

        const deletedIds = await deleteLocalGame(paris.id);
        expect(deletedIds).toEqual([p2.id]);
        expect(await getLocalSession(p2.id)).toBeNull();
        expect(await getLocalGameDefinition(paris.id)).toBeNull();

        // Other games and their sessions stay untouched.
        expect(await getLocalSession(st1.id)).not.toBeNull();
        expect((await listLocalGames()).map((g) => g.id)).toEqual([
            stockholm.id,
        ]);
    });

    it("stores the last local session pointer completely isolated from online taibled-* keys", () => {
        localStorage.setItem("taibled-last-session", "online-session-1");
        sessionStorage.setItem("taibled-active-session", "online-session-1");

        expect(readLastLocalSessionId()).toBe("");
        writeLastLocalSessionId("local-session-42");
        expect(readLastLocalSessionId()).toBe("local-session-42");

        clearLastLocalSessionId();
        expect(readLastLocalSessionId()).toBe("");

        // Online keys were never touched.
        expect(localStorage.getItem("taibled-last-session")).toBe(
            "online-session-1",
        );
        expect(sessionStorage.getItem("taibled-active-session")).toBe(
            "online-session-1",
        );
    });

    it("rejects createLocalSession when the saved game definition is missing (in-memory fallback)", async () => {
        const game = await saveLocalGame(parisFixture, {
            kind: "file",
            label: "paris.game.json",
        });
        await deleteLocalGame(game.id);

        await expect(createLocalSession(game, "Orphan")).rejects.toThrow(
            "This saved game was removed from browser storage.",
        );
        expect(await listLocalSessions()).toEqual([]);
    });

    it("atomically checks gameDefinitions inside IndexedDB transaction in createLocalSession", async () => {
        const stores = new Map<string, Map<string, unknown>>([
            ["gameMeta", new Map()],
            ["gameDefinitions", new Map()],
            ["sessions", new Map()],
        ]);
        const openedTransactions: Array<{
            storeNames: string[];
            mode: string;
        }> = [];

        const fakeDb = {
            objectStoreNames: {
                contains: (name: string) => stores.has(name),
            },
            close: () => {},
            transaction: (
                names: string | string[],
                mode: string,
            ) => {
                const storeNames = Array.isArray(names) ? names : [names];
                openedTransactions.push({ storeNames, mode });
                const tx: any = {
                    oncomplete: null,
                    onerror: null,
                    onabort: null,
                    error: null,
                    objectStore: (storeName: string) => {
                        const map = stores.get(storeName)!;
                        return {
                            get: (key: string) => {
                                const req: any = {
                                    result: undefined,
                                    onsuccess: null,
                                    onerror: null,
                                };
                                queueMicrotask(() => {
                                    req.result = map.get(key);
                                    req.onsuccess?.();
                                });
                                return req;
                            },
                            put: (value: { id: string }) => {
                                map.set(value.id, structuredClone(value));
                                const req: any = {
                                    result: value.id,
                                    onsuccess: null,
                                    onerror: null,
                                };
                                queueMicrotask(() => req.onsuccess?.());
                                return req;
                            },
                            delete: (key: string) => {
                                map.delete(key);
                                const req: any = {
                                    result: undefined,
                                    onsuccess: null,
                                    onerror: null,
                                };
                                queueMicrotask(() => req.onsuccess?.());
                                return req;
                            },
                            getAll: () => {
                                const req: any = {
                                    result: [...map.values()].map((v) =>
                                        structuredClone(v),
                                    ),
                                    onsuccess: null,
                                    onerror: null,
                                };
                                queueMicrotask(() => req.onsuccess?.());
                                return req;
                            },
                        };
                    },
                };
                // Complete the transaction after pending microtasks drain.
                setTimeout(() => {
                    tx.oncomplete?.();
                }, 0);
                return tx;
            },
        };

        vi.stubGlobal("indexedDB", {
            open: () => {
                const req: any = {
                    result: fakeDb,
                    onsuccess: null,
                    onerror: null,
                    onupgradeneeded: null,
                    onblocked: null,
                };
                queueMicrotask(() => req.onsuccess?.());
                return req;
            },
        });
        _resetLocalStoreForTests();

        const game = await saveLocalGame(parisFixture, {
            kind: "file",
            label: "paris.game.json",
        });

        // Present definition: creates session inside single readwrite tx across both stores.
        openedTransactions.length = 0;
        const created = await createLocalSession(game, "Valid Session");
        expect(created.gameId).toBe(game.id);
        expect(openedTransactions).toEqual([
            { storeNames: ["gameDefinitions", "sessions"], mode: "readwrite" },
        ]);
        expect(stores.get("sessions")!.has(created.id)).toBe(true);

        // Remove definition concurrently before createLocalSession runs.
        stores.get("gameDefinitions")!.delete(game.id);
        const sessionCountBefore = stores.get("sessions")!.size;
        await expect(createLocalSession(game, "Orphan IDB")).rejects.toThrow(
            "This saved game was removed from browser storage.",
        );
        expect(stores.get("sessions")!.size).toBe(sessionCountBefore);
    });
});
