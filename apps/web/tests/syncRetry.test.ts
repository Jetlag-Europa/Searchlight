import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { activeSessionId } from "@/lib/activeSession";
import { enqueueEvent, getPendingEvents } from "@/lib/eventQueue";
import { executeHiderPatch } from "@/lib/sessionState";
import { startSyncManager, stopSyncManager } from "@/lib/syncManager";

const SID = "retry-session";
const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
});
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", page);

function failing() {
    return new Response(null, { status: 503 });
}

function ok() {
    return new Response(null, { status: 200 });
}

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    activeSessionId.set(SID);
    startSyncManager();
});

afterEach(() => {
    stopSyncManager();
    activeSessionId.set("");
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("failed event retries", () => {
    test("retries with doubling delays until the event syncs", async () => {
        mockFetch
            .mockResolvedValueOnce(failing())
            .mockResolvedValueOnce(failing())
            .mockResolvedValue(ok());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        expect(getPendingEvents(SID)[0].status).toBe("failed");

        await vi.advanceTimersByTimeAsync(999);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1999);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(getPendingEvents(SID)).toEqual([]);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test("caps the retry delay at 30 seconds", async () => {
        mockFetch.mockResolvedValue(failing());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        // 1 + 2 + 4 + 8 + 16 seconds, then every 30.
        await vi.advanceTimersByTimeAsync(31_000);
        expect(mockFetch).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(mockFetch).toHaveBeenCalledTimes(6);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(7);
    });

    test("stops retrying once another session becomes active", async () => {
        mockFetch.mockResolvedValue(failing());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        activeSessionId.set("other-session");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(getPendingEvents(SID)[0].status).toBe("failed");
    });

    test("retries a loaded session's leftover events once it becomes active", async () => {
        activeSessionId.set("previous-session");
        enqueueEvent({
            sessionId: SID,
            type: "planning.toggle",
            payloadJson: { planningModeEnabled: true },
            clientUuid: "planning-offline",
            clientCreatedAt: 1,
        });
        mockFetch.mockResolvedValue(ok());
        activeSessionId.set(SID);
        await vi.advanceTimersByTimeAsync(1000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("flushes without waiting out the backoff when the tab is shown", async () => {
        mockFetch.mockResolvedValueOnce(failing()).mockResolvedValue(ok());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        page.visibilityState = "visible";
        page.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(getPendingEvents(SID)).toEqual([]);
    });
});
