import { afterEach, expect, it, vi } from "vitest";

type Storage = Map<string, string>;

function stubStorage(name: string, store: Storage, full = false) {
    vi.stubGlobal(name, {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            if (full)
                throw new DOMException("Storage is full", "QuotaExceededError");
            store.set(key, value);
        },
        removeItem: (key: string) => store.delete(key),
    });
}

/** gameView.ts reads the saved view when it is first imported. */
async function loadGameView() {
    vi.resetModules();
    return import("@/lib/gameView");
}

const bounds: [number, number, number, number] = [5.6, 50.7, 6.1, 51.1];

afterEach(() => vi.unstubAllGlobals());

it("matches this tab's game, or else the session being restored", async () => {
    const local: Storage = new Map([
        [
            "lastGameView",
            JSON.stringify({ gameId: "limburg", sessionId: "s1", bounds }),
        ],
    ]);
    stubStorage("localStorage", local);
    const { savedGameView } = await loadGameView();

    expect(savedGameView("limburg", "other")?.bounds).toEqual(bounds);
    expect(savedGameView("zurich", "s1")).toBeNull();
    expect(savedGameView("", "s1")?.gameId).toBe("limburg");
    expect(savedGameView("", "s2")).toBeNull();
    expect(savedGameView("", "")).toBeNull();
});

it("ignores a corrupt saved view and survives full storage", async () => {
    const local: Storage = new Map([["lastGameView", "{not json"]]);
    stubStorage("localStorage", local, true);
    const { lastGameView, rememberGameView, savedGameView } =
        await loadGameView();
    expect(lastGameView.get()).toBeNull();

    expect(() => rememberGameView("limburg", bounds, "s1")).not.toThrow();
    // Kept for this page.
    expect(savedGameView("limburg", "")?.sessionId).toBe("s1");
    // Another view of the same game keeps the session known to play it.
    rememberGameView("limburg", [5, 50, 6, 51]);
    expect(lastGameView.get()).toEqual({
        gameId: "limburg",
        sessionId: "s1",
        bounds: [5, 50, 6, 51],
    });
});

it("forgets the saved view and this tab's game for the next user", async () => {
    const local: Storage = new Map();
    const session: Storage = new Map([["taibled-current-game-id", "limburg"]]);
    stubStorage("localStorage", local);
    stubStorage("sessionStorage", session);
    const { forgetGameViews, lastGameView, rememberGameView } =
        await loadGameView();
    rememberGameView("limburg", bounds, "s1");
    expect(local.has("lastGameView")).toBe(true);

    forgetGameViews();

    expect(lastGameView.get()).toBeNull();
    expect(local.has("lastGameView")).toBe(false);
    expect(session.has("taibled-current-game-id")).toBe(false);
});
