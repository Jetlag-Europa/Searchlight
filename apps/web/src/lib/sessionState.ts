import type { GameSessionSummary } from "@searchlight/shared";

import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    activeSessionId,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    hiderMode,
    pendingEventCount,
    planningModeEnabled,
    syncStatus,
} from "@/lib/context";
import {
    enqueueEvent,
    getPendingEvents,
    type PendingEvent,
    questionsBase,
    queuedQuestionsBase,
    setCachedSession,
} from "@/lib/eventQueue";
import { sendPendingEvent } from "@/lib/syncManager";
import { randomUUID } from "@/lib/utils";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function refreshSyncCounts(sessionId: string): void {
    const count = getPendingEvents(sessionId).filter(
        (e) => e.status === "pending" || e.status === "failed",
    ).length;
    pendingEventCount.set(count);
    if (count === 0) syncStatus.set("synced");
}

// ── Questions ────────────────────────────────────────────────────────────────

// The list, and the sequence it is as of (an API from before sends none).
async function fetchQuestions(
    sessionId: string,
): Promise<{ questions: Questions; sequence?: number }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`);
    const data = (await res.json()) as {
        questions: Array<{
            clientUuid: string;
            ordinal: number;
            payloadJson: unknown;
        }>;
        sequence?: unknown;
    };
    return {
        questions: data.questions.map((q) => q.payloadJson) as unknown as Questions,
        sequence: typeof data.sequence === "number" ? data.sequence : undefined,
    };
}

export async function loadQuestionsFromServer(
    sessionId: string,
): Promise<Questions> {
    return (await fetchQuestions(sessionId)).questions;
}

interface SaveState {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    pending: Map<string, () => PendingEvent>;
    dispatches: Map<string, Promise<void>>;
}

const questionSaves: SaveState = {
    timers: new Map(),
    pending: new Map(),
    dispatches: new Map(),
};
const hiderSaves: SaveState = {
    timers: new Map(),
    pending: new Map(),
    dispatches: new Map(),
};
const planningSaves: SaveState = {
    timers: new Map(),
    pending: new Map(),
    dispatches: new Map(),
};

function cancelSave(state: SaveState, sessionId?: string): void {
    if (sessionId) {
        clearTimeout(state.timers.get(sessionId));
        state.timers.delete(sessionId);
        state.pending.delete(sessionId);
    } else {
        for (const timer of state.timers.values()) clearTimeout(timer);
        state.timers.clear();
        state.pending.clear();
    }
    // Cancel scheduling, not durable edits: reconnect must still replay them.
}

function dispatchSave(
    state: SaveState,
    event: PendingEvent,
    keepalive = false,
): Promise<void> {
    cancelSave(state, event.sessionId);
    const result = sendPendingEvent(event, keepalive);
    state.dispatches.set(event.sessionId, result);
    const cleanup = () => {
        if (state.dispatches.get(event.sessionId) === result) {
            state.dispatches.delete(event.sessionId);
        }
    };
    void result.then(cleanup, cleanup);
    return result;
}

function debounceSave(
    state: SaveState,
    sessionId: string,
    createEvent: () => PendingEvent,
    delay: number,
): void {
    cancelSave(state, sessionId);
    // Keep rapid gameplay edits cheap. Persist the final snapshot when the
    // debounce fires (or unload flushes), before waiting for any network work.
    state.pending.set(sessionId, createEvent);
    state.timers.set(
        sessionId,
        setTimeout(() => {
            dispatchSave(state, createEvent()).catch((err) => {
                console.warn("[sessionState] failed to save:", err);
            });
        }, delay),
    );
}

function hasPendingSave(
    state: SaveState,
    type: PendingEvent["type"],
    sessionId?: string,
): boolean {
    if (!sessionId) return state.timers.size > 0 || state.dispatches.size > 0;
    return (
        state.timers.has(sessionId) ||
        state.dispatches.has(sessionId) ||
        getPendingEvents(sessionId).some(
            (event) => event.type === type && event.status !== "synced",
        )
    );
}

function queueQuestions(sessionId: string, qs: Questions): PendingEvent {
    const replacementId = randomUUID();
    // What the board's questions were made from.
    const base = questionsBase(sessionId);
    const event = enqueueEvent({
        sessionId,
        type: "questions.replace",
        payloadJson: {
            replacementId,
            questions: qs.map((question, ordinal) => ({
                clientUuid: randomUUID(),
                ordinal,
                payloadJson: question,
            })),
            ...(base ? { base } : {}),
        },
        clientUuid: `questions-replace-${replacementId}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);
    return event;
}

export async function saveQuestionsToServer(
    sessionId: string,
    qs: Questions,
): Promise<void> {
    await dispatchSave(questionSaves, queueQuestions(sessionId, qs));
}

export function hasPendingQuestionSave(sessionId?: string): boolean {
    return hasPendingSave(questionSaves, "questions.replace", sessionId);
}

/** An edit is waiting in the debounce and hasn't been queued yet. */
export function hasScheduledQuestionSave(sessionId: string): boolean {
    return questionSaves.timers.has(sessionId);
}

export function cancelPendingQuestionSave(sessionId?: string): void {
    cancelSave(questionSaves, sessionId);
}

// Flushing queues the pending snapshot durably before returning. Pass
// keepalive only when the page is going away: keepalive bodies are capped at
// 64 KiB, which a large question list exceeds.
export async function flushQuestionSave(
    sessionId?: string,
    keepalive = false,
): Promise<void> {
    const targetSessionId = sessionId ?? activeSessionId.get();
    if (!targetSessionId) return;
    const pending = questionSaves.pending.get(targetSessionId);
    if (pending) {
        await dispatchSave(questionSaves, pending(), keepalive);
    } else {
        await questionSaves.dispatches.get(targetSessionId);
    }
}

export function saveQuestionsDebounced(sessionId: string, qs: Questions): void {
    debounceSave(questionSaves, sessionId, () => queueQuestions(sessionId, qs), 500);
}

type HiderModeValue = false | { latitude: number; longitude: number };

function queueHiderMode(sessionId: string, mode: HiderModeValue): PendingEvent {
    const event = enqueueEvent({
        sessionId,
        type: "hider.update",
        payloadJson:
            mode === false
                ? { hiderLat: null, hiderLng: null }
                : { hiderLat: mode.latitude, hiderLng: mode.longitude },
        clientUuid: `hider-update-${randomUUID()}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);
    return event;
}

export function hasPendingHiderSave(sessionId?: string): boolean {
    return hasPendingSave(hiderSaves, "hider.update", sessionId);
}

export function cancelPendingHiderSave(sessionId?: string): void {
    cancelSave(hiderSaves, sessionId);
}

export function saveHiderModeToServer(
    sessionId: string,
    mode: HiderModeValue,
): void {
    debounceSave(hiderSaves, sessionId, () => queueHiderMode(sessionId, mode), 800);
}

export async function executeHiderPatch(
    sessionId: string,
    mode: HiderModeValue,
    keepalive = false,
): Promise<void> {
    await dispatchSave(hiderSaves, queueHiderMode(sessionId, mode), keepalive);
}

export function flushHiderSave(
    sessionId: string,
    mode: HiderModeValue,
    keepalive = false,
): void {
    if (!hiderSaves.pending.has(sessionId)) return;
    executeHiderPatch(sessionId, mode, keepalive).catch((err) => {
        console.warn("[sessionState] failed to flush hider mode save:", err);
    });
}

// ── Planning mode ─────────────────────────────────────────────────────────────

function queuePlanningMode(sessionId: string, enabled: boolean): PendingEvent {
    const event = enqueueEvent({
        sessionId,
        type: "planning.toggle",
        payloadJson: { planningModeEnabled: enabled },
        clientUuid: `planning-toggle-${randomUUID()}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);
    return event;
}

export function hasPendingPlanningModeSave(sessionId?: string): boolean {
    return hasPendingSave(planningSaves, "planning.toggle", sessionId);
}

export function cancelPendingPlanningModeSave(sessionId?: string): void {
    cancelSave(planningSaves, sessionId);
}

export function savePlanningModeToServer(
    sessionId: string,
    enabled: boolean,
): void {
    debounceSave(planningSaves, sessionId, () => queuePlanningMode(sessionId, enabled), 300);
}

export async function executePlanningPatch(
    sessionId: string,
    enabled: boolean,
    keepalive = false,
): Promise<void> {
    await dispatchSave(planningSaves, queuePlanningMode(sessionId, enabled), keepalive);
}

export function flushPlanningModeSave(
    sessionId: string,
    enabled: boolean,
    keepalive = false,
): void {
    if (!planningSaves.pending.has(sessionId)) return;
    executePlanningPatch(sessionId, enabled, keepalive).catch((err) => {
        console.warn("[sessionState] failed to flush planning mode save:", err);
    });
}

// ── Flushing ─────────────────────────────────────────────────────────────────

/**
 * Queue a session's debounced edits durably right away and start sending
 * them, without waiting for the network.
 */
export function flushSessionSaves(sessionId: string, keepalive = false): void {
    flushQuestionSave(sessionId, keepalive).catch((err) => {
        console.warn("[sessionState] failed to flush question save:", err);
    });
    flushHiderSave(sessionId, hiderMode.get(), keepalive);
    flushPlanningModeSave(sessionId, planningModeEnabled.get(), keepalive);
}

/**
 * Debounced edits live only in memory until their timer fires, so flush them
 * whenever the page may be going away. Mobile browsers often skip
 * beforeunload, and a hidden tab can be frozen or discarded without another
 * event. Returns a function that removes the listeners.
 */
export function flushSavesOnPageExit(): () => void {
    const flush = () => {
        const id = activeSessionId.get();
        // Edits made offline too: the page is often closed before it's back.
        if (!id || !(verifiedUserId.get() ?? offlineUserId.get())) return;
        console.info("[sessionState] page may be closing — flushing saves for", id);
        flushSessionSaves(id, true);
    };
    const flushIfHidden = () => {
        if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
        window.removeEventListener("beforeunload", flush);
        window.removeEventListener("pagehide", flush);
        document.removeEventListener("visibilitychange", flushIfHidden);
    };
}
// ── Session load ─────────────────────────────────────────────────────────────

export async function fetchServerCursor(sessionId: string): Promise<number> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/events/cursor`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to fetch cursor: ${res.status}`);
    const data = (await res.json()) as { sequence?: number };
    if (typeof data.sequence !== "number")
        throw new Error("Invalid cursor response: missing sequence");
    return data.sequence;
}

export async function loadSessionContent(
    sessionId: string,
    userId: string,
): Promise<{
    strokes: StrokeFeature[];
    session: GameSessionSummary;
    questions: Questions;
    cursor?: number;
    // The sequence the questions are as of, where the API tells.
    questionsSequence?: number;
}> {
    let serverCursor = 0;
    try {
        serverCursor = await fetchServerCursor(sessionId);
    } catch (err) {
        console.warn(
            "[sessionState] failed to fetch server cursor, defaulting to 0:",
            err,
        );
    }

    const [loadedStrokes, loaded, session] = await Promise.all([
        loadStrokesFromServer(sessionId),
        fetchQuestions(sessionId),
        fetch(`${API_BASE}/sessions/${sessionId}`, {
            credentials: "include",
        }).then(async (res) => {
            if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
            return (await res.json()) as GameSessionSummary;
        }),
    ]);

    const loadedQuestions = loaded.questions;
    setCachedSession({
        sessionId,
        userId,
        session,
        strokes: loadedStrokes,
        questions: loadedQuestions,
        // The board shows the loaded list, or the list still queued on top of
        // it, made from that list's base. The cursor was read first: it
        // never claims more than the list has.
        serverQuestions: queuedQuestionsBase(sessionId) ?? {
            sequence: serverCursor,
            questions: loadedQuestions,
        },
        lastSyncedAt: Date.now(),
        lastSequence: serverCursor,
    });

    return {
        strokes: loadedStrokes,
        session,
        questions: loadedQuestions,
        cursor: serverCursor,
        questionsSequence: loaded.sequence,
    };
}
