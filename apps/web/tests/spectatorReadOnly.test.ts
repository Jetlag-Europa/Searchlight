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

class MockEventSource {
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    readyState = 0;
    close = vi.fn();
    static CLOSED = 2;
    static last: MockEventSource | null = null;
    constructor() {
        MockEventSource.last = this;
    }
}
vi.stubGlobal("EventSource", MockEventSource);
vi.stubGlobal("window", new EventTarget());

// The Undo toast: its content is rendered by hand to press the button.
const toastCalls: Array<{
    render: (props: { closeToast: () => void }) => {
        props: { children: Array<{ props: { onClick: () => void } }> };
    };
}> = [];
vi.mock("react-toastify", () => ({
    toast: Object.assign(
        (render: (typeof toastCalls)[number]["render"]) => {
            toastCalls.push({ render });
            return `toast-${toastCalls.length}`;
        },
        { dismiss: () => {} },
    ),
}));

import { addStroke, strokes } from "@/annotations/hooks/useAnnotationStore";
import {
    deleteStrokeFromServer,
    saveStrokeToServer,
} from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import type { EventRecord, GameSessionSummary } from "@searchlight/shared";
import {
    activeSessionId,
    activeSessionRole,
    sessionReadOnly,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    addQuestion,
    hiderMode,
    planningModeEnabled,
    questions,
} from "@/lib/context";
import { deleteQuestionsWithUndo } from "@/lib/deleteQuestionsWithUndo";
import {
    applyUnsyncedEvents,
    conflictsKey,
    enqueueEvent,
    getCachedSession,
    getPendingEvents,
    setCachedSession,
} from "@/lib/eventQueue";
import { shouldSuppressHiderSave } from "@/lib/hiderSaveSuppress";
import { shouldSuppressPlanningModeSave } from "@/lib/planningModeSaveSuppress";
import { questionConflicts } from "@/lib/questionConflicts";
import {
    becomeSpectator,
    cacheSessionRole,
    discardSessionEdits,
    executeHiderPatch,
    saveHiderModeToServer,
    savePlanningModeToServer,
    saveQuestionsDebounced,
    saveQuestionsToServer,
} from "@/lib/sessionState";
import {
    SESSION_ROLE_CHANGED_EVENT,
    SESSION_STREAM_RECONNECTED_EVENT,
    type SessionRoleChangedDetail,
    type SessionStreamReconnectedDetail,
    startSSE,
    stopSSE,
} from "@/lib/sseManager";
import { flushPendingEvents } from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const SID = "spectated-session";
const OTHER = "played-session";

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

function queueStroke(sessionId: string, clientUuid: string) {
    return enqueueEvent({
        sessionId,
        type: "stroke.create",
        payloadJson: stroke(clientUuid),
        clientUuid: `stroke-create-${clientUuid}`,
        clientCreatedAt: Date.now(),
    });
}

let sequence = 0;
function serverEvent(type: string, payloadJson: unknown) {
    const event: EventRecord = {
        id: `ev-${++sequence}`,
        sequence,
        sessionId: SID,
        userId: "other-user",
        type,
        payloadJson,
        clientUuid: `ev-uuid-${sequence}`,
        clientCreatedAt: "2025-01-01T00:00:00.000Z",
        serverReceivedAt: "2025-01-01T00:00:00.000Z",
    } as EventRecord;
    MockEventSource.last?.onmessage?.({
        data: JSON.stringify(event),
    } as MessageEvent);
}

function spectate(sessionId: string) {
    activeSessionId.set(sessionId);
    activeSessionRole.set("viewer");
}

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    strokes.set([]);
});

afterEach(() => {
    stopSSE();
    sequence = 0;
    toastCalls.length = 0;
    activeSessionRole.set(null);
    activeSessionId.set("");
    verifiedUserId.set(null);
    hiderMode.set(false);
    planningModeEnabled.set(false);
    questions.set([] as Questions);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("sessionReadOnly", () => {
    test("is true only while the active session's role is viewer", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        expect(sessionReadOnly.get()).toBe(false);
        activeSessionRole.set("viewer");
        expect(sessionReadOnly.get()).toBe(true);
        activeSessionRole.set("creator");
        expect(sessionReadOnly.get()).toBe(false);
    });
});

describe("a spectator's edits", () => {
    test("are never queued", () => {
        spectate(SID);
        queueStroke(SID, "s1");
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("of every kind are neither queued nor sent", async () => {
        spectate(SID);
        saveQuestionsDebounced(SID, [] as Questions);
        saveHiderModeToServer(SID, { latitude: 1, longitude: 2 });
        savePlanningModeToServer(SID, true);
        await vi.advanceTimersByTimeAsync(1_000);
        await saveQuestionsToServer(SID, [] as Questions);
        await executeHiderPatch(SID, false);
        await saveStrokeToServer(SID, stroke("s1"));
        await deleteStrokeFromServer(SID, "s1");

        expect(getPendingEvents(SID)).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("don't draw on the board", () => {
        spectate(SID);
        addStroke(stroke("s1"));
        expect(strokes.get()).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("can't add questions", () => {
        spectate(SID);
        expect(() => addQuestion({ id: "radius", data: {} })).toThrow(
            "Spectators can't add questions",
        );
    });

    test("don't stop edits to another session being queued", () => {
        spectate(SID);
        queueStroke(OTHER, "s1");
        expect(getPendingEvents(OTHER)).toHaveLength(1);
    });
});

describe("edits queued before spectating", () => {
    test("aren't flushed", async () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        queueStroke(SID, "s1");
        expect(getPendingEvents(SID)).toHaveLength(1);

        activeSessionRole.set("viewer");
        await flushPendingEvents(SID);

        expect(mockFetch).not.toHaveBeenCalled();
    });

    test("are discarded, so they aren't replayed onto the board", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        queueStroke(SID, "s1");

        spectate(SID);
        discardSessionEdits(SID);

        expect(getPendingEvents(SID)).toEqual([]);
        expect(
            applyUnsyncedEvents(SID, { strokes: [], questions: [] }).strokes,
        ).toEqual([]);
    });

    test("waiting in a debounce are dropped too", async () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        saveQuestionsDebounced(SID, [] as Questions);

        spectate(SID);
        discardSessionEdits(SID);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(getPendingEvents(SID)).toEqual([]);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe("participant.role-changed", () => {
    afterEach(() => stopSSE());

    test("is passed on to the board with the streamed session's id", () => {
        const heard: SessionRoleChangedDetail[] = [];
        const listener = (event: Event) =>
            heard.push((event as CustomEvent<SessionRoleChangedDetail>).detail);
        window.addEventListener(SESSION_ROLE_CHANGED_EVENT, listener);
        startSSE(SID);
        // Live only, so it isn't held back while missed events are fetched.
        MockEventSource.last?.onmessage?.({
            data: JSON.stringify({
                type: "participant.role-changed",
                payloadJson: { userId: "u1", role: "viewer" },
            }),
        } as MessageEvent);
        window.removeEventListener(SESSION_ROLE_CHANGED_EVENT, listener);

        expect(heard).toEqual([
            { sessionId: SID, userId: "u1", role: "viewer" },
        ]);
    });
});

describe("hider and planning updates from the server", () => {
    test("leave a spectator's hidden hider alone, and suppress nothing", () => {
        spectate(SID);
        startSSE(SID);
        serverEvent("hider.update", { hiderLat: null, hiderLng: null });
        serverEvent("hider.update", { hiderLat: null, hiderLng: null });
        expect(hiderMode.get()).toBe(false);

        // Made a player again: their first moves are saved.
        activeSessionRole.set("member");
        expect(shouldSuppressHiderSave({ latitude: 1, longitude: 2 })).toBe(
            false,
        );
        expect(shouldSuppressHiderSave(false)).toBe(false);
    });

    test("that change nothing don't swallow the next move", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        startSSE(SID);
        // The hider is already hidden: the save effect doesn't run.
        serverEvent("hider.update", { hiderLat: null, hiderLng: null });

        const moved = { latitude: 1, longitude: 2 };
        expect(shouldSuppressHiderSave(moved)).toBe(false);
        expect(shouldSuppressHiderSave(false)).toBe(false);
    });

    test("aren't saved back when they change the board", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        startSSE(SID);
        serverEvent("hider.update", { hiderLat: 1, hiderLng: 2 });
        serverEvent("planning.toggle", { planningModeEnabled: true });

        expect(shouldSuppressHiderSave(hiderMode.get())).toBe(true);
        expect(shouldSuppressPlanningModeSave(true)).toBe(true);
        // Only once: the next change is the user's.
        expect(shouldSuppressHiderSave(false)).toBe(false);
        expect(shouldSuppressPlanningModeSave(false)).toBe(false);
    });

    test("that echo planning mode don't swallow the next toggle", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        planningModeEnabled.set(true);
        startSSE(SID);
        serverEvent("planning.toggle", { planningModeEnabled: true });

        expect(shouldSuppressPlanningModeSave(false)).toBe(false);
        expect(shouldSuppressPlanningModeSave(true)).toBe(false);
    });

    test("are forgotten when another session loads", () => {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        hiderMode.set({ latitude: 1, longitude: 2 });
        startSSE(SID);
        serverEvent("hider.update", { hiderLat: null, hiderLng: null });
        serverEvent("planning.toggle", { planningModeEnabled: true });

        // Switching sessions stops the stream before the board changes.
        stopSSE();
        expect(shouldSuppressHiderSave(false)).toBe(false);
        expect(shouldSuppressPlanningModeSave(true)).toBe(false);
    });
});

describe("the stream reconnecting", () => {
    test("is passed on to the board, the first open too", () => {
        const heard: SessionStreamReconnectedDetail[] = [];
        const listener = (event: Event) =>
            heard.push(
                (event as CustomEvent<SessionStreamReconnectedDetail>).detail,
            );
        window.addEventListener(SESSION_STREAM_RECONNECTED_EVENT, listener);
        startSSE(SID);
        MockEventSource.last?.onopen?.(new Event("open"));
        expect(heard).toEqual([{ sessionId: SID }]);

        MockEventSource.last?.onopen?.(new Event("open"));
        window.removeEventListener(SESSION_STREAM_RECONNECTED_EVENT, listener);
        expect(heard).toEqual([{ sessionId: SID }, { sessionId: SID }]);
    });
});

describe("becoming a spectator", () => {
    const USER = "user-1";

    function playWithCache() {
        verifiedUserId.set(USER);
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        setCachedSession({
            sessionId: SID,
            userId: USER,
            role: "member",
            strokes: [stroke("from-server")],
            questions: [],
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        // An edit that hasn't reached the server yet.
        queueStroke(SID, "unsent");
        strokes.set([stroke("from-server"), stroke("unsent")]);
    }

    // The session's details as kept for an offline restore.
    const keptSession = {
        id: SID,
        gameId: "game-1",
        gameName: "Game",
        serverId: "server-1",
        name: "Session",
        visibility: "shared",
        role: "member",
        createdAt: "2025-01-01T00:00:00.000Z",
        hiderLat: 47.37,
        hiderLng: 8.54,
        planningModeEnabled: false,
        gameRevisionId: "rev-1",
        sessionRevision: 1,
        currentRevision: 1,
        hasNewerRevision: false,
    } as GameSessionSummary;

    // A question conflict held for this account to decide.
    const heldConflict = {
        key: 0.5,
        kind: "both-changed",
        mine: { id: "radius", key: 0.5 },
        theirs: { id: "radius", key: 0.5 },
        base: { id: "radius", key: 0.5 },
        baseSequence: 1,
        theirsSequence: 2,
        detectedAt: 0,
    };

    test("makes the board read-only and drops unsent edits", () => {
        playWithCache();
        becomeSpectator(SID);

        expect(sessionReadOnly.get()).toBe(true);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("shows the cached server state, not the dropped edits", () => {
        playWithCache();
        becomeSpectator(SID);

        expect(
            strokes.get().map((feature) => feature.properties.clientUuid),
        ).toEqual(["from-server"]);
    });

    test("is remembered in the cache, so an offline start is read-only", () => {
        playWithCache();
        becomeSpectator(SID);

        expect(getCachedSession(SID)?.role).toBe("viewer");
        expect(getCachedSession(SID)?.strokes).toHaveLength(1);
    });

    test("keeps the session's details for an offline restore without the hider", () => {
        playWithCache();
        setCachedSession({ ...getCachedSession(SID)!, session: keptSession });
        becomeSpectator(SID);

        expect(getCachedSession(SID)?.session).toMatchObject({
            id: SID,
            name: "Session",
            role: "viewer",
            hiderLat: null,
            hiderLng: null,
        });
    });

    test("drops the question conflicts held for a decision, and shows none", () => {
        playWithCache();
        localStorage.setItem(conflictsKey(SID), JSON.stringify([heldConflict]));
        // Shown to a player; the atom follows the account and session.
        activeSessionId.set("");
        activeSessionId.set(SID);
        expect(questionConflicts.get()).toHaveLength(1);

        becomeSpectator(SID);

        expect(localStorage.getItem(conflictsKey(SID))).toBeNull();
        expect(questionConflicts.get()).toEqual([]);
    });

    test("hides conflicts still stored while the board is read-only", () => {
        playWithCache();
        localStorage.setItem(conflictsKey(SID), JSON.stringify([heldConflict]));
        activeSessionRole.set("viewer");
        activeSessionId.set("");
        activeSessionId.set(SID);

        expect(questionConflicts.get()).toEqual([]);
        // Another tab, say, wrote them: still none for the spectator.
        expect(localStorage.getItem(conflictsKey(SID))).not.toBeNull();
    });

    test("doesn't show another account's cached copy", () => {
        playWithCache();
        verifiedUserId.set("someone-else");
        becomeSpectator(SID);

        expect(strokes.get()).toHaveLength(2);
        expect(getPendingEvents(SID)).toEqual([]);
        // Nor marks it as a spectator's: the other account may play.
        expect(getCachedSession(SID)?.role).toBe("member");
    });
});

describe("the cached role", () => {
    test("follows the server's, so a player made one again keeps their offline edits", () => {
        verifiedUserId.set("user-1");
        setCachedSession({
            sessionId: SID,
            userId: "user-1",
            role: "viewer",
            strokes: [stroke("from-server")],
            questions: [],
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        cacheSessionRole(SID, "member");

        expect(getCachedSession(SID)?.role).toBe("member");
        expect(getCachedSession(SID)?.strokes).toHaveLength(1);
    });

    test("is written to the kept session's details too", () => {
        verifiedUserId.set("user-1");
        const session = {
            id: SID,
            gameId: "game-1",
            gameRevisionId: "rev-1",
            name: "Session",
            role: "member",
            hiderLat: 47.37,
            hiderLng: 8.54,
        } as GameSessionSummary;
        setCachedSession({
            sessionId: SID,
            userId: "user-1",
            role: "member",
            session,
            strokes: [],
            questions: [],
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        cacheSessionRole(SID, "viewer");

        expect(getCachedSession(SID)).toMatchObject({
            role: "viewer",
            session: { role: "viewer", hiderLat: null, hiderLng: null },
        });
    });

    test("isn't written to another account's cached copy", () => {
        verifiedUserId.set("account-b");
        setCachedSession({
            sessionId: SID,
            userId: "account-a",
            role: "member",
            strokes: [],
            questions: [],
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        cacheSessionRole(SID, "viewer");

        expect(getCachedSession(SID)?.role).toBe("member");
    });

    test("isn't written for a session with no cached copy", () => {
        cacheSessionRole("not-cached", "member");

        expect(getCachedSession("not-cached")).toBeNull();
    });
});

describe("undoing a delete", () => {
    const question = { key: 1, id: "radius", data: {} };

    function deleteAndGetUndo() {
        activeSessionId.set(SID);
        activeSessionRole.set("member");
        questions.set([question] as unknown as Questions);
        deleteQuestionsWithUndo([1]);
        expect(questions.get()).toEqual([]);
        const closeToast = vi.fn();
        const content = toastCalls.at(-1)!.render({ closeToast });
        const undo = () => content.props.children[1].props.onClick();
        return { undo, closeToast };
    }

    test("puts the question back for a player", () => {
        const { undo, closeToast } = deleteAndGetUndo();
        undo();
        expect(questions.get()).toEqual([question]);
        expect(closeToast).toHaveBeenCalled();
    });

    test("does nothing once its user only spectates", () => {
        const { undo, closeToast } = deleteAndGetUndo();
        activeSessionRole.set("viewer");
        undo();
        expect(questions.get()).toEqual([]);
        expect(closeToast).toHaveBeenCalled();
    });
});
