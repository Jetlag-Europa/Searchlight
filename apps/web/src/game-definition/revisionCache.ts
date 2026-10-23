import type { GameDefinition } from "@searchlight/shared";

// The game revisions this browser loaded for its sessions, kept across
// reloads so a session's game opens while the server can't be reached. A
// revision never changes once imported (the API only ever creates them, and
// serves each with its checksum as ETag); the `sessionId` it was loaded with
// only grants access. So a kept copy is good for as long as it's kept.
// Definitions run to several MB, too much for localStorage: they go in the
// Cache API, which privacy modes may refuse. Then nothing is kept.
const CACHE_NAME = "searchlight-game-revisions";
// The active session's revision and the last few others.
export const MAX_STORED_REVISIONS = 4;
// When a copy was stored or last read, for keeping the most recent ones.
const USED_AT = "X-Searchlight-Used-At";

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

async function uses(
    cache: Cache,
): Promise<Array<{ url: string; usedAt: number }>> {
    return Promise.all(
        (await cache.keys()).map(async (request) => ({
            url: request.url,
            usedAt:
                Number((await cache.match(request))?.headers.get(USED_AT)) ||
                0,
        })),
    );
}

async function put(cache: Cache, key: string, json: string): Promise<void> {
    await cache.put(
        key,
        new Response(json, {
            headers: {
                "Content-Type": "application/json",
                [USED_AT]: String(Date.now()),
            },
        }),
    );
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
        const json = await response.text();
        const definition = JSON.parse(json) as unknown;
        if (!definition || typeof definition !== "object") {
            throw new Error("not a game definition");
        }
        // Reading a copy makes it the most recent one, so the revision a
        // session keeps playing isn't the next one pruned.
        const usedAt = Number(response.headers.get(USED_AT)) || 0;
        if ((await uses(cache)).some((entry) => entry.usedAt > usedAt)) {
            await put(cache, key, json).catch((err: unknown) =>
                console.warn("[searchlight:revisions] couldn't touch", err),
            );
        }
        return definition as GameDefinition;
    } catch (err) {
        console.warn("[searchlight:revisions] dropping unreadable copy", err);
        await cache.delete(key).catch(() => false);
        return undefined;
    }
}

/** Keep a game revision loaded from the server. Best-effort. */
export async function storeRevision(
    gameId: string,
    revisionId: string,
    definition: GameDefinition,
): Promise<void> {
    const cache = await openCache();
    if (!cache) return;
    const key = revisionKey(gameId, revisionId);
    try {
        await put(cache, key, JSON.stringify(definition));
        // Keep the most recently used copies, this one among them.
        const stale = (await uses(cache))
            .filter((entry) => entry.url !== key)
            .sort((a, b) => b.usedAt - a.usedAt)
            .slice(MAX_STORED_REVISIONS - 1);
        await Promise.all(stale.map((entry) => cache.delete(entry.url)));
    } catch (err) {
        // Out of quota, say: then the game won't open offline.
        console.warn("[searchlight:revisions] couldn't keep revision", err);
    }
}

/** Forget every kept revision, e.g. on logout. Never throws. */
export async function clearStoredRevisions(): Promise<void> {
    try {
        if (typeof caches === "undefined") return;
        await caches.delete(CACHE_NAME);
    } catch (err) {
        console.warn("[searchlight:revisions] couldn't clear", err);
    }
}
