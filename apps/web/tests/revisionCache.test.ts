import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
    clearStoredRevisions,
    MAX_STORED_REVISIONS,
    readStoredRevision,
    storeRevision,
} from "@/game-definition/revisionCache";
import { clearDefinitionCache, loadGameDefinition } from "@/game-definition/store";

// ── Cache API fake ───────────────────────────────────────────────────────────
// Node has no Cache API. This keeps responses in memory, in insertion order.
const urlOf = (request: RequestInfo | URL) =>
    typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request.url;

class FakeCache {
    readonly entries = new Map<string, Response>();
    async put(request: RequestInfo | URL, response: Response) {
        const url = urlOf(request);
        this.entries.delete(url);
        this.entries.set(url, response);
    }
    async match(request: RequestInfo | URL) {
        return this.entries.get(urlOf(request))?.clone();
    }
    async keys() {
        return [...this.entries.keys()].map((url) => new Request(url));
    }
    async delete(request: RequestInfo | URL) {
        return this.entries.delete(urlOf(request));
    }
}

class FakeCacheStorage {
    readonly caches = new Map<string, FakeCache>();
    async open(name: string) {
        let cache = this.caches.get(name);
        if (!cache) this.caches.set(name, (cache = new FakeCache()));
        return cache;
    }
    async delete(name: string) {
        return this.caches.delete(name);
    }
}

function definition(name: string): GameDefinition {
    return {
        id: "game",
        name,
        serverId: "server",
        map: {
            center: [0, 0],
            playArea: { type: "FeatureCollection", features: [] },
        },
    } as unknown as GameDefinition;
}

let storage: FakeCacheStorage;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    storage = new FakeCacheStorage();
    vi.stubGlobal("caches", storage);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    clearDefinitionCache();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const tick = () => vi.setSystemTime(Date.now() + 1);

describe("kept game revisions", () => {
    test("come back as stored, per game and revision", async () => {
        await storeRevision("game", "r1", definition("one"));
        expect(await readStoredRevision("game", "r1")).toEqual(
            definition("one"),
        );
        expect(await readStoredRevision("game", "r2")).toBeUndefined();
        expect(await readStoredRevision("other", "r1")).toBeUndefined();
    });

    test("keep only the most recently used ones", async () => {
        for (let i = 1; i <= MAX_STORED_REVISIONS; i++) {
            await storeRevision("game", `r${i}`, definition(`${i}`));
            tick();
        }
        // The oldest is read again, as a session still playing it would.
        expect(await readStoredRevision("game", "r1")).toBeDefined();
        tick();
        await storeRevision("game", "new", definition("new"));

        expect(await readStoredRevision("game", "r1")).toBeDefined();
        expect(await readStoredRevision("game", "r2")).toBeUndefined();
        expect(await readStoredRevision("game", "new")).toBeDefined();
        const [cache] = storage.caches.values();
        expect(cache.entries.size).toBe(MAX_STORED_REVISIONS);
    });

    test("drop an unreadable copy", async () => {
        await storeRevision("game", "r1", definition("one"));
        const [cache] = storage.caches.values();
        const [url] = cache.entries.keys();
        cache.entries.set(url, new Response("{not json"));

        expect(await readStoredRevision("game", "r1")).toBeUndefined();
        expect(cache.entries.size).toBe(0);
    });

    test("are all forgotten on clear", async () => {
        await storeRevision("game", "r1", definition("one"));
        await clearStoredRevisions();
        expect(await readStoredRevision("game", "r1")).toBeUndefined();
    });

    test("are skipped without the Cache API, or when it refuses", async () => {
        vi.stubGlobal("caches", undefined);
        await storeRevision("game", "r1", definition("one"));
        expect(await readStoredRevision("game", "r1")).toBeUndefined();
        await clearStoredRevisions();

        vi.stubGlobal("caches", {
            open: () => Promise.reject(new DOMException("denied")),
            delete: () => Promise.reject(new DOMException("denied")),
        });
        await storeRevision("game", "r1", definition("one"));
        expect(await readStoredRevision("game", "r1")).toBeUndefined();
        await clearStoredRevisions();
    });

    test("survive a full disk as a no-op", async () => {
        const cache = await storage.open("searchlight-game-revisions");
        vi.spyOn(cache, "put").mockRejectedValue(
            new DOMException("full", "QuotaExceededError"),
        );
        await expect(
            storeRevision("game", "r1", definition("one")),
        ).resolves.toBeUndefined();
    });
});

describe("loading a session's game revision", () => {
    test("keeps what the server sent and reads it back without it", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(
                new Response(JSON.stringify(definition("served"))),
            );
        expect(await loadGameDefinition("game", "r1", "s1")).toEqual(
            definition("served"),
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        // Stored in the background.
        await vi.waitFor(async () =>
            expect(await readStoredRevision("game", "r1")).toBeDefined(),
        );

        // A reload, with the server out of reach.
        clearDefinitionCache();
        fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
        expect(await loadGameDefinition("game", "r1", "s1")).toEqual(
            definition("served"),
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test("never keeps an error", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("Bad gateway", { status: 502 }));
        await expect(loadGameDefinition("game", "r1", "s1")).rejects.toThrow(
            "502",
        );
        expect(fetchSpy).toHaveBeenCalled();
        expect(await readStoredRevision("game", "r1")).toBeUndefined();

        clearDefinitionCache();
        fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(loadGameDefinition("game", "r1", "s1")).rejects.toThrow();
    });
});
