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

import {
    clearStrokeTombstones,
    deleteStrokeFromServer,
    saveStrokeToServer,
} from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId } from "@/lib/activeSession";
import { syncStatus } from "@/lib/context";
import {
    enqueueEvent,
    getPendingEvents,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    executeHiderPatch,
    executePlanningPatch,
    saveQuestionsToServer,
} from "@/lib/sessionState";
import {
    classifySendFailure,
    flushPendingEvents,
    onEventRejected,
    startSyncManager,
    stopSyncManager,
} from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

import { notTheSession, sessionNotFound } from "./apiResponses";

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
    clearStrokeTombstones();
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
            expect(classifySendFailure(status, false)).toBe("rejected");
        }
        expect(classifySendFailure(403, true)).toBe("unavailable");
        expect(classifySendFailure(404, true)).toBe("unavailable");
        // Not the API's 403/404 for the session.
        expect(classifySendFailure(403, false)).toBe("retry");
        expect(classifySendFailure(404, false)).toBe("retry");
        for (const status of [undefined, 401, 408, 429, 500, 502, 503]) {
            expect(classifySendFailure(status, false)).toBe("retry");
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
                "rejected",
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
        mockFetch.mockImplementation(async () => sessionNotFound());
        await expect(
            executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
        ).rejects.toThrow();
        expect(getPendingEvents(SID)[0].status).toBe("failed");
        expect(rejected).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ type: "hider.update" }),
            404,
            "unavailable",
        );
    });

    test.each(notTheSession)(
        "keeps an edit answered with %s and retries it, unreported",
        async (_, notFound) => {
            mockFetch
                .mockImplementationOnce(async () => notFound())
                .mockResolvedValue(ok());
            await expect(
                executeHiderPatch(SID, { latitude: 1, longitude: 2 }),
            ).rejects.toThrow();
            expect(getPendingEvents(SID)[0].status).toBe("failed");
            expect(rejected).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1000);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(getPendingEvents(SID)).toEqual([]);
            expect(rejected).not.toHaveBeenCalled();
        },
    );

    test.each(notTheSession)(
        "a flush stops at an edit answered with %s, keeping it",
        async (_, notFound) => {
            activeSessionId.set("other-session");
            queue("hider.update");
            queue("planning.toggle");
            mockFetch.mockImplementation(async () => notFound());
            await flushPendingEvents(SID);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(getPendingEvents(SID)).toHaveLength(2);
            expect(rejected).not.toHaveBeenCalled();
        },
    );

    // Its session is gone, so the stroke is too: nothing left to erase.
    test("counts erasing a stroke in a session that is gone as done", async () => {
        mockFetch.mockImplementation(async () => sessionNotFound());
        await deleteStrokeFromServer(SID, "stroke-1");
        expect(getPendingEvents(SID)).toEqual([]);
        expect(rejected).not.toHaveBeenCalled();
    });

    test.each(notTheSession)(
        "keeps erasing a stroke answered with %s, and retries it",
        async (_, notFound) => {
            mockFetch
                .mockImplementationOnce(async () => notFound())
                .mockResolvedValue(ok());
            await expect(
                deleteStrokeFromServer(SID, "stroke-1"),
            ).rejects.toThrow();
            expect(getPendingEvents(SID)).toEqual([
                expect.objectContaining({
                    type: "stroke.delete",
                    status: "failed",
                }),
            ]);
            expect(rejected).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1000);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(getPendingEvents(SID)).toEqual([]);
        },
    );

    test.each(notTheSession)(
        "a flush keeps a queued erase answered with %s",
        async (_, notFound) => {
            activeSessionId.set("other-session");
            enqueueEvent({
                sessionId: SID,
                type: "stroke.delete",
                payloadJson: { clientUuid: "stroke-1" },
                clientUuid: "stroke-delete-stroke-1",
                clientCreatedAt: 1,
            });
            mockFetch.mockImplementation(async () => notFound());
            await flushPendingEvents(SID);
            expect(getPendingEvents(SID)).toEqual([
                expect.objectContaining({
                    type: "stroke.delete",
                    status: "failed",
                }),
            ]);
            expect(rejected).not.toHaveBeenCalled();
        },
    );

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
            "rejected",
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
            "rejected",
        );
        await vi.advanceTimersByTimeAsync(120_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

// A request on mobile data that died without a reset never answers: it must
// not hold up the session's later saves (audit SYNC-06).
describe("a request that never answers", () => {
    const REQUEST_TIMEOUT_MS = 45_000;
    // Answers only by failing once its request is aborted, as fetch does.
    const hangs = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
                reject(init.signal!.reason),
            ),
        );
    // Headers that come, and a body that never ends until aborted.
    const bodyHangs = (status: number) => (_url: string, init?: RequestInit) =>
        Promise.resolve(
            new Response(
                new ReadableStream({
                    start(controller) {
                        init?.signal?.addEventListener("abort", () =>
                            controller.error(init.signal!.reason),
                        );
                    },
                }),
                { status, headers: { "Content-Type": "application/json" } },
            ),
        );
    const body = (call: number) =>
        JSON.parse(mockFetch.mock.calls[call][1].body as string);

    test("is given up after 45 seconds, and the save after it goes through", async () => {
        mockFetch.mockImplementationOnce(hangs).mockResolvedValue(ok());
        const first = executePlanningPatch(SID, true);
        first.catch(() => {});
        const second = executePlanningPatch(SID, false);

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(first).rejects.toThrow();
        await second;
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(body(1)).toEqual({ planningModeEnabled: false });
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("sends a question list again under its own id", async () => {
        const list = [{ id: "radius", key: 1, data: {} }] as unknown as Questions;
        mockFetch
            .mockImplementationOnce(hangs)
            .mockResolvedValue(Response.json({ sequence: 1 }));
        await expect(
            Promise.all([
                saveQuestionsToServer(SID, list),
                vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS),
            ]),
        ).rejects.toThrow();
        expect(getPendingEvents(SID)).toHaveLength(1);

        // The usual retry.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(body(1).replacementId).toBe(body(0).replacementId);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("keeps a list whose refusal never finishes arriving, to merge later", async () => {
        const list = [{ id: "radius", key: 1, data: {} }] as unknown as Questions;
        // Made from the server's list at 3: a refusal may say it moved on.
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            serverQuestions: { sequence: 3, questions: [] as unknown as Questions },
            lastSyncedAt: 0,
            lastSequence: 3,
        });
        mockFetch.mockImplementationOnce(bodyHangs(409));
        const save = saveQuestionsToServer(SID, list);
        save.catch(() => {});
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        await expect(save).rejects.toThrow();
        // Not refused for good: queued, to be sent again.
        expect(getPendingEvents(SID)).toHaveLength(1);
        expect(getPendingEvents(SID)[0].status).toBe("failed");
    });

    test("doesn't hold up erasing a stroke whose drawing never answered", async () => {
        const stroke = {
            type: "Feature",
            properties: { clientUuid: "stroke-1" },
            geometry: { type: "LineString", coordinates: [] },
        } as unknown as StrokeFeature;
        mockFetch.mockImplementationOnce(hangs).mockResolvedValue(ok());
        const drawn = saveStrokeToServer(SID, stroke);
        drawn.catch(() => {});
        const erased = deleteStrokeFromServer(SID, "stroke-1");
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        await erased;
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][1].method).toBe("DELETE");
    });
});
