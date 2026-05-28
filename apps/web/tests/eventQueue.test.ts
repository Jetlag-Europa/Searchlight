import { beforeEach, describe, expect, test, vi } from "vitest";
import {
    applyPendingEventsToState,
    clearCachedSession,
    enqueueEvent,
    getCachedSession,
    markEventFailed,
    markEventSynced,
    getPendingEvents,
    resetFailedEvents,
    setCachedSession,
} from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";

// ── localStorage mock ────────────────────────────────────────────────────────
// The default Vitest environment is Node, which has no localStorage.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
});

const SID = "test-session";

beforeEach(() => { store.clear(); });

// ── Helpers ──────────────────────────────────────────────────────────────────
function stroke(clientUuid: string): StrokeFeature {
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

function baseEvent(overrides: Partial<Parameters<typeof enqueueEvent>[0]> = {}) {
    return {
        sessionId: SID,
        type: "stroke.create" as const,
        payloadJson: {},
        clientUuid: crypto.randomUUID(),
        clientCreatedAt: Date.now(),
        ...overrides,
    };
}

// ── enqueueEvent ─────────────────────────────────────────────────────────────
describe("enqueueEvent", () => {
    test("creates event with pending status and a localId", () => {
        const e = enqueueEvent(baseEvent({ clientUuid: "uuid-1" }));
        expect(e.status).toBe("pending");
        expect(e.localId).toBeTruthy();
        expect(e.clientUuid).toBe("uuid-1");
    });

    test("persists to localStorage immediately", () => {
        enqueueEvent(baseEvent({ clientUuid: "uuid-persist" }));
        const stored = getPendingEvents(SID);
        expect(stored).toHaveLength(1);
        expect(stored[0].clientUuid).toBe("uuid-persist");
    });

    test("accumulates multiple events in order", () => {
        enqueueEvent(baseEvent({ clientUuid: "a" }));
        enqueueEvent(baseEvent({ clientUuid: "b" }));
        enqueueEvent(baseEvent({ clientUuid: "c" }));
        const events = getPendingEvents(SID);
        expect(events.map((e) => e.clientUuid)).toEqual(["a", "b", "c"]);
    });
});

// ── markEventSynced ──────────────────────────────────────────────────────────
describe("markEventSynced", () => {
    test("removes the event from the queue", () => {
        const e1 = enqueueEvent(baseEvent({ clientUuid: "s1" }));
        const e2 = enqueueEvent(baseEvent({ clientUuid: "s2" }));
        markEventSynced(SID, e1.localId);
        const remaining = getPendingEvents(SID);
        expect(remaining).toHaveLength(1);
        expect(remaining[0].clientUuid).toBe("s2");
    });

    test("no-op when localId does not exist", () => {
        enqueueEvent(baseEvent({ clientUuid: "x" }));
        markEventSynced(SID, "nonexistent-local-id");
        expect(getPendingEvents(SID)).toHaveLength(1);
    });
});

// ── markEventFailed / resetFailedEvents ──────────────────────────────────────
describe("markEventFailed / resetFailedEvents", () => {
    test("sets status to failed", () => {
        const e = enqueueEvent(baseEvent({ clientUuid: "f1" }));
        markEventFailed(SID, e.localId);
        expect(getPendingEvents(SID)[0].status).toBe("failed");
    });

    test("resetFailedEvents sets all failed back to pending", () => {
        const e1 = enqueueEvent(baseEvent({ clientUuid: "f2" }));
        const e2 = enqueueEvent(baseEvent({ clientUuid: "f3" }));
        markEventFailed(SID, e1.localId);
        markEventFailed(SID, e2.localId);
        resetFailedEvents(SID);
        const events = getPendingEvents(SID);
        expect(events.every((e) => e.status === "pending")).toBe(true);
    });

    test("resetFailedEvents leaves pending events untouched", () => {
        const e1 = enqueueEvent(baseEvent({ clientUuid: "r1" }));
        enqueueEvent(baseEvent({ clientUuid: "r2" })); // stays pending
        markEventFailed(SID, e1.localId);
        resetFailedEvents(SID);
        expect(getPendingEvents(SID).every((e) => e.status === "pending")).toBe(true);
    });
});

// ── session cache ─────────────────────────────────────────────────────────────
describe("setCachedSession / getCachedSession", () => {
    test("roundtrips strokes and questions", () => {
        setCachedSession({
            sessionId: SID,
            strokes: [stroke("s1")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 12345,
            lastServerEventAt: "2025-01-01T00:00:00.000Z",
        });
        const cached = getCachedSession(SID);
        expect(cached?.sessionId).toBe(SID);
        expect(cached?.lastSyncedAt).toBe(12345);
        expect(cached?.strokes).toHaveLength(1);
        expect(cached?.strokes[0].properties.clientUuid).toBe("s1");
    });

    test("returns null when no cache exists", () => {
        expect(getCachedSession(SID)).toBeNull();
    });

    test("overwrites previous cache entry", () => {
        setCachedSession({ sessionId: SID, strokes: [], questions: [] as unknown as Questions, lastSyncedAt: 1, lastServerEventAt: "" });
        setCachedSession({ sessionId: SID, strokes: [], questions: [] as unknown as Questions, lastSyncedAt: 999, lastServerEventAt: "" });
        expect(getCachedSession(SID)?.lastSyncedAt).toBe(999);
    });
});

describe("clearCachedSession", () => {
    test("removes both cache and pending queue", () => {
        setCachedSession({ sessionId: SID, strokes: [], questions: [] as unknown as Questions, lastSyncedAt: 0, lastServerEventAt: "" });
        enqueueEvent(baseEvent({ clientUuid: "clr" }));
        clearCachedSession(SID);
        expect(getCachedSession(SID)).toBeNull();
        expect(getPendingEvents(SID)).toHaveLength(0);
    });
});

// ── applyPendingEventsToState ─────────────────────────────────────────────────
describe("applyPendingEventsToState", () => {
    function event(type: string, payload: unknown) {
        return { type, payloadJson: payload } as Parameters<typeof applyPendingEventsToState>[1][0];
    }

    test("stroke.create adds a new stroke", () => {
        const s = stroke("new-stroke");
        const result = applyPendingEventsToState(
            { strokes: [], questions: [] as unknown as Questions },
            [event("stroke.create", s)],
        );
        expect(result.strokes).toHaveLength(1);
        expect(result.strokes[0].properties.clientUuid).toBe("new-stroke");
    });

    test("stroke.create deduplicates by clientUuid", () => {
        const s = stroke("dup");
        const result = applyPendingEventsToState(
            { strokes: [s], questions: [] as unknown as Questions },
            [event("stroke.create", s)],
        );
        expect(result.strokes).toHaveLength(1);
    });

    test("stroke.delete removes the matching stroke", () => {
        const s1 = stroke("del-me");
        const s2 = stroke("keep-me");
        const result = applyPendingEventsToState(
            { strokes: [s1, s2], questions: [] as unknown as Questions },
            [event("stroke.delete", { clientUuid: "del-me" })],
        );
        expect(result.strokes).toHaveLength(1);
        expect(result.strokes[0].properties.clientUuid).toBe("keep-me");
    });

    test("stroke.delete is a no-op when clientUuid is not present", () => {
        const s = stroke("present");
        const result = applyPendingEventsToState(
            { strokes: [s], questions: [] as unknown as Questions },
            [event("stroke.delete", { clientUuid: "absent" })],
        );
        expect(result.strokes).toHaveLength(1);
    });

    test("questions.replace replaces the full questions array", () => {
        const newQs = [{ id: "q1" }, { id: "q2" }] as unknown as Questions;
        const result = applyPendingEventsToState(
            { strokes: [], questions: [{ id: "old" }] as unknown as Questions },
            [event("questions.replace", { questions: newQs })],
        );
        expect(result.questions).toHaveLength(2);
    });

    test("events are applied in sequence", () => {
        const s1 = stroke("s1");
        const s2 = stroke("s2");
        const result = applyPendingEventsToState(
            { strokes: [], questions: [] as unknown as Questions },
            [
                event("stroke.create", s1),
                event("stroke.delete", { clientUuid: "s1" }),
                event("stroke.create", s2),
            ],
        );
        expect(result.strokes).toHaveLength(1);
        expect(result.strokes[0].properties.clientUuid).toBe("s2");
    });

    test("does not mutate the base object", () => {
        const base = { strokes: [stroke("orig")], questions: [] as unknown as Questions };
        applyPendingEventsToState(base, [event("stroke.delete", { clientUuid: "orig" })]);
        expect(base.strokes).toHaveLength(1); // original untouched
    });
});
