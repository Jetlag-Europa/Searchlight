import type { GameSessionSummary } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const games = vi.hoisted(() => ({
    getGameById: vi.fn(),
    switchToGame: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("@/lib/games", () => games);
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("react-toastify", () => ({ toast }));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
});
vi.stubGlobal("sessionStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
});

import { loadRevision } from "@/components/SessionUpgradeBanner";
import {
    activeSessionData,
    clearActiveSession,
    setActiveSession,
} from "@/lib/activeSession";

const session: GameSessionSummary = {
    id: "session-1",
    gameId: "game-1",
    gameName: "Game",
    serverId: "server-1",
    name: "Session",
    visibility: "private",
    role: "creator",
    createdAt: "2026-01-01T00:00:00.000Z",
    hiderLat: null,
    hiderLng: null,
    planningModeEnabled: false,
    gameRevisionId: "rev-1",
    sessionRevision: 1,
    currentRevision: 2,
    hasNewerRevision: true,
};

beforeEach(() => {
    games.getGameById.mockReturnValue(undefined);
    games.switchToGame.mockReset();
    toast.success.mockReset();
    setActiveSession(session);
});

afterEach(() => {
    clearActiveSession();
});

describe("loadRevision", () => {
    test("publishes the new revision only once its board has loaded", async () => {
        const load = Promise.withResolvers<boolean>();
        games.switchToGame.mockReturnValue(load.promise);

        const upgrade = loadRevision("session-1", 2, "rev-2");
        expect(games.switchToGame).toHaveBeenCalledWith(
            expect.objectContaining({ id: "game-1" }),
            { revisionId: "rev-2", sessionId: "session-1" },
        );
        expect(activeSessionData.get()).toMatchObject({
            gameRevisionId: "rev-1",
            sessionRevision: 1,
        });

        load.resolve(true);
        await upgrade;
        expect(activeSessionData.get()).toMatchObject({
            gameRevisionId: "rev-2",
            sessionRevision: 2,
            currentRevision: 2,
            hasNewerRevision: false,
        });
        expect(toast.success).toHaveBeenCalledOnce();
    });

    test("treats a reactivated older revision as the current one", async () => {
        games.switchToGame.mockResolvedValue(true);
        setActiveSession({ ...session, currentRevision: 3 });

        await loadRevision("session-1", 1, "rev-1b");
        expect(activeSessionData.get()).toMatchObject({
            gameRevisionId: "rev-1b",
            sessionRevision: 1,
            currentRevision: 1,
            hasNewerRevision: false,
        });
    });

    test("keeps the session on its revision when the board fails to load", async () => {
        games.switchToGame.mockResolvedValue(false);

        await expect(loadRevision("session-1", 2, "rev-2")).rejects.toThrow(
            /could not load/,
        );
        expect(activeSessionData.get()).toMatchObject({
            gameRevisionId: "rev-1",
            sessionRevision: 1,
            hasNewerRevision: true,
        });
        expect(toast.success).not.toHaveBeenCalled();
    });

    test("announces a revision once when the upgrade and its event share a load", async () => {
        games.switchToGame.mockResolvedValue(true);

        await Promise.all([
            loadRevision("session-1", 2, "rev-2"),
            loadRevision("session-1", 2, "rev-2"),
        ]);
        expect(activeSessionData.get()?.gameRevisionId).toBe("rev-2");
        expect(toast.success).toHaveBeenCalledOnce();
    });
});
