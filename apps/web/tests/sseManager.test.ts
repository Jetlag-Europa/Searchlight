import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EventRecord } from "@searchlight/shared";

// ── localStorage mock (same as eventQueue.test.ts) ───────────────────────────
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
    clear: () => store.clear(),
});

// ── EventSource mock ──────────────────────────────────────────────────────────
type ESHandler = ((e: Event | MessageEvent) => void) | null;

class MockEventSource {
    url: string;
    withCredentials: boolean;
    onopen: ESHandler = null;
    onmessage: ESHandler = null;
    onerror: ESHandler = null;
    readyState = 0;
    close = vi.fn();

    constructor(url: string, opts?: { withCredentials?: boolean }) {
        this.url = url;
        this.withCredentials = opts?.withCredentials ?? false;
        MockEventSource._last = this;
    }

    static CLOSED = 2;
    static _last: MockEventSource | null = null;
    static reset() {
        MockEventSource._last = null;
    }
}

vi.stubGlobal("EventSource", MockEventSource);

// ── fetch mock (for gap-fill) ─────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Imports (after globals are stubbed) ───────────────────────────────────────
import { startSSE, stopSSE } from "@/lib/sseManager";
import {
    cancelPendingQuestionSave,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import { isQuestionSaveSuppressed } from "@/lib/questionSaveSuppress";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { questions, syncStatus } from "@/lib/context";
import {
    enqueueEvent,
    getPendingEvents,
    markEventFailed,
    setCachedSession,
    getCachedSession,
} from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";

const SID = "sse-test-session";

function makeStroke(clientUuid: string): StrokeFeature {
    return {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [] },
        properties: {
            tool: "pen",
            color: "#000000",
            widthMeters: 3,
            createdAt: 0,
            clientUuid,
        },
    };
}

function makeEvent(
    type: string,
    payloadJson: unknown,
    overrides: Partial<EventRecord> = {},
): EventRecord {
    const { sequence = 1, ...rest } = overrides;
    return {
        id: "ev-" + Math.random(),
        sequence,
        sessionId: SID,
        userId: "other-user",
        type,
        payloadJson,
        clientUuid: "ev-uuid-" + Math.random(),
        clientCreatedAt: "2025-01-01T00:00:00.000Z",
        serverReceivedAt: new Date().toISOString(),
        ...rest,
    };
}

function simulateMessage(data: EventRecord) {
    MockEventSource._last?.onmessage?.({
        data: JSON.stringify(data),
    } as MessageEvent);
}

beforeEach(() => {
    store.clear();
    MockEventSource.reset();
    mockFetch.mockReset();
    strokes.set([]);
    questions.set([] as unknown as Questions);
    syncStatus.set("synced");
});

afterEach(() => {
    stopSSE();
});

// ── Connection lifecycle ──────────────────────────────────────────────────────
describe("startSSE / stopSSE", () => {
    test("opens EventSource at the correct URL with credentials", () => {
        startSSE(SID);
        expect(MockEventSource._last).not.toBeNull();
        expect(MockEventSource._last!.url).toBe(
            `http://localhost:3001/sessions/${SID}/stream`,
        );
        expect(MockEventSource._last!.withCredentials).toBe(true);
    });

    test("closing a previous connection before opening a new one", () => {
        startSSE(SID);
        const first = MockEventSource._last!;
        startSSE("other-session");
        expect(first.close).toHaveBeenCalledOnce();
        expect(MockEventSource._last).not.toBe(first);
    });

    test("stopSSE closes the EventSource", () => {
        startSSE(SID);
        const es = MockEventSource._last!;
        stopSSE();
        expect(es.close).toHaveBeenCalledOnce();
    });

    test("stopSSE is idempotent when nothing is connected", () => {
        expect(() => stopSSE()).not.toThrow();
    });

    test("onopen sets syncStatus to live", () => {
        startSSE(SID);
        MockEventSource._last!.onopen!(new Event("open"));
        expect(syncStatus.get()).toBe("live");
    });

    test("onerror from live reverts syncStatus to synced", () => {
        startSSE(SID);
        MockEventSource._last!.onopen!(new Event("open"));
        MockEventSource._last!.onerror!(new Event("error"));
        expect(syncStatus.get()).toBe("synced");
    });

    test("onerror when not live does not change status", () => {
        syncStatus.set("offline");
        startSSE(SID);
        MockEventSource._last!.onerror!(new Event("error"));
        expect(syncStatus.get()).toBe("offline");
    });

    test("onopen delivers edits that failed while disconnected", async () => {
        const failed = enqueueEvent({
            sessionId: SID,
            type: "hider.update",
            payloadJson: { hiderLat: 1, hiderLng: 2 },
            clientUuid: "hider-offline",
            clientCreatedAt: 1,
        });
        markEventFailed(SID, failed.localId);
        mockFetch.mockImplementation(async (url: string) =>
            url.includes("/events?")
                ? { ok: true, json: async () => ({ events: [], nextAfter: null }) }
                : new Response(null, { status: 200 }),
        );
        startSSE(SID);
        MockEventSource._last!.onopen!(new Event("open"));
        await vi.waitFor(() => expect(getPendingEvents(SID)).toEqual([]));
        expect(mockFetch).toHaveBeenCalledWith(
            `http://localhost:3001/sessions/${SID}`,
            expect.objectContaining({ method: "PATCH" }),
        );
    });

    test("stopSSE reverts live status to synced", () => {
        startSSE(SID);
        MockEventSource._last!.onopen!(new Event("open"));
        stopSSE();
        expect(syncStatus.get()).toBe("synced");
    });
});

// ── Incoming event handling ───────────────────────────────────────────────────
describe("handleServerEvent — stroke.create", () => {
    test("adds a new stroke to the strokes atom", () => {
        startSSE(SID);
        simulateMessage(makeEvent("stroke.create", makeStroke("s-new")));
        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("s-new");
    });

    test("deduplicates by clientUuid", () => {
        const s = makeStroke("s-dup");
        strokes.set([s]);
        startSSE(SID);
        simulateMessage(makeEvent("stroke.create", s));
        expect(strokes.get()).toHaveLength(1);
    });

    test("appends alongside existing strokes", () => {
        strokes.set([makeStroke("existing")]);
        startSSE(SID);
        simulateMessage(makeEvent("stroke.create", makeStroke("new-one")));
        expect(strokes.get()).toHaveLength(2);
    });
});

describe("handleServerEvent — stroke.delete", () => {
    test("removes the matching stroke", () => {
        strokes.set([makeStroke("del-me"), makeStroke("keep-me")]);
        startSSE(SID);
        simulateMessage(makeEvent("stroke.delete", { clientUuid: "del-me" }));
        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("keep-me");
    });

    test("is a no-op when clientUuid is not present", () => {
        strokes.set([makeStroke("present")]);
        startSSE(SID);
        simulateMessage(makeEvent("stroke.delete", { clientUuid: "absent" }));
        expect(strokes.get()).toHaveLength(1);
    });
});

describe("handleServerEvent — questions.replace", () => {
    test("replaces questions atom with incoming questions", () => {
        const incomingQuestion = {
            id: "radius",
            key: 1,
            data: { lat: 0, lng: 0, radius: 50, within: true },
        };
        const incoming = [
            { clientUuid: "q1", ordinal: 0, payloadJson: incomingQuestion },
        ];
        startSSE(SID);
        simulateMessage(
            makeEvent("questions.replace", { questions: incoming }),
        );
        const qs = questions.get() as unknown as Array<{ id: string }>;
        expect(qs).toHaveLength(1);
        expect(qs[0].id).toBe("radius");
    });

    test("a replay page of several replaces cannot swallow the next local edit", async () => {
        const replace = (sequence: number, key: number) =>
            makeEvent(
                "questions.replace",
                {
                    replacementId: `r-${sequence}`,
                    questions: [
                        {
                            clientUuid: `q-${sequence}`,
                            ordinal: 0,
                            payloadJson: { id: "radius", key, data: {} },
                        },
                    ],
                },
                { sequence },
            );
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                events: [replace(1, 1), replace(2, 2)],
                nextAfter: null,
            }),
        });
        startSSE(SID);
        MockEventSource._last!.onopen!(new Event("open"));
        await vi.waitFor(() =>
            expect(
                (questions.get() as unknown as Array<{ key: number }>)[0]?.key,
            ).toBe(2),
        );
        // Both sets render once; neither may be saved back, and nothing may
        // be left over to suppress the player's next edit.
        expect(isQuestionSaveSuppressed(questions.get())).toBe(true);
        expect(isQuestionSaveSuppressed([...questions.get()])).toBe(false);
    });

    test("applies another player's replace that commits right after our unacknowledged one", () => {
        const ours = { id: "radius", key: 1, data: {} };
        const theirs = { id: "radius", key: 2, data: {} };
        questions.set([ours] as unknown as Questions);
        const local = enqueueEvent({
            sessionId: SID,
            type: "questions.replace",
            payloadJson: {
                replacementId: "r-ours",
                questions: [{ clientUuid: "q-ours", ordinal: 0, payloadJson: ours }],
            },
            clientUuid: "questions-replace-r-ours",
            clientCreatedAt: Date.now(),
        });
        startSSE(SID);
        // The echo of our PUT arrives before the PUT's response...
        simulateMessage(
            makeEvent("questions.replace", local.payloadJson, {
                clientUuid: local.clientUuid,
                sequence: 1,
            }),
        );
        // ...and another player's replace lands right after it.
        simulateMessage(
            makeEvent(
                "questions.replace",
                {
                    replacementId: "r-theirs",
                    questions: [
                        { clientUuid: "q-theirs", ordinal: 0, payloadJson: theirs },
                    ],
                },
                { sequence: 2 },
            ),
        );
        expect(questions.get()).toEqual([theirs]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("does not re-apply our own echo over a newer local edit", () => {
        const ours = { id: "radius", key: 1, data: {} };
        const newer = { id: "radius", key: 2, data: {} };
        const local = enqueueEvent({
            sessionId: SID,
            type: "questions.replace",
            payloadJson: {
                replacementId: "r-ours",
                questions: [{ clientUuid: "q-ours", ordinal: 0, payloadJson: ours }],
            },
            clientUuid: "questions-replace-r-ours",
            clientCreatedAt: Date.now(),
        });
        // The player edits again before the echo of the first save arrives.
        questions.set([ours, newer] as unknown as Questions);
        startSSE(SID);
        simulateMessage(
            makeEvent("questions.replace", local.payloadJson, {
                clientUuid: local.clientUuid,
                sequence: 1,
            }),
        );
        expect(questions.get()).toEqual([ours, newer]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("is skipped while our own edit waits in the debounce", () => {
        const mine = { id: "radius", key: 1, data: {} };
        const theirs = { id: "radius", key: 2, data: {} };
        questions.set([mine] as unknown as Questions);
        saveQuestionsDebounced(SID, [mine] as unknown as Questions);
        try {
            startSSE(SID);
            simulateMessage(
                makeEvent(
                    "questions.replace",
                    {
                        replacementId: "r-theirs",
                        questions: [
                            { clientUuid: "q-theirs", ordinal: 0, payloadJson: theirs },
                        ],
                    },
                    { sequence: 1 },
                ),
            );
            expect(questions.get()).toEqual([mine]);
        } finally {
            cancelPendingQuestionSave(SID);
        }
    });

    test("is skipped when a pending questions.replace exists in local queue", () => {
        const originalQuestion = {
            id: "radius",
            key: 2,
            data: { lat: 1, lng: 1, radius: 50, within: true },
        };
        questions.set([originalQuestion] as unknown as Questions);
        // Enqueue a local pending replace
        enqueueEvent({
            sessionId: SID,
            type: "questions.replace",
            payloadJson: { replacementId: "r-local", questions: [] },
            clientUuid: "questions-replace-r-local",
            clientCreatedAt: Date.now(),
        });
        startSSE(SID);
        const incoming = [
            {
                clientUuid: "q-foreign",
                ordinal: 0,
                payloadJson: {
                    id: "radius",
                    key: 3,
                    data: { lat: 2, lng: 2, radius: 50, within: true },
                },
            },
        ];
        simulateMessage(
            makeEvent("questions.replace", { questions: incoming }),
        );
        // Questions should remain unchanged
        const qs = questions.get() as unknown as Array<{
            id: string;
            key?: number;
        }>;
        expect(qs[0]?.id).toBe("radius");
        expect(qs[0]?.key).toBe(2);
    });
});

// ── Gap fill on reconnect ─────────────────────────────────────────────────────
describe("gap fill", () => {
    test("fetches missed events after onerror + onopen with sequence cursor", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 10,
        });
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ events: [], nextAfter: null }),
        });

        startSSE(SID);
        const es = MockEventSource._last!;
        es.onopen!(new Event("open"));
        es.onerror!(new Event("error"));
        es.onopen!(new Event("open"));

        await Promise.resolve();
        await Promise.resolve();

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain(`/sessions/${SID}/events?after=10`);
    });

    test("gap-fill events are applied to atoms", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });

        const gapStroke = makeStroke("gap-stroke");
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                events: [
                    {
                        ...makeEvent("stroke.create", gapStroke),
                        sequence: 1,
                    },
                ],
                nextAfter: null,
            }),
        });

        startSSE(SID);
        const es = MockEventSource._last!;
        es.onopen!(new Event("open"));

        await Promise.resolve();
        await Promise.resolve();

        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("gap-stroke");
    });

    test("A gap fill after B does not touch B session state", async () => {
        setCachedSession({
            sessionId: "session-a",
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        setCachedSession({
            sessionId: "session-b",
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });

        const { promise: gapAPromise, resolve: resolveGapA } =
            Promise.withResolvers<void>();

        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes("session-a")) {
                await gapAPromise;
                return {
                    ok: true,
                    json: async () => ({
                        events: [
                            {
                                ...makeEvent(
                                    "stroke.create",
                                    makeStroke("stroke-from-a"),
                                    { sessionId: "session-a" },
                                ),
                                sequence: 1,
                            },
                        ],
                        nextAfter: null,
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({ events: [], nextAfter: null }),
            };
        });

        // 1. Start SSE for session A
        startSSE("session-a");
        const esA = MockEventSource._last!;
        esA.onopen!(new Event("open"));

        // 2. Switch to session B
        startSSE("session-b");
        const esB = MockEventSource._last!;
        esB.onopen!(new Event("open"));

        // 3. Complete session A gap fill late
        resolveGapA();
        await Promise.resolve();
        await Promise.resolve();
        // 4. Session B's state and cache must not have stroke-from-a
        expect(
            strokes
                .get()
                .find((s) => s.properties.clientUuid === "stroke-from-a"),
        ).toBeUndefined();
        const cachedB = getCachedSession("session-b");
        expect(
            cachedB?.strokes.find(
                (s) => s.properties.clientUuid === "stroke-from-a",
            ),
        ).toBeUndefined();
    });

    test("buffers live events until gap fill completes, then applies in strictly increasing sequence", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });

        const strokeGap = makeStroke("stroke-gap");
        const strokeLive = makeStroke("stroke-live");

        const { promise: gapFetchPromise, resolve: resolveGapFetch } =
            Promise.withResolvers<void>();

        mockFetch.mockImplementation(async () => {
            await gapFetchPromise;
            return {
                ok: true,
                json: async () => ({
                    events: [
                        {
                            ...makeEvent("stroke.create", strokeGap, {
                                id: "ev-gap",
                                sessionId: SID,
                            }),
                            sequence: 1,
                        },
                    ],
                    nextAfter: null,
                }),
            };
        });

        startSSE(SID);
        const es = MockEventSource._last!;
        es.onopen!(new Event("open"));

        // While gap fill is in-flight, live event arrives via SSE message with sequence 2
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent("stroke.create", strokeLive, {
                        id: "ev-live",
                        sessionId: SID,
                    }),
                    sequence: 2,
                }),
            }),
        );

        // While gap filling, live event is buffered — not yet applied!
        expect(strokes.get()).toHaveLength(0);

        // Complete gap fill
        resolveGapFetch();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Both gap and live events applied in sequence order!
        const strokeUuids = strokes.get().map((s) => s.properties.clientUuid);
        expect(strokeUuids).toEqual(["stroke-gap", "stroke-live"]);
    });

    test("old replay cannot roll back newer live state (sequence order enforced)", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 9,
        });
        startSSE(SID);
        const es = MockEventSource._last!;

        // Apply a newer live event with sequence 10
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent("stroke.create", makeStroke("newer-live"), {
                        id: "ev-10",
                        sessionId: SID,
                    }),
                    sequence: 10,
                }),
            }),
        );
        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("newer-live");

        // Now a delayed replay arrives with older sequence 4
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent("stroke.create", makeStroke("older-replay"), {
                        id: "ev-4",
                        sessionId: SID,
                    }),
                    sequence: 4,
                }),
            }),
        );
        // Older replay event must be skipped!
        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("newer-live");
    });

    test("create/delete cannot resurrect: delayed stroke.create skipped when tombstoned", async () => {
        startSSE(SID);
        const es = MockEventSource._last!;

        const s = makeStroke("resurrect-target");

        // Stroke deleted event arrives first
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent(
                        "stroke.delete",
                        { clientUuid: s.properties.clientUuid },
                        {
                            id: "ev-del",
                            sessionId: SID,
                        },
                    ),
                    sequence: 2,
                }),
            }),
        );

        // Later, a delayed stroke.create arrives
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent("stroke.create", s, {
                        id: "ev-create",
                        sessionId: SID,
                    }),
                    sequence: 3,
                }),
            }),
        );

        // Stroke must NOT be resurrected
        expect(strokes.get()).toHaveLength(0);
    });

    test("SSE live sequence jump buffers event and triggers gap fill instead of skipping intermediate event", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 5,
        });

        const intermediateStroke = makeStroke("stroke-intermediate-6");
        const jumpedStroke = makeStroke("stroke-jumped-7");

        mockFetch.mockImplementation(async (url: string) => {
            if (url.includes("/events?after=5")) {
                return {
                    ok: true,
                    json: async () => ({
                        events: [
                            {
                                ...makeEvent(
                                    "stroke.create",
                                    intermediateStroke,
                                    {
                                        id: "ev-6",
                                        sessionId: SID,
                                    },
                                ),
                                sequence: 6,
                            },
                        ],
                        nextAfter: null,
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({ events: [], nextAfter: null }),
            };
        });

        startSSE(SID);
        const es = MockEventSource._last!;

        // Live message arrives with sequence 7 (jumped over 6!)
        es.onmessage!(
            new MessageEvent("message", {
                data: JSON.stringify({
                    ...makeEvent("stroke.create", jumpedStroke, {
                        id: "ev-7",
                        sessionId: SID,
                    }),
                    sequence: 7,
                }),
            }),
        );

        // Gap fill was triggered because of the jump!
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // Both intermediate (6) and jumped (7) strokes are applied in order!
        const strokeUuids = strokes.get().map((s) => s.properties.clientUuid);
        expect(strokeUuids).toEqual([
            "stroke-intermediate-6",
            "stroke-jumped-7",
        ]);
    });

    test("an obsolete replay cannot drain live events before the latest reconnect catches up", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        const first = Promise.withResolvers<{
            ok: boolean;
            json: () => Promise<unknown>;
        }>();
        const second = Promise.withResolvers<{
            ok: boolean;
            json: () => Promise<unknown>;
        }>();
        mockFetch
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);
        startSSE(SID);
        const stream = MockEventSource._last!;
        stream.onopen!(new Event("open"));
        simulateMessage(
            makeEvent("stroke.create", makeStroke("second"), {
                id: "second",
                sequence: 2,
            }),
        );
        stream.onopen!(new Event("open"));

        first.resolve({
            ok: true,
            json: async () => ({ events: [], nextAfter: null }),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(strokes.get()).toHaveLength(0);

        second.resolve({
            ok: true,
            json: async () => ({
                events: [
                    makeEvent("stroke.create", makeStroke("first"), {
                        id: "first",
                        sequence: 1,
                    }),
                ],
                nextAfter: null,
            }),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(
            strokes.get().map((stroke) => stroke.properties.clientUuid),
        ).toEqual(["first", "second"]);
    });

    test("a failed replay does not apply a jumped live event before retry succeeds", async () => {
        vi.useFakeTimers();
        try {
            mockFetch
                .mockResolvedValueOnce({ ok: false, status: 503 })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        events: [
                            makeEvent("stroke.create", makeStroke("first"), {
                                id: "first",
                                sequence: 1,
                            }),
                        ],
                        nextAfter: null,
                    }),
                });
            startSSE(SID);
            const stream = MockEventSource._last!;
            stream.onopen!(new Event("open"));
            simulateMessage(
                makeEvent("stroke.create", makeStroke("second"), {
                    id: "second",
                    sequence: 2,
                }),
            );
            await Promise.resolve();
            await Promise.resolve();
            expect(strokes.get()).toHaveLength(0);
            expect(syncStatus.get()).toBe("offline");
            await vi.advanceTimersByTimeAsync(3000);
            expect(
                strokes.get().map((stroke) => stroke.properties.clientUuid),
            ).toEqual(["first", "second"]);
        } finally {
            stopSSE();
            vi.useRealTimers();
        }
    });
});

// ── Recovery from a stream or replay that keeps failing ──────────────────────
describe("stream and replay recovery", () => {
    const emptyPage = () => ({
        ok: true,
        status: 200,
        json: async () => ({ events: [], nextAfter: null }),
    });

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        stopSSE();
        vi.useRealTimers();
    });

    function closeStream(stream: MockEventSource) {
        stream.readyState = MockEventSource.CLOSED;
        stream.onerror!(new Event("error"));
    }

    test("reopens a stream that closed for good, backing off until one opens", async () => {
        mockFetch.mockImplementation(async () => emptyPage());
        startSSE(SID);
        const first = MockEventSource._last!;
        first.onopen!(new Event("open"));
        await vi.advanceTimersByTimeAsync(0);

        closeStream(first);
        await vi.advanceTimersByTimeAsync(2999);
        expect(MockEventSource._last).toBe(first);
        await vi.advanceTimersByTimeAsync(1);
        const second = MockEventSource._last!;
        expect(second).not.toBe(first);
        expect(mockFetch).toHaveBeenCalledWith(
            `http://localhost:3001/sessions/${SID}/events/cursor`,
            expect.objectContaining({ credentials: "include" }),
        );

        // Still failing: wait twice as long.
        closeStream(second);
        await vi.advanceTimersByTimeAsync(5999);
        expect(MockEventSource._last).toBe(second);
        await vi.advanceTimersByTimeAsync(1);
        const third = MockEventSource._last!;
        expect(third).not.toBe(second);

        // A stream that opens resets the backoff.
        third.onopen!(new Event("open"));
        expect(syncStatus.get()).toBe("live");
        closeStream(third);
        await vi.advanceTimersByTimeAsync(3000);
        expect(MockEventSource._last).not.toBe(third);
    });

    test("keeps backing off without opening a stream while the server is down", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 502 });
        startSSE(SID);
        const stream = MockEventSource._last!;
        closeStream(stream);

        // 3 + 6 + 12 + 24 seconds, then every 30.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(mockFetch).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(mockFetch).toHaveBeenCalledTimes(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(5);
        expect(MockEventSource._last).toBe(stream);
    });

    test.each([403, 404])(
        "stops and reports a closed stream whose session answers %i",
        async (status) => {
            const onUnavailable = vi.fn();
            mockFetch.mockResolvedValue({ ok: false, status });
            startSSE(SID, onUnavailable);
            const stream = MockEventSource._last!;
            closeStream(stream);

            await vi.advanceTimersByTimeAsync(3000);
            expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(status);
            expect(stream.close).toHaveBeenCalled();
            expect(MockEventSource._last).toBe(stream);

            await vi.advanceTimersByTimeAsync(120_000);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        },
    );

    test.each([403, 404])(
        "stops replaying and reports the session when gap fill answers %i",
        async (status) => {
            const onUnavailable = vi.fn();
            mockFetch.mockResolvedValue({ ok: false, status });
            startSSE(SID, onUnavailable);
            const stream = MockEventSource._last!;
            stream.onopen!(new Event("open"));

            await vi.advanceTimersByTimeAsync(0);
            expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(status);
            expect(stream.close).toHaveBeenCalled();
            expect(syncStatus.get()).not.toBe("live");

            await vi.advanceTimersByTimeAsync(120_000);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        },
    );

    test("backs off between failed gap fills and resets once one completes", async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 });
        startSSE(SID);
        const stream = MockEventSource._last!;
        stream.onopen!(new Event("open"));
        await vi.advanceTimersByTimeAsync(0);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Retries after 3, 6 and 12 seconds.
        await vi.advanceTimersByTimeAsync(3000);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(5999);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(3);

        mockFetch.mockImplementation(async () => emptyPage());
        await vi.advanceTimersByTimeAsync(12_000);
        expect(mockFetch).toHaveBeenCalledTimes(4);
        expect(syncStatus.get()).toBe("live");

        // The next failure starts from the shortest delay again.
        mockFetch.mockResolvedValue({ ok: false, status: 503 });
        stream.onopen!(new Event("open"));
        await vi.advanceTimersByTimeAsync(0);
        expect(mockFetch).toHaveBeenCalledTimes(5);
        await vi.advanceTimersByTimeAsync(3000);
        expect(mockFetch).toHaveBeenCalledTimes(6);
    });
});
