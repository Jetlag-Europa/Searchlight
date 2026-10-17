import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
    applyPendingEventsToState,
    applyUnsyncedEvents,
    clearCachedSession,
    discardSessionData,
    enqueueEvent,
    evictOldCachedSessions,
    getCachedSession,
    markEventFailed,
    markEventSynced,
    getPendingEvents,
    resetFailedEvents,
    setCachedSession,
} from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";
import type { GameSessionSummary } from "@searchlight/shared";

// ── localStorage mock ────────────────────────────────────────────────────────
// The default Vitest environment is Node, which has no localStorage.
const store = new Map<string, string>();
function mockStorage(values: Map<string, string>) {
    return {
        getItem: (k: string) => values.get(k) ?? null,
        setItem: (k: string, v: string) => {
            values.set(k, v);
        },
        removeItem: (k: string) => {
            values.delete(k);
        },
        clear: () => values.clear(),
        get length() {
            return values.size;
        },
        key: (i: number) => Array.from(values.keys())[i] ?? null,
    };
}
vi.stubGlobal("localStorage", mockStorage(store));

const SID = "test-session";

beforeEach(() => {
    store.clear();
});

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

function baseEvent(
    overrides: Partial<Parameters<typeof enqueueEvent>[0]> = {},
) {
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
        expect(getPendingEvents(SID).every((e) => e.status === "pending")).toBe(
            true,
        );
    });
});

// ── session cache ─────────────────────────────────────────────────────────────
describe("pre-rename browser storage compatibility", () => {
    test("recovers a saved snapshot and replays its pre-rename pending queue", () => {
        // Serialized state in the format written before the Searchlight rename.
        // Seed the deployed keys directly rather than using the current writers.
        store.set(
            "taibled-cache-test-session",
            `{
            "sessionId": "test-session",
            "strokes": [{
                "type": "Feature",
                "geometry": { "type": "LineString", "coordinates": [[4.47, 51.92], [4.48, 51.93]] },
                "properties": {
                    "tool": "pen", "color": "#000000", "widthMeters": 3,
                    "createdAt": 1735689600000, "clientUuid": "saved-stroke"
                }
            }],
            "questions": [],
            "lastSyncedAt": 1735689600000,
            "lastServerEventAt": "2025-01-01T00:00:00.000Z"
        }`,
        );
        store.set(
            "taibled-pending-test-session",
            `[{
            "localId": "pending-create",
            "sessionId": "test-session",
            "type": "stroke.create",
            "payloadJson": {
                "type": "Feature",
                "geometry": { "type": "LineString", "coordinates": [[4.49, 51.92], [4.50, 51.93]] },
                "properties": {
                    "tool": "pen", "color": "#ff0000", "widthMeters": 3,
                    "createdAt": 1735689601000, "clientUuid": "offline-stroke"
                }
            },
            "clientUuid": "offline-stroke",
            "clientCreatedAt": 1735689601000,
            "status": "pending",
            "createdAt": 1735689601000
        }]`,
        );

        const cached = getCachedSession(SID);
        expect(cached?.lastSequence).toBe(0);
        const pending = getPendingEvents(SID).filter(
            (event) => event.status === "pending",
        );
        const restored = applyPendingEventsToState(cached!, pending);
        expect(
            restored.strokes.map((item) => item.properties.clientUuid),
        ).toEqual(["saved-stroke", "offline-stroke"]);
    });
});

describe("setCachedSession / getCachedSession", () => {
    test("roundtrips strokes and questions", () => {
        setCachedSession({
            sessionId: SID,
            strokes: [stroke("s1")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 12345,
            lastSequence: 42,
        });
        const cached = getCachedSession(SID);
        expect(cached?.sessionId).toBe(SID);
        expect(cached?.lastSyncedAt).toBe(12345);
        expect(cached?.lastSequence).toBe(42);
        expect(cached?.strokes).toHaveLength(1);
        expect(cached?.strokes[0].properties.clientUuid).toBe("s1");
    });

    test("migrates cached cursor to numeric 0 on old snapshots", () => {
        // Old snapshot format in localStorage without numeric lastSequence
        store.set(
            `taibled-cache-${SID}`,
            JSON.stringify({
                sessionId: SID,
                strokes: [],
                questions: [],
                lastSyncedAt: 100,
                lastServerEventAt: "2025-01-01T00:00:00.000Z",
            }),
        );
        const cached = getCachedSession(SID);
        expect(cached?.lastSequence).toBe(0);
    });

    test("returns null when no cache exists", () => {
        expect(getCachedSession(SID)).toBeNull();
    });

    test("overwrites previous cache entry", () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1,
            lastSequence: 1,
        });
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 999,
            lastSequence: 2,
        });
        expect(getCachedSession(SID)?.lastSyncedAt).toBe(999);
        expect(getCachedSession(SID)?.lastSequence).toBe(2);
    });

    test("bounded eviction retains unsynced session bases and evicts old disposable caches", () => {
        // Enqueue a pending event for session-0
        enqueueEvent(
            baseEvent({
                sessionId: "session-0",
                clientUuid: "pending-preserve",
            }),
        );

        // Write 12 cached sessions (max is 10)
        for (let i = 0; i < 12; i++) {
            setCachedSession({
                sessionId: `session-${i}`,
                strokes: [],
                questions: [] as unknown as Questions,
                lastSyncedAt: 1000 + i,
                lastSequence: i,
            });
        }

        // The oldest session has pending edits, so evict the next two instead.
        expect(getCachedSession("session-0")).not.toBeNull();
        expect(getCachedSession("session-1")).toBeNull();
        expect(getCachedSession("session-2")).toBeNull();
        expect(getCachedSession("session-3")).not.toBeNull();
        expect(getCachedSession("session-11")).not.toBeNull();

        // But pending queue for session-0 MUST NEVER be evicted!
        const pending = getPendingEvents("session-0");
        expect(pending).toHaveLength(1);
        expect(pending[0].clientUuid).toBe("pending-preserve");
    });
});

describe("clearCachedSession", () => {
    test("removes cache while preserving pending queue", () => {
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        enqueueEvent(baseEvent({ clientUuid: "clr" }));
        clearCachedSession(SID);
        expect(getCachedSession(SID)).toBeNull();
        expect(getPendingEvents(SID)).toHaveLength(1);
    });
});

describe("discardSessionData", () => {
    test("drops the queue and cache of a session that can no longer sync", () => {
        enqueueEvent(baseEvent());
        setCachedSession({
            sessionId: SID,
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1,
            lastSequence: 0,
        });
        enqueueEvent(baseEvent({ sessionId: "other-session" }));
        discardSessionData(SID);
        expect(getPendingEvents(SID)).toEqual([]);
        expect(getCachedSession(SID)).toBeNull();
        expect(getPendingEvents("other-session")).toHaveLength(1);
    });
});

describe("offline storage failure & distinct event IDs", () => {
    afterEach(() => vi.restoreAllMocks());
    test("distinct localId ensures earlier ACK does not delete newer pending event", () => {
        const e1 = enqueueEvent({
            sessionId: SID,
            type: "hider.update",
            payloadJson: { hiderLat: 1, hiderLng: 1 },
            clientUuid: "hider-1",
            clientCreatedAt: 1,
        });
        const e2 = enqueueEvent({
            sessionId: SID,
            type: "hider.update",
            payloadJson: { hiderLat: 2, hiderLng: 2 },
            clientUuid: "hider-2",
            clientCreatedAt: 2,
        });

        markEventSynced(SID, e1.localId);
        const remaining = getPendingEvents(SID);
        expect(remaining).toEqual([e2]);
        expect(remaining[0].payloadJson).toEqual({ hiderLat: 2, hiderLng: 2 });
    });
    test("evicts disposable snapshots and retries on storage failure; throws if still full", () => {
        // Populate disposable cache
        setCachedSession({
            sessionId: "cached-session-1",
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1,
            lastSequence: 1,
        });
        expect(getCachedSession("cached-session-1")).not.toBeNull();

        let attempts = 0;
        const origSetItem = localStorage.setItem;
        vi.spyOn(localStorage, "setItem").mockImplementation((k, v) => {
            if (k.startsWith("taibled-pending-")) {
                attempts++;
                if (attempts === 1) {
                    throw new Error("QuotaExceeded");
                }
            }
            origSetItem.call(localStorage, k, v);
        });

        // First attempt fails, evicts snapshots, retries and succeeds!
        enqueueEvent(baseEvent({ clientUuid: "recovered-event" }));
        expect(getCachedSession("cached-session-1")).toBeNull();
        expect(getPendingEvents(SID)).toHaveLength(1);

        // If it throws even after evicting snapshots: surfaces error rather than claiming durability
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new Error("Disk full");
        });
        expect(() =>
            enqueueEvent(baseEvent({ clientUuid: "fail-event" })),
        ).toThrow("Failed to persist pending event to storage");
    });
    test("protects the current session base while retrying its first queued edit", () => {
        setCachedSession({
            sessionId: SID,
            strokes: [stroke("base")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1,
            lastSequence: 0,
        });
        let attempts = 0;
        const original = localStorage.setItem.bind(localStorage);
        vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
            if (key === `taibled-pending-${SID}` && attempts++ === 0) {
                throw new Error("QuotaExceeded");
            }
            original(key, value);
        });
        enqueueEvent(baseEvent({ clientUuid: "first-offline-edit" }));
        expect(getCachedSession(SID)?.strokes[0].properties.clientUuid).toBe("base");
        expect(getPendingEvents(SID)).toHaveLength(1);
    });
    test("keeps the base snapshot for a session with unsynced edits", () => {
        setCachedSession({
            sessionId: "pending-session",
            strokes: [stroke("base")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1,
            lastSequence: 0,
        });
        enqueueEvent({
            sessionId: "pending-session",
            type: "stroke.create",
            payloadJson: stroke("offline"),
            clientUuid: "offline",
            clientCreatedAt: 1,
        });
        setCachedSession({
            sessionId: "disposable-session",
            strokes: [],
            questions: [] as unknown as Questions,
            lastSyncedAt: 2,
            lastSequence: 0,
        });
        evictOldCachedSessions(1);
        expect(
            getCachedSession("pending-session")?.strokes[0].properties
                .clientUuid,
        ).toBe("base");
        expect(getPendingEvents("pending-session")).toHaveLength(1);
        expect(getCachedSession("disposable-session")).toBeNull();
    });
});

// ── applyPendingEventsToState ─────────────────────────────────────────────────
describe("applyPendingEventsToState", () => {
    function event(type: string, payload: unknown) {
        return { type, payloadJson: payload } as Parameters<
            typeof applyPendingEventsToState
        >[1][0];
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

    test("questions.replace handles questions with wrapped payloadJson objects", () => {
        const mapped = [
            {
                clientUuid: "q-1",
                ordinal: 0,
                payloadJson: { id: "q1", title: "First" },
            },
            {
                clientUuid: "q-2",
                ordinal: 1,
                payloadJson: { id: "q2", title: "Second" },
            },
        ];
        const result = applyPendingEventsToState(
            { strokes: [], questions: [] as unknown as Questions },
            [event("questions.replace", { questions: mapped })],
        );
        expect(result.questions).toHaveLength(2);
        expect((result.questions[0] as unknown as { id: string }).id).toBe(
            "q1",
        );
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
        const base = {
            strokes: [stroke("orig")],
            questions: [] as unknown as Questions,
        };
        applyPendingEventsToState(base, [
            event("stroke.delete", { clientUuid: "orig" }),
        ]);
        expect(base.strokes).toHaveLength(1); // original untouched
    });
});

describe("applyUnsyncedEvents", () => {
    test("replays pending and failed edits but not acknowledged ones", () => {
        enqueueEvent(
            baseEvent({ payloadJson: stroke("pending"), clientUuid: "a" }),
        );
        const failed = enqueueEvent(
            baseEvent({ payloadJson: stroke("failed"), clientUuid: "b" }),
        );
        markEventFailed(SID, failed.localId);
        const synced = enqueueEvent(
            baseEvent({
                type: "stroke.delete",
                payloadJson: { clientUuid: "server" },
                clientUuid: "c",
            }),
        );
        // A stale "synced" entry from an older queue must not be replayed.
        store.set(
            `taibled-pending-${SID}`,
            JSON.stringify(
                getPendingEvents(SID).map((event) =>
                    event.localId === synced.localId
                        ? { ...event, status: "synced" }
                        : event,
                ),
            ),
        );

        const result = applyUnsyncedEvents(SID, {
            strokes: [stroke("server")],
            questions: [] as unknown as Questions,
        });
        expect(result.strokes.map((s) => s.properties.clientUuid)).toEqual([
            "server",
            "pending",
            "failed",
        ]);
    });
});

describe("active session restoration", () => {
    const tabStore = new Map<string, string>();
    const SS_KEY = "taibled-active-session";
    const LS_KEY = "taibled-last-session";
    const summary: GameSessionSummary = {
        id: SID,
        gameId: "test-game",
        gameName: "Test game",
        serverId: "test-server",
        name: "Test session",
        visibility: "private",
        role: "creator",
        createdAt: "2025-01-01T00:00:00.000Z",
        hiderLat: null,
        hiderLng: null,
        planningModeEnabled: false,
        gameRevisionId: "test-revision",
    };

    async function reloadSession() {
        vi.resetModules();
        return import("@/lib/activeSession");
    }

    beforeEach(() => {
        tabStore.clear();
        vi.stubGlobal("sessionStorage", mockStorage(tabStore));
        vi.stubGlobal("localStorage", mockStorage(store));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test("restores a selected session and its cache after losing tab storage", async () => {
        const session = await reloadSession();
        session.setActiveSession(summary);
        setCachedSession({
            sessionId: SID,
            strokes: [stroke("saved-stroke")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 12345,
            lastSequence: 0,
        });

        tabStore.clear();
        const restored = await reloadSession();
        expect(restored.activeSessionId.get()).toBe(SID);
        expect(
            getCachedSession(restored.activeSessionId.get())?.strokes[0]
                .properties.clientUuid,
        ).toBe("saved-stroke");
    });

    test("keeps an existing tab's session instead of another tab's last selection", async () => {
        tabStore.set(SS_KEY, "this-tab");
        store.set(LS_KEY, "other-tab");
        const session = await reloadSession();
        expect(session.activeSessionId.get()).toBe("this-tab");
    });

    test("keeps an adopted session across reload when another tab selects later", async () => {
        store.set(LS_KEY, SID);
        await reloadSession();
        store.set(LS_KEY, "other-tab");

        const reloaded = await reloadSession();
        expect(reloaded.activeSessionId.get()).toBe(SID);
    });

    test("does not restore a cleared session after tab loss", async () => {
        const session = await reloadSession();
        session.setActiveSession(summary);
        session.clearActiveSession();
        expect(session.activeSessionId.get()).toBe("");
        expect(session.activeSessionData.get()).toBeNull();

        tabStore.clear();
        const restored = await reloadSession();
        expect(restored.activeSessionId.get()).toBe("");
    });

    test("keeps a cleared tab independent of later selections in another tab", async () => {
        const session = await reloadSession();
        session.setActiveSession(summary);
        session.clearActiveSession();
        store.set(LS_KEY, "other-tab");

        const reloaded = await reloadSession();
        expect(reloaded.activeSessionId.get()).toBe("");
    });

    test("can select and reload within the tab when durable writes are denied", async () => {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new Error("quota exceeded");
        });
        const session = await reloadSession();
        session.setActiveSession(summary);
        expect(session.activeSessionId.get()).toBe(SID);

        const reloaded = await reloadSession();
        expect(reloaded.activeSessionId.get()).toBe(SID);
        reloaded.clearActiveSession();
        const cleared = await reloadSession();
        expect(cleared.activeSessionId.get()).toBe("");
    });

    test("uses durable storage even when access to tab storage is denied", async () => {
        store.set(LS_KEY, SID);
        Object.defineProperty(globalThis, "sessionStorage", {
            configurable: true,
            get: () => {
                throw new Error("denied");
            },
        });
        const session = await reloadSession();
        expect(session.activeSessionId.get()).toBe(SID);
        session.setActiveSession({ ...summary, id: "new-selection" });

        vi.stubGlobal("sessionStorage", mockStorage(tabStore));
        const restored = await reloadSession();
        expect(restored.activeSessionId.get()).toBe("new-selection");
    });

    test.each(["getters", "methods"])(
        "keeps selection usable in memory when storage %s throw",
        async (failure) => {
            const denied = () => {
                throw new Error("denied");
            };
            for (const name of ["sessionStorage", "localStorage"] as const) {
                if (failure === "getters") {
                    Object.defineProperty(globalThis, name, {
                        configurable: true,
                        get: denied,
                    });
                } else {
                    vi.stubGlobal(name, {
                        getItem: denied,
                        setItem: denied,
                        removeItem: denied,
                    });
                }
            }

            const session = await reloadSession();
            expect(session.activeSessionId.get()).toBe("");
            session.setActiveSession(summary);
            expect(session.activeSessionId.get()).toBe(SID);
            expect(session.activeSessionData.get()?.id).toBe(SID);
            session.clearActiveSession();
            expect(session.activeSessionId.get()).toBe("");
            expect(session.activeSessionData.get()).toBeNull();
        },
    );
});
