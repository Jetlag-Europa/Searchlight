import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EventRecord } from "@taibled/shared";

// ── localStorage mock (same as eventQueue.test.ts) ───────────────────────────
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
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
    close = vi.fn();

    constructor(url: string, opts?: { withCredentials?: boolean }) {
        this.url = url;
        this.withCredentials = opts?.withCredentials ?? false;
        MockEventSource._last = this;
    }

    static _last: MockEventSource | null = null;
    static reset() { MockEventSource._last = null; }
}

vi.stubGlobal("EventSource", MockEventSource);

// ── fetch mock (for gap-fill) ─────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Imports (after globals are stubbed) ───────────────────────────────────────
import { startSSE, stopSSE } from "@/lib/sseManager";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { questions, syncStatus } from "@/lib/context";
import { enqueueEvent, setCachedSession } from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";

const SID = "sse-test-session";

function makeStroke(clientUuid: string): StrokeFeature {
    return {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [] },
        properties: { tool: "pen", color: "#000000", widthMeters: 3, createdAt: 0, clientUuid },
    };
}

function makeEvent(type: string, payloadJson: unknown, overrides: Partial<EventRecord> = {}): EventRecord {
    return {
        id: "ev-" + Math.random(),
        sessionId: SID,
        userId: "other-user",
        type,
        payloadJson,
        clientUuid: "ev-uuid-" + Math.random(),
        clientCreatedAt: "2025-01-01T00:00:00.000Z",
        serverReceivedAt: new Date().toISOString(),
        ...overrides,
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
        expect(MockEventSource._last!.url).toBe(`http://localhost:3001/sessions/${SID}/stream`);
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
        const incoming = [{ clientUuid: "q1", ordinal: 0, payloadJson: { id: "q1" } }];
        startSSE(SID);
        simulateMessage(makeEvent("questions.replace", { questions: incoming }));
        const qs = questions.get() as unknown as Array<{ id: string }>;
        expect(qs).toHaveLength(1);
        expect(qs[0].id).toBe("q1");
    });

    test("is skipped when a pending questions.replace exists in local queue", () => {
        questions.set([{ id: "original" }] as unknown as Questions);
        // Enqueue a local pending replace
        enqueueEvent({
            sessionId: SID,
            type: "questions.replace",
            payloadJson: { replacementId: "r-local", questions: [] },
            clientUuid: "questions-replace-r-local",
            clientCreatedAt: Date.now(),
        });
        startSSE(SID);
        const incoming = [{ clientUuid: "q-foreign", ordinal: 0, payloadJson: { id: "foreign" } }];
        simulateMessage(makeEvent("questions.replace", { questions: incoming }));
        // Questions should remain unchanged
        const qs = questions.get() as unknown as Array<{ id: string }>;
        expect(qs[0].id).toBe("original");
    });
});

// ── Gap fill on reconnect ─────────────────────────────────────────────────────
describe("gap fill", () => {
    test("fetches missed events after onerror + onopen", async () => {
        // Seed a cache with a lastServerEventAt so gap fill has a since param.
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastServerEventAt: "2025-01-01T00:00:00.000Z",
        });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ events: [] }),
        });

        startSSE(SID);
        const es = MockEventSource._last!;
        es.onopen!(new Event("open")); // first open — no gap fill
        es.onerror!(new Event("error")); // marks hadError
        es.onopen!(new Event("open")); // reconnect — triggers gap fill

        // yield to microtask queue so the async gapFill runs
        await new Promise((r) => setTimeout(r, 0));

        expect(mockFetch).toHaveBeenCalledOnce();
        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain(`/sessions/${SID}/events?since=`);
    });

    test("gap-fill events are applied to atoms", async () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastServerEventAt: "2025-01-01T00:00:00.000Z",
        });

        const gapStroke = makeStroke("gap-stroke");
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                events: [makeEvent("stroke.create", gapStroke)],
            }),
        });

        startSSE(SID);
        const es = MockEventSource._last!;
        es.onopen!(new Event("open"));
        es.onerror!(new Event("error"));
        es.onopen!(new Event("open"));

        await new Promise((r) => setTimeout(r, 0));

        expect(strokes.get()).toHaveLength(1);
        expect(strokes.get()[0].properties.clientUuid).toBe("gap-stroke");
    });
});
