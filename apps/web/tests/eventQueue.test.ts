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

// ── Active-session pointer ───────────────────────────────────────────────────
// The session's CONTENTS live in localStorage (above). Which session you were in
// used to live only in sessionStorage, which dies with the tab — so a discarded
// mobile tab left the cache above intact but unreachable, and the picker
// reappeared as if the session had never existed. These pin the two-tier pointer
// that fixes it, including the multi-tab behaviour it must not regress.
describe("activeSession pointer", () => {
    const ssStore = new Map<string, string>();

    const mkStorage = (m: Map<string, string>) => ({
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v); },
        removeItem: (k: string) => { m.delete(k); },
        clear: () => m.clear(),
    });

    const SS_KEY = "taibled-active-session";
    const LS_KEY = "taibled-last-session";

    // The module resolves the pointer at import time, so each case needs a fresh
    // module registry with the storages already in the desired state.
    async function importFresh() {
        vi.resetModules();
        vi.stubGlobal("sessionStorage", mkStorage(ssStore));
        vi.stubGlobal("localStorage", mkStorage(store));
        return await import("@/lib/activeSession");
    }

    const summary = (id: string) => ({ id }) as never;

    beforeEach(() => { ssStore.clear(); store.clear(); });

    test("a tab with its own pointer keeps it — multi-tab is unchanged", async () => {
        ssStore.set(SS_KEY, "tab-session");
        store.set(LS_KEY, "other-session");
        const { activeSessionId } = await importFresh();
        expect(activeSessionId.get()).toBe("tab-session");
    });

    test("a discarded tab falls back to the last session on the device", async () => {
        store.set(LS_KEY, "survived");
        const { activeSessionId } = await importFresh();
        expect(activeSessionId.get()).toBe("survived");
    });

    test("falling back adopts the id, so the tab stops depending on the shared value", async () => {
        store.set(LS_KEY, "survived");
        await importFresh();
        expect(ssStore.get(SS_KEY)).toBe("survived");
    });

    test("with neither tier set, there is no session and the picker shows", async () => {
        const { activeSessionId } = await importFresh();
        expect(activeSessionId.get()).toBe("");
    });

    test("setActiveSession writes both tiers", async () => {
        const { setActiveSession } = await importFresh();
        setActiveSession(summary("picked"));
        expect(ssStore.get(SS_KEY)).toBe("picked");
        expect(store.get(LS_KEY)).toBe("picked");
    });

    test("clearActiveSession clears both — a logout must not leave a durable pointer", async () => {
        const { setActiveSession, clearActiveSession, activeSessionId } = await importFresh();
        setActiveSession(summary("picked"));
        clearActiveSession();
        expect(ssStore.has(SS_KEY)).toBe(false);
        expect(store.has(LS_KEY)).toBe(false);
        expect(activeSessionId.get()).toBe("");
    });

    test("survives storage that throws, as in a locked-down privacy mode", async () => {
        vi.resetModules();
        const throwing = {
            getItem: () => { throw new Error("denied"); },
            setItem: () => { throw new Error("denied"); },
            removeItem: () => { throw new Error("denied"); },
        };
        vi.stubGlobal("sessionStorage", throwing);
        vi.stubGlobal("localStorage", throwing);
        const mod = await import("@/lib/activeSession");
        expect(mod.activeSessionId.get()).toBe("");
        expect(() => mod.setActiveSession(summary("x"))).not.toThrow();
        expect(mod.activeSessionId.get()).toBe("x");
    });
});
