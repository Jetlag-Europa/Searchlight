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

import { saveStrokeToServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId } from "@/lib/activeSession";
import { syncStatus } from "@/lib/context";
import { enqueueEvent, getPendingEvents } from "@/lib/eventQueue";
import { executeHiderPatch, saveQuestionsToServer } from "@/lib/sessionState";
import {
    classifySendFailure,
    flushPendingEvents,
    onEventRejected,
    startSyncManager,
    stopSyncManager,
} from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

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

describe("edits the server rejects", () => {
    const rejected = vi.fn();
    let unlisten: () => void;

    function answer(status: number) {
        return new Response(null, { status });
    }

    function queue(
        type: "questions.replace" | "hider.update" | "planning.toggle",
    ) {
        enqueueEvent({
            sessionId: SID,
            type,
            payloadJson:
                type === "questions.replace"
                    ? { replacementId: "r1", questions: [] }
                    : {},
            clientUuid: `${type}-offline`,
            clientCreatedAt: 1,
        });
    }

    beforeEach(() => {
        rejected.mockReset();
        unlisten = onEventRejected(rejected);
    });

    afterEach(() => unlisten());

    test("treats a 4xx but 401, 408 and 429 as permanent", () => {
        for (const status of [400, 409, 413, 422]) {
            expect(classifySendFailure(status)).toBe("rejected");
        }
        expect(classifySendFailure(403)).toBe("unavailable");
        expect(classifySendFailure(404)).toBe("unavailable");
        for (const status of [undefined, 401, 408, 429, 500, 502, 503]) {
            expect(classifySendFailure(status)).toBe("retry");
        }
    });

    test.each([400, 409, 413])(
        "drops an edit answered %i, reports it and stops retrying",
        async (status) => {
            mockFetch.mockResolvedValue(answer(status));
            await expect(
                executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
            ).rejects.toThrow();
            expect(getPendingEvents(SID)).toEqual([]);
            expect(rejected).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ type: "hider.update" }),
                status,
            );
            expect(syncStatus.get()).toBe("synced");

            await vi.advanceTimersByTimeAsync(120_000);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        },
    );

    test.each([
        ["401", () => Promise.resolve(answer(401))],
        ["429", () => Promise.resolve(answer(429))],
        ["500", () => Promise.resolve(answer(500))],
        ["a network error", () => Promise.reject(new TypeError("offline"))],
    ])("keeps an edit that failed with %s and retries it", async (_, fail) => {
        mockFetch.mockImplementationOnce(fail).mockResolvedValue(ok());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        expect(getPendingEvents(SID)[0].status).toBe("failed");
        expect(syncStatus.get()).toBe("offline");

        await vi.advanceTimersByTimeAsync(1000);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(getPendingEvents(SID)).toEqual([]);
        expect(rejected).not.toHaveBeenCalled();
    });

    test("keeps an edit to a session that is gone, and reports it", async () => {
        mockFetch.mockResolvedValue(answer(404));
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        expect(getPendingEvents(SID)[0].status).toBe("failed");
        expect(rejected).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: "hider.update" }),
            404,
        );
    });

    test("a flush goes on to the edits queued after a rejected one", async () => {
        activeSessionId.set("other-session");
        queue("questions.replace");
        queue("hider.update");
        queue("planning.toggle");
        mockFetch.mockResolvedValueOnce(answer(413)).mockResolvedValue(ok());
        await flushPendingEvents(SID);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(getPendingEvents(SID)).toEqual([]);
        expect(rejected).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: "questions.replace" }),
            413,
        );
    });

    test("a flush still stops at an edit that may pass later", async () => {
        activeSessionId.set("other-session");
        queue("hider.update");
        queue("planning.toggle");
        mockFetch.mockResolvedValue(answer(502));
        await flushPendingEvents(SID);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(getPendingEvents(SID)).toHaveLength(2);
    });

    test("a rejected snapshot a newer one replaced in flight is not reported", async () => {
        let respond: (res: Response) => void = () => {};
        mockFetch
            .mockReturnValueOnce(new Promise((resolve) => (respond = resolve)))
            .mockResolvedValue(ok());
        const first = saveQuestionsToServer(SID, [] as unknown as Questions);
        await vi.advanceTimersByTimeAsync(0);
        const second = saveQuestionsToServer(SID, [] as unknown as Questions);
        respond(answer(413));
        await expect(first).rejects.toThrow();
        await second;
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(rejected).not.toHaveBeenCalled();
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("drops a stroke the server rejects", async () => {
        mockFetch.mockResolvedValue(answer(409));
        const stroke = {
            type: "Feature",
            properties: { clientUuid: "stroke-1" },
            geometry: { type: "LineString", coordinates: [] },
        } as unknown as StrokeFeature;
        await expect(saveStrokeToServer(SID, stroke)).rejects.toThrow();
        expect(getPendingEvents(SID)).toEqual([]);
        expect(rejected).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: "stroke.create" }),
            409,
        );
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});
