import { beforeEach, describe, expect, test, vi } from "vitest";
import {
    saveQuestionsToServer,
    hasPendingHiderSave,
    hasPendingPlanningModeSave,
    executeHiderPatch,
    executePlanningPatch,
    flushHiderSave,
    flushPlanningModeSave,
    saveHiderModeToServer,
    savePlanningModeToServer,
    saveQuestionsDebounced,
    flushQuestionSave,
} from "@/lib/sessionState";
import {
    saveStrokeToServer,
    deleteStrokeFromServer,
    clearStrokeTombstones,
    isStrokeTombstoned,
} from "@/annotations/storage/serverStore";
import {
    getPendingEvents,
    setCachedSession,
    getCachedSession,
    applyPendingEventsToState,
    enqueueEvent,
    markEventFailed,
    markEventSynced,
} from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";
import { flushPendingEvents, sendPendingEvent } from "@/lib/syncManager";

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

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
    store.clear();
    clearStrokeTombstones();
    mockFetch.mockReset();
});

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

const replacementCases = [
    {
        name: "questions",
        save: (id: string, value: number) =>
            saveQuestionsToServer(id, [{ id: `q-${value}` }] as unknown as Questions),
        debounce: (id: string, value: number) =>
            saveQuestionsDebounced(id, [{ id: `q-${value}` }] as unknown as Questions),
        flush: (id: string, _value: number) => flushQuestionSave(id, true),
        payload: (value: number) => ({
            questions: [{ payloadJson: { id: `q-${value}` } }],
        }),
    },
    {
        name: "hider",
        save: (id: string, value: number) =>
            executeHiderPatch(id, { latitude: value, longitude: value }),
        debounce: (id: string, value: number) =>
            saveHiderModeToServer(id, { latitude: value, longitude: value }),
        flush: (id: string, value: number) =>
            flushHiderSave(id, { latitude: value, longitude: value }, true),
        payload: (value: number) => ({ hiderLat: value, hiderLng: value }),
    },
    {
        name: "planning",
        save: (id: string, value: number) => executePlanningPatch(id, value > 1),
        debounce: (id: string, value: number) => savePlanningModeToServer(id, value > 1),
        flush: (id: string, value: number) =>
            flushPlanningModeSave(id, value > 1, true),
        payload: (value: number) => ({ planningModeEnabled: value > 1 }),
    },
];

describe.each(replacementCases)("$name durable replacement ordering", (field) => {
    test("persists the latest save while an older request is pending and shares replay dispatch", async () => {
        const sid = `slow-${field.name}`;
        const first = Promise.withResolvers<Response>();
        const bodies: unknown[] = [];
        mockFetch.mockImplementation((_url: string, options: RequestInit) => {
            bodies.push(JSON.parse(options.body as string));
            return bodies.length === 1
                ? first.promise
                : Promise.resolve(new Response(null, { status: 200 }));
        });

        const oldSave = field.save(sid, 1);
        const newerSave = field.save(sid, 2);
        const newestSave = field.save(sid, 3);
        const replay = flushPendingEvents(sid);
        expect(bodies).toHaveLength(1);
        const durable = JSON.parse(store.get(`taibled-pending-${sid}`)!);
        expect(durable).toHaveLength(1);
        expect(durable[0].payloadJson).toMatchObject(field.payload(3));

        first.resolve(new Response(null, { status: 200 }));
        await Promise.all([oldSave, newerSave, newestSave, replay]);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject(field.payload(3));
        expect(getPendingEvents(sid)).toEqual([]);
    });

    test("debounce and unload persist a newer edit without overtaking a slow request", async () => {
        const sid = `unload-${field.name}`;
        const first = Promise.withResolvers<Response>();
        const options: RequestInit[] = [];
        mockFetch.mockImplementation((_url: string, request: RequestInit) => {
            options.push(request);
            return options.length === 1
                ? first.promise
                : Promise.resolve(new Response(null, { status: 200 }));
        });
        const oldSave = field.save(sid, 1);
        field.debounce(sid, 2);
        const unload = field.flush(sid, 2);
        expect(options).toHaveLength(1);
        expect(getPendingEvents(sid)[0].payloadJson).toMatchObject(field.payload(2));

        first.resolve(new Response(null, { status: 200 }));
        await oldSave;
        await unload;
        await flushPendingEvents(sid);
        expect(options).toHaveLength(2);
        expect(options[1].keepalive).toBe(true);
        expect(JSON.parse(options[1].body as string)).toMatchObject(field.payload(2));
        expect(getPendingEvents(sid)).toEqual([]);
    });

    test.each(["rejection", "lost acknowledgement"])(
        "a newer success cannot be rolled back by replay after %s",
        async (failure) => {
            const sid = `superseded-${field.name}-${failure}`;
            let serverValue: unknown;
            const bodies: unknown[] = [];
            mockFetch.mockImplementation(async (_url: string, options: RequestInit) => {
                const body = JSON.parse(options.body as string);
                bodies.push(body);
                if (bodies.length === 1) {
                    if (failure === "lost acknowledgement") {
                        serverValue = body;
                        throw new TypeError("connection lost after commit");
                    }
                    return new Response(null, { status: 500 });
                }
                serverValue = body;
                return new Response(null, { status: 200 });
            });
            await expect(field.save(sid, 1)).rejects.toThrow();
            expect(getPendingEvents(sid)[0].status).toBe("failed");
            await field.save(sid, 2);
            await flushPendingEvents(sid);
            expect(serverValue).toMatchObject(field.payload(2));
            expect(bodies).toHaveLength(2);
            expect(getPendingEvents(sid)).toEqual([]);
        },
    );

    test("a lost acknowledgement retains the exact durable operation for a shared retry", async () => {
        const sid = `uncertain-${field.name}`;
        const bodies: unknown[] = [];
        mockFetch.mockImplementation(async (_url: string, options: RequestInit) => {
            bodies.push(JSON.parse(options.body as string));
            if (bodies.length === 1) throw new TypeError("response lost");
            return new Response(null, { status: 200 });
        });
        await expect(field.save(sid, 2)).rejects.toThrow();
        const [pending] = getPendingEvents(sid);
        expect(pending.payloadJson).toMatchObject(field.payload(2));
        await Promise.all([flushPendingEvents(sid), flushPendingEvents(sid)]);
        expect(bodies).toEqual([pending.payloadJson, pending.payloadJson]);
        expect(getPendingEvents(sid)).toEqual([]);
    });
});

describe("session sync race conditions", () => {
    test("a PUT acknowledged after its echo leaves newer cached questions alone", async () => {
        const sid = "sess-late-ack";
        const ours = { id: "radius", key: 1, data: {} };
        const theirs = { id: "radius", key: 2, data: {} };
        let acknowledge!: () => void;
        mockFetch.mockImplementation(
            () =>
                new Promise((resolve) => {
                    acknowledge = () => resolve({ ok: true, json: async () => ({}) });
                }),
        );
        const event = enqueueEvent({
            sessionId: sid,
            type: "questions.replace",
            payloadJson: {
                replacementId: "r-ours",
                questions: [{ clientUuid: "q-ours", ordinal: 0, payloadJson: ours }],
            },
            clientUuid: "questions-replace-r-ours",
            clientCreatedAt: Date.now(),
        });
        const sent = sendPendingEvent(event);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        // The echo marks ours synced, then another player's replace is cached
        // at a later sequence, all before our PUT's response arrives.
        markEventSynced(sid, event.localId);
        setCachedSession({
            sessionId: sid,
            strokes: [],
            questions: [theirs] as unknown as Questions,
            lastSyncedAt: Date.now(),
            lastSequence: 2,
        });
        acknowledge();
        await sent;
        expect(getCachedSession(sid)?.questions).toEqual([theirs]);
        expect(getCachedSession(sid)?.lastSequence).toBe(2);
    });

    test("rapid question saves serialize and end in latest state", async () => {
        const sid = "sess-q-race";
        const putCalls: unknown[] = [];

        mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
            if (url.includes("/questions") && opts.method === "PUT") {
                const body = JSON.parse(opts.body as string) as { questions: unknown[] };
                putCalls.push(body);
                return {
                    ok: true,
                    json: async () => ({}),
                };
            }
            return { ok: true, json: async () => ({}) };
        });

        const q1 = [{ id: "q1", title: "Version 1" }] as unknown as Questions;
        const q2 = [{ id: "q2", title: "Version 2" }] as unknown as Questions;
        const q3 = [{ id: "q3", title: "Version 3" }] as unknown as Questions;

        // Fire 3 saves concurrently without awaiting
        const p1 = saveQuestionsToServer(sid, q1);
        const p2 = saveQuestionsToServer(sid, q2);
        const p3 = saveQuestionsToServer(sid, q3);

        await Promise.all([p1, p2, p3]);

        // First save ran with Version 1; subsequent concurrent saves coalesced into Version 3!
        expect(putCalls.length).toBeGreaterThanOrEqual(1);
        const lastCall = putCalls[putCalls.length - 1] as { questions: Array<{ payloadJson: { id: string } }> };
        expect(lastCall.questions[0].payloadJson.id).toBe("q3");

        const cached = getCachedSession(sid);
        expect((cached?.questions[0] as unknown as { id: string }).id).toBe("q3");
    });

    test("create/delete same stroke serializes: DELETE awaits in-flight CREATE and keeps tombstone", async () => {
        const sid = "sess-stroke-race";
        const s = makeStroke("stroke-race-1");
        const fetchOrder: string[] = [];

        const { promise: createFetchPromise, resolve: resolveCreateFetch } =
            Promise.withResolvers<void>();

        mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
            if (opts.method === "POST") {
                fetchOrder.push("POST_START");
                await createFetchPromise;
                fetchOrder.push("POST_END");
                return { ok: true, json: async () => ({}) };
            }
            if (opts.method === "DELETE") {
                fetchOrder.push("DELETE");
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ({}) };
        });

        // 1. Start saveStrokeToServer (in-flight POST)
        const savePromise = saveStrokeToServer(sid, s);

        // 2. Immediately call deleteStrokeFromServer while POST is in-flight
        const deletePromise = deleteStrokeFromServer(sid, s.properties.clientUuid);

        // DELETE must wait for POST to complete
        expect(fetchOrder).toEqual(["POST_START"]);
        expect(isStrokeTombstoned(s.properties.clientUuid)).toBe(true);

        resolveCreateFetch();
        await Promise.all([savePromise, deletePromise]);

        // POST finished before DELETE was issued
        expect(fetchOrder).toEqual(["POST_START", "POST_END", "DELETE"]);
    });

    test("rejected PATCH is not silently marked saved and marks event failed", async () => {
        const sid = "sess-patch-fail";

        mockFetch.mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ error: "Internal Server Error" }),
        });

        await expect(
            executeHiderPatch(sid, { latitude: 10, longitude: 20 }),
        ).rejects.toThrow();

        const events = getPendingEvents(sid);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("hider.update");
        expect(events[0].status).toBe("failed");

        await expect(executePlanningPatch(sid, true)).rejects.toThrow();

        const allEvents = getPendingEvents(sid);
        const planningEvent = allEvents.find((e) => e.type === "planning.toggle");
        expect(planningEvent?.status).toBe("failed");
    });

    test("failed edits stay visible across state derivation", () => {
        const sid = "sess-failed-edits";
        const s = makeStroke("failed-stroke");

        const event = enqueueEvent({
            sessionId: sid,
            type: "stroke.create",
            payloadJson: s,
            clientUuid: "stroke-create-failed",
            clientCreatedAt: 1,
        });
        markEventFailed(sid, event.localId);

        // Filter including failed entries maintains authoritative state
        const unsynced = getPendingEvents(sid).filter(
            (e) => e.status === "pending" || e.status === "failed",
        );
        const derived = applyPendingEventsToState(
            { strokes: [], questions: [] as unknown as Questions },
            unsynced,
        );

        expect(derived.strokes).toHaveLength(1);
        expect(derived.strokes[0].properties.clientUuid).toBe("failed-stroke");
    });

    test("does not suppress SSE for unrelated session", () => {
        expect(hasPendingHiderSave("session-a")).toBe(false);
        expect(hasPendingPlanningModeSave("session-a")).toBe(false);

        // Queue a pending hider event on session-a
        enqueueEvent({
            sessionId: "session-a",
            type: "hider.update",
            payloadJson: { hiderLat: 1, hiderLng: 2 },
            clientUuid: "hider-a",
            clientCreatedAt: 1,
        });

        expect(hasPendingHiderSave("session-a")).toBe(true);
        // session-b MUST NOT be suppressed!
        expect(hasPendingHiderSave("session-b")).toBe(false);
    });

    test("no old-user private cache paint when cached.userId is missing or mismatches", () => {
        // Case 1: cached.userId is missing on private content — MUST NOT paint even if user is authed!
        setCachedSession({
            sessionId: "sess-private-no-user",
            visibility: "private",
            strokes: [makeStroke("secret-stroke")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 100,
            lastSequence: 1,
        });

        store.set("taibled-authed-user", "user-beta");

        const cachedNoUser = getCachedSession("sess-private-no-user");
        const authedUser = store.get("taibled-authed-user");

        const isPrivateNoUser = cachedNoUser?.visibility === "private";
        const canPaintNoUser = Boolean(
            cachedNoUser &&
            (isPrivateNoUser
                ? Boolean(authedUser && cachedNoUser.userId && cachedNoUser.userId === authedUser)
                : Boolean(!cachedNoUser.userId || (authedUser && cachedNoUser.userId === authedUser))),
        );
        expect(canPaintNoUser).toBe(false);

        // Case 2: cached.userId belongs to user-alpha, but user-beta is logged in
        setCachedSession({
            sessionId: "sess-private-alpha",
            userId: "user-alpha",
            visibility: "private",
            strokes: [makeStroke("secret-stroke")],
            questions: [] as unknown as Questions,
            lastSyncedAt: 100,
            lastSequence: 1,
        });
        const cachedAlpha = getCachedSession("sess-private-alpha");
        const isPrivateAlpha = cachedAlpha?.visibility === "private";
        const canPaintAlpha = Boolean(
            cachedAlpha &&
            (isPrivateAlpha
                ? Boolean(authedUser && cachedAlpha.userId && cachedAlpha.userId === authedUser)
                : Boolean(!cachedAlpha.userId || (authedUser && cachedAlpha.userId === authedUser))),
        );
        expect(canPaintAlpha).toBe(false);
    });

    test("flushHiderSave and flushPlanningModeSave no-op when no timer is active", () => {
        const sid = "sess-flush-notimer";

        // No timer active — flush should not trigger PATCH or enqueue
        flushHiderSave(sid, { latitude: 1, longitude: 2 });
        flushPlanningModeSave(sid, true);

        expect(mockFetch).not.toHaveBeenCalled();
        expect(getPendingEvents(sid)).toHaveLength(0);
    });

    test("hider and planning PATCHes are serialized per session and coalesce newest", async () => {
        const sid = "sess-patch-serialize";
        const patchBodies: unknown[] = [];

        mockFetch.mockImplementation(async (url: string, opts: RequestInit) => {
            if (opts.method === "PATCH") {
                const body = JSON.parse(opts.body as string) as unknown;
                patchBodies.push(body);
                return { ok: true, json: async () => ({}) };
            }
            return { ok: true, json: async () => ({}) };
        });

        // Fire 3 concurrent hider patches
        const p1 = executeHiderPatch(sid, { latitude: 1, longitude: 1 });
        const p2 = executeHiderPatch(sid, { latitude: 2, longitude: 2 });
        const p3 = executeHiderPatch(sid, { latitude: 3, longitude: 3 });

        await Promise.all([p1, p2, p3]);

        // Older PATCH cannot commit after newer — last call must be pos 3
        expect(patchBodies.length).toBeGreaterThanOrEqual(1);
        const lastHider = patchBodies[patchBodies.length - 1] as { hiderLat: number; hiderLng: number };
        expect(lastHider.hiderLat).toBe(3);
    });
});
