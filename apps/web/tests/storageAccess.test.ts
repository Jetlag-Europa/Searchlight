import { afterEach, expect, it, vi } from "vitest";

// Privacy modes and blocked site data make the storage getter itself throw,
// which a `typeof sessionStorage` check does not catch.
function denySessionStorage() {
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        get() {
            throw new DOMException("The operation is insecure.", "SecurityError");
        },
    });
}

afterEach(() => {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

it("loads the game module when sessionStorage access throws", async () => {
    denySessionStorage();
    const { currentGameId } = await import("@/lib/games");
    expect(currentGameId.get()).toBe("");
});

it("switches games when sessionStorage writes throw", async () => {
    vi.stubGlobal("sessionStorage", {
        getItem: () => null,
        setItem: () => {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
        },
        removeItem: () => {},
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { currentGameId, switchToGame } = await import("@/lib/games");
    const game = {
        id: "storage-game",
        gameKey: "storage-game",
        label: "Storage game",
        serverId: "server",
        serverName: "Server",
        size: "medium" as const,
    };
    const loaded = switchToGame(game, {
        revisionId: "storage-revision",
        sessionId: "storage-session",
    });
    expect(currentGameId.get()).toBe(game.id);
    expect(await loaded).toBe(false);
});
