import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { activeSessionId, verifiedUserId } from "@/lib/activeSession";
import { hiderMode, questions } from "@/lib/context";
import type { StrokeFeature } from "@/annotations/types";
import type { Questions } from "@/maps/schema";
import {
    saveQuestionsDebounced,
    saveHiderModeToServer,
    flushQuestionSave,
    flushSavesOnPageExit,
    hasPendingQuestionSave,
    loadSessionContent,
} from "@/lib/sessionState";
import {
    enqueueEvent,
    getPendingEvents,
    setCachedSession,
    getCachedSession,
    applyPendingEventsToState,
} from "@/lib/eventQueue";

import { flushPendingEvents } from "@/lib/syncManager";
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

const mockStroke: StrokeFeature = {
    type: "Feature",
    geometry: {
        type: "LineString",
        coordinates: [
            [0, 0],
            [1, 1],
        ],
    },
    properties: {
        tool: "pen",
        color: "#000",
        widthMeters: 3,
        createdAt: 0,
        clientUuid: "s-1",
    },
};
beforeEach(() => {
    vi.stubGlobal("localStorage", mockStorage(store));
    store.clear();
    strokes.set([]);
    questions.set([]);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("session switch & sync edge cases", () => {
    it("canceled debounce edit: flushQuestionSave durably flushes outgoing edits before switch", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ ok: true }), { status: 200 }),
            );
        vi.stubGlobal("fetch", fetchMock);

        const newQs = [
            { id: "q-edited", title: "Edited Question" },
        ] as unknown as Questions;
        saveQuestionsDebounced("session-out", newQs);

        expect(hasPendingQuestionSave("session-out")).toBe(true);
        await flushQuestionSave("session-out");

        expect(hasPendingQuestionSave("session-out")).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/sessions/session-out/questions"),
            expect.objectContaining({ method: "PUT" }),
        );
    });

    it("switch flush queues the outgoing edit without keepalive or waiting on the network", () => {
        // Never settles: a slow network must not hold up the switch.
        const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
        vi.stubGlobal("fetch", fetchMock);
        const bigQuestion = { id: "q-big", notes: "x".repeat(70 * 1024) };
        saveQuestionsDebounced("session-out", [
            bigQuestion,
        ] as unknown as Questions);

        void flushQuestionSave("session-out");

        // Durable before any network work, so nothing is lost if it fails.
        expect(getPendingEvents("session-out")).toHaveLength(1);
        // Keepalive bodies are capped at 64 KiB and would be rejected.
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/sessions/session-out/questions"),
            expect.objectContaining({ method: "PUT", keepalive: false }),
        );
    });

    it("unload flush sends a question list over the keepalive cap without keepalive", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const bigQuestion = { id: "q-big", notes: "x".repeat(70 * 1024) };
        saveQuestionsDebounced("session-big", [
            bigQuestion,
        ] as unknown as Questions);

        await flushQuestionSave("session-big", true);

        // A keepalive request this large is rejected outright.
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/sessions/session-big/questions"),
            expect.objectContaining({ method: "PUT", keepalive: false }),
        );
        expect(getPendingEvents("session-big")).toEqual([]);
    });

    it("selection pending replay: replays pending events when session is loaded offline", async () => {
        // Cached snapshot with base stroke
        const baseStroke = {
            ...mockStroke,
            properties: { ...mockStroke.properties, clientUuid: "base-stroke" },
        };
        setCachedSession({
            sessionId: "session-sel",
            strokes: [baseStroke],
            questions: [] as unknown as Questions,
            lastSyncedAt: 1000,
            lastSequence: 0,
        });

        // User drew offline stroke while disconnected
        const offlineStroke = {
            ...mockStroke,
            properties: {
                ...mockStroke.properties,
                clientUuid: "offline-stroke",
            },
        };
        enqueueEvent({
            sessionId: "session-sel",
            type: "stroke.create",
            payloadJson: offlineStroke,
            clientUuid: "offline-stroke",
            clientCreatedAt: 1005,
        });

        // Server is offline (fetch fails)
        vi.stubGlobal(
            "fetch",
            vi.fn().mockRejectedValue(new Error("Network offline")),
        );

        // Authoritative load fails
        let loadFailed = false;
        try {
            await loadSessionContent("session-sel", "verified-user");
        } catch {
            loadFailed = true;
        }
        expect(loadFailed).toBe(true);

        // Selection fallback replays pending events on top of cached snapshot
        const cached = getCachedSession("session-sel");
        expect(cached).not.toBeNull();
        const pending = getPendingEvents("session-sel").filter(
            (e) => e.status === "pending",
        );
        const derived = applyPendingEventsToState(
            { strokes: cached!.strokes, questions: cached!.questions },
            pending,
        );

        expect(derived.strokes.map((s) => s.properties.clientUuid)).toEqual([
            "base-stroke",
            "offline-stroke",
        ]);
    });

    it("server cursor fetched before content snapshot and stored in cache without client clock", async () => {
        const serverCursorSeq = 42;
        const callOrder: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.endsWith("/events/cursor")) {
                    callOrder.push("cursor");
                    return new Response(
                        JSON.stringify({ sequence: serverCursorSeq }),
                        { status: 200 },
                    );
                }
                if (url.endsWith("/strokes")) {
                    callOrder.push("strokes");
                    return new Response(JSON.stringify({ strokes: [] }), {
                        status: 200,
                    });
                }
                if (url.endsWith("/questions")) {
                    callOrder.push("questions");
                    return new Response(JSON.stringify({ questions: [] }), {
                        status: 200,
                    });
                }
                if (url.endsWith("/sessions/test-cursor-session")) {
                    callOrder.push("session");
                    return Response.json({
                        id: "test-cursor-session",
                        hiderLat: 1,
                        hiderLng: 2,
                        planningModeEnabled: true,
                    });
                }
                return new Response(JSON.stringify({}), { status: 404 });
            }),
        );

        const loaded = await loadSessionContent(
            "test-cursor-session",
            "verified-user",
        );

        // Cursor was fetched first
        expect(callOrder[0]).toBe("cursor");
        expect(loaded.cursor).toBe(serverCursorSeq);

        // Cache contains server cursor, NOT client wall-clock
        const cached = getCachedSession("test-cursor-session");
        expect(cached?.lastSequence).toBe(serverCursorSeq);
        expect(cached?.userId).toBe("verified-user");
    });

    it("restores flushed hider and planning metadata at the replay cursor", async () => {
        const sessionId = "metadata-recovery";
        const server = {
            id: sessionId,
            hiderLat: null as number | null,
            hiderLng: null as number | null,
            planningModeEnabled: false,
        };
        let sequence = 0;
        vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
            if (options?.method === "PATCH") {
                Object.assign(server, JSON.parse(options.body as string));
                sequence++;
                return Response.json(server);
            }
            if (url.endsWith("/events/cursor")) return Response.json({ sequence });
            if (url.endsWith("/questions")) return Response.json({ questions: [] });
            if (url.endsWith("/strokes")) return Response.json({ strokes: [] });
            return Response.json(server);
        }));
        enqueueEvent({
            sessionId,
            type: "hider.update",
            payloadJson: { hiderLat: 50.85, hiderLng: 4.35 },
            clientUuid: "offline-location",
            clientCreatedAt: 1,
        });
        enqueueEvent({
            sessionId,
            type: "planning.toggle",
            payloadJson: { planningModeEnabled: true },
            clientUuid: "offline-planning",
            clientCreatedAt: 2,
        });

        await flushPendingEvents(sessionId);
        const restored = await loadSessionContent(sessionId, "verified-user");

        expect(restored.cursor).toBe(2);
        expect(restored.session).toMatchObject({
            hiderLat: 50.85,
            hiderLng: 4.35,
            planningModeEnabled: true,
        });
        expect(getPendingEvents(sessionId)).toEqual([]);
    });
});

describe("page exit flush", () => {
    const sessionId = "session-exit";
    const page = Object.assign(new EventTarget(), {
        visibilityState: "visible" as DocumentVisibilityState,
    });
    let stopFlushing: () => void;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("document", page);
        fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        page.visibilityState = "visible";
        activeSessionId.set(sessionId);
        verifiedUserId.set("user-1");
        stopFlushing = flushSavesOnPageExit();
    });

    afterEach(() => {
        stopFlushing();
        activeSessionId.set("");
        verifiedUserId.set(null);
        hiderMode.set(false);
    });

    function editBeforeDebounce() {
        saveQuestionsDebounced(sessionId, [{ id: "q-1" }] as unknown as Questions);
        const location = { latitude: 1, longitude: 2 };
        hiderMode.set(location);
        saveHiderModeToServer(sessionId, location);
    }

    it("queues and sends debounced edits with keepalive on pagehide", async () => {
        editBeforeDebounce();

        window.dispatchEvent(new Event("pagehide"));

        expect(getPendingEvents(sessionId).map((e) => e.type)).toEqual([
            "questions.replace",
            "hider.update",
        ]);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        for (const [, options] of fetchMock.mock.calls) {
            expect(options).toMatchObject({ keepalive: true });
        }
    });

    it("queues debounced edits when the tab is hidden, not when it is shown", () => {
        editBeforeDebounce();

        document.dispatchEvent(new Event("visibilitychange"));
        expect(getPendingEvents(sessionId)).toEqual([]);

        page.visibilityState = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
        expect(getPendingEvents(sessionId)).toHaveLength(2);
        expect(hasPendingQuestionSave(sessionId)).toBe(true);
    });
});
