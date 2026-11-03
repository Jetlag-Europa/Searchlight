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

import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    applyPendingEventsToState,
    applyUnsyncedEvents,
    CACHE_PREFIX,
    enqueueEvent,
    getCachedSession,
    type PendingEvent,
} from "@/lib/eventQueue";
import {
    LOAD_TIMEOUT_MS,
    LoadTimeoutError,
    startLoadDeadline,
} from "@/lib/loadDeadline";
import { loadSessionContent } from "@/lib/sessionState";

const SID = "malformed-session";

function stroke(clientUuid: string): StrokeFeature {
    return {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: [
                [8.54, 47.37],
                [8.55, 47.38],
            ],
        },
        properties: {
            tool: "pen",
            color: "#000000",
            widthMeters: 3,
            createdAt: 0,
            clientUuid,
        },
    };
}

// The server keeps any payload it was sent.
const MALFORMED = [
    null,
    3,
    "x",
    {},
    { properties: null },
    { properties: 1 },
    { properties: {} },
    { properties: {}, geometry: null },
    { properties: {}, geometry: { coordinates: null } },
    { properties: {}, geometry: { coordinates: [[8.54]] } },
    { properties: {}, geometry: { coordinates: [["8.54", 47.37]] } },
    { properties: {}, geometry: { coordinates: [null] } },
];

function created(payloadJson: unknown): PendingEvent {
    return {
        localId: `local-${Math.random()}`,
        sessionId: SID,
        type: "stroke.create",
        payloadJson,
        clientUuid: `stroke-create-${Math.random()}`,
        clientCreatedAt: 1,
        status: "pending",
    } as PendingEvent;
}

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("malformed strokes", () => {
    test("loading the strokes skips the malformed ones", async () => {
        mockFetch.mockResolvedValue(
            Response.json({
                strokes: [
                    { clientUuid: "a", payloadJson: stroke("a") },
                    ...MALFORMED.map((payloadJson, i) => ({
                        clientUuid: `bad-${i}`,
                        payloadJson,
                    })),
                    null,
                    { clientUuid: "b", payloadJson: stroke("b") },
                ],
            }),
        );
        expect(await loadStrokesFromServer(SID)).toEqual([
            stroke("a"),
            stroke("b"),
        ]);
        expect(console.warn).toHaveBeenCalledTimes(MALFORMED.length + 1);
    });

    test("replaying edits skips malformed strokes, kept or queued", () => {
        const base = {
            strokes: [stroke("a"), ...MALFORMED] as StrokeFeature[],
            questions: [],
        };
        const events = [
            ...MALFORMED.map(created),
            created(stroke("b")),
            {
                ...created(null),
                type: "stroke.delete",
                payloadJson: { clientUuid: "a" },
            } as PendingEvent,
            { ...created(null), type: "stroke.delete", payloadJson: null },
            {
                ...created(null),
                type: "stroke.delete",
                payloadJson: { clientUuid: 3 },
            },
        ] as PendingEvent[];
        expect(applyPendingEventsToState(base, events).strokes).toEqual([
            stroke("b"),
        ]);
    });

    test("a malformed stroke kept here doesn't stop the board showing", () => {
        store.set(
            `${CACHE_PREFIX}${SID}`,
            JSON.stringify({
                sessionId: SID,
                strokes: [stroke("a"), ...MALFORMED],
                questions: [],
            }),
        );
        const cached = getCachedSession(SID);
        expect(cached?.strokes).toEqual([stroke("a")]);
        enqueueEvent({
            sessionId: SID,
            type: "stroke.create",
            payloadJson: stroke("b"),
            clientUuid: "stroke-create-b",
            clientCreatedAt: 1,
        });
        expect(applyUnsyncedEvents(SID, cached!).strokes).toEqual([
            stroke("a"),
            stroke("b"),
        ]);
    });

    test("a load whose reads hang gives up at the deadline, keeping nothing", async () => {
        vi.useFakeTimers();
        mockFetch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_, reject) => {
                    // As fetch does: an aborted signal rejects right away.
                    if (init.signal?.aborted) reject(init.signal.reason);
                    init.signal?.addEventListener("abort", () =>
                        reject(init.signal?.reason),
                    );
                }),
        );
        const deadline = startLoadDeadline();
        let error: unknown;
        void loadSessionContent(SID, "user-1", deadline.signal).catch(
            (e: unknown) => (error = e),
        );
        await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
        expect(error).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(error).toBeInstanceOf(LoadTimeoutError);
        expect(getCachedSession(SID)).toBeNull();
    });

    test("a load in time leaves no timer running", async () => {
        vi.useFakeTimers();
        mockFetch.mockImplementation(async (url: string) => {
            if (url.endsWith("/events/cursor"))
                return Response.json({ sequence: 4 });
            if (url.endsWith("/strokes"))
                return Response.json({
                    strokes: [{ clientUuid: "a", payloadJson: stroke("a") }],
                });
            if (url.endsWith("/questions"))
                return Response.json({ questions: [], sequence: 4 });
            return Response.json({ id: SID, role: "member" });
        });
        const deadline = startLoadDeadline();
        try {
            const loaded = await loadSessionContent(
                SID,
                "user-1",
                deadline.signal,
            );
            expect(loaded.strokes).toEqual([stroke("a")]);
        } finally {
            deadline.clear();
        }
        expect(vi.getTimerCount()).toBe(0);
        expect(getCachedSession(SID)?.strokes).toEqual([stroke("a")]);
    });
});
