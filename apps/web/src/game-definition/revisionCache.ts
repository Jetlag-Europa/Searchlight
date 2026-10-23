import type { GameDefinition } from "@searchlight/shared";

import { STORED_USER_KEY } from "@/lib/activeSession";
import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

// The game revisions this browser loaded for its sessions, kept across
// reloads so a session's game opens while the server can't be reached. A
// revision never changes once imported (the API only ever creates them, and
// serves each with its checksum as ETag); the `sessionId` it was loaded with
// only grants access. So a kept copy is good for as long as it's kept.
// Definitions run to several MB, too much for localStorage: they go in the
// Cache API, which privacy modes may refuse. Then nothing is kept.
const CACHE_PREFIX = "searchlight-game-revisions";
// A new version starts afresh, if what's kept changes shape.
const CACHE_NAME = `${CACHE_PREFIX}-v1`;
// The active session's revision and the last few others.
export const MAX_STORED_REVISIONS = 4;
// When each copy was last stored or read, newest last. Small, so touching
// a copy doesn't mean writing its MBs again.
const INDEX_KEY = "taibled-kept-revisions";

// A key only: nothing is ever fetched from it.
function revisionKey(gameId: string, revisionId: string): string {
    return `https://game-revisions.invalid/${encodeURIComponent(gameId)}/${encodeURIComponent(revisionId)}`;
}

async function openCache(): Promise<Cache | null> {
    try {
        if (typeof caches === "undefined") return null;
        return await caches.open(CACHE_NAME);
    } catch {
        return null;
    }
}

function readIndex(): string[] {
    try {
        const parsed = JSON.parse(
            readStorage("localStorage", INDEX_KEY) ?? "[]",
        ) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((key): key is string => typeof key === "string")
            : [];
    } catch {
        return [];
    }
}

// `key` was just used; returns the keys that no longer fit.
function touch(key: string): string[] {
    const index = [...readIndex().filter((k) => k !== key), key];
    const dropped = index.slice(0, Math.max(0, index.length - MAX_STORED_REVISIONS));
    writeStorage(
        "localStorage",
        INDEX_KEY,
        JSON.stringify(index.slice(dropped.length)),
    );
    return dropped;
}

/** The kept copy of a game revision, if this browser has one. */
export async function readStoredRevision(
    gameId: string,
    revisionId: string,
): Promise<GameDefinition | undefined> {
    const cache = await openCache();
    if (!cache) return undefined;
    const key = revisionKey(gameId, revisionId);
    try {
        const response = await cache.match(key);
        if (!response) return undefined;
        const definition = (await response.json()) as unknown;
        if (!definition || typeof definition !== "object") {
            throw new Error("not a game definition");
        }
        // Reading a copy makes it the most recent one, so the revision a
        // session keeps playing isn't the next one pruned.
        touch(key);
        return definition as GameDefinition;
    } catch (err) {
        console.warn("[searchlight:revisions] dropping unreadable copy", err);
        await dropStoredRevision(gameId, revisionId);
        return undefined;
    }
}

/**
 * Keep a game revision loaded from the server, as the JSON it came as.
 * Best-effort, and only while an account is stored: a load finishing after
 * logging out (here or in another tab) keeps nothing.
 */
export async function storeRevision(
    gameId: string,
    revisionId: string,
    json: string,
): Promise<void> {
    if (!readStorage("localStorage", STORED_USER_KEY)) return;
    const cache = await openCache();
    if (!cache) return;
    const key = revisionKey(gameId, revisionId);
    try {
        await cache.put(
            key,
            new Response(json, {
                headers: { "Content-Type": "application/json" },
            }),
        );
        // Copies no longer in the index (pruned, or kept by an index that
        // was cleared) go too.
        const dropped = new Set(touch(key));
        const index = new Set(readIndex());
        await Promise.all(
            (await cache.keys())
                .filter(
                    (request) =>
                        request.url !== key &&
                        (dropped.has(request.url) || !index.has(request.url)),
                )
                .map((request) => cache.delete(request)),
        );
    } catch (err) {
        // Out of quota, say: then the game won't open offline.
        console.warn("[searchlight:revisions] couldn't keep revision", err);
    }
}

/** Forget a kept copy that turned out unusable. Never throws. */
export async function dropStoredRevision(
    gameId: string,
    revisionId: string,
): Promise<void> {
    const key = revisionKey(gameId, revisionId);
    writeStorage(
        "localStorage",
        INDEX_KEY,
        JSON.stringify(readIndex().filter((k) => k !== key)),
    );
    const cache = await openCache();
    await cache?.delete(key).catch(() => false);
}

/** Forget every kept revision, e.g. on logout. Never throws. */
export async function clearStoredRevisions(): Promise<void> {
    removeStorage("localStorage", INDEX_KEY);
    try {
        if (typeof caches === "undefined") return;
        await Promise.all(
            (await caches.keys())
                .filter((name) => name.startsWith(CACHE_PREFIX))
                .map((name) => caches.delete(name)),
        );
    } catch (err) {
        console.warn("[searchlight:revisions] couldn't clear", err);
    }
}
