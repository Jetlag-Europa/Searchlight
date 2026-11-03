import type { GameSessionSummary, SessionRole } from "@searchlight/shared";

import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import {
    activeSessionId,
    activeSessionRole,
    editingInOtherTab,
    isSessionReadOnly,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    gameDefinitionReady,
    hiderMode,
    pendingEventCount,
    planningModeEnabled,
    questions,
    syncStatus,
} from "@/lib/context";
import {
    type CachedSessionState,
    discardPendingEvents,
    enqueueEvent,
    getCachedSession,
    getPendingEvents,
    isSessionSummary,
    type PendingEvent,
    questionsBase,
    queuedQuestionsBase,
    setCachedSession,
} from "@/lib/eventQueue";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import { sayStorageFull } from "@/lib/storageFull";
import {
    latestSavedQuestionsSequence,
    sendPendingEvent,
} from "@/lib/syncManager";
import { randomUUID } from "@/lib/utils";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function refreshSyncCounts(sessionId: string): void {
    const count = getPendingEvents(sessionId).length;
    pendingEventCount.set(count);
    if (count === 0) syncStatus.set("synced");
}

/**
 * Queue an edit durably. Storage too full for it even after dropping the
 * copies kept of other sessions (see writePendingQueue) throws: the player
 * is told, and a debounced edit waits in memory (see debounceSave) for
 * Retry, the next edit or the page closing to queue it.
 */
function queueEdit(event: Parameters<typeof enqueueEvent>[0]): PendingEvent {
    const { sessionId } = event;
    let queued: PendingEvent;
    try {
        queued = enqueueEvent(event);
    } catch (err) {
        // Retry is done once nothing waits to be queued. A board that can't
        // save it (another tab took the session over) keeps waiting.
        sayStorageFull(() => {
            if (sessionId !== activeSessionId.get()) return true;
            if (isSessionReadOnly(sessionId)) return false;
            flushSessionSaves(sessionId);
            return ![questionSaves, hiderSaves, planningSaves].some((state) =>
                state.pending.has(sessionId),
            );
        });
        throw err;
    }
    refreshSyncCounts(sessionId);
    return queued;
}

// ── Questions ────────────────────────────────────────────────────────────────

// The list, and the sequence it is as of (an API from before sends none).
async function fetchQuestions(
    sessionId: string,
    signal?: AbortSignal,
): Promise<{ questions: Questions; sequence?: number }> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
        signal,
    });
    if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`);
    const data = (await res.json()) as {
        questions: Array<{
            clientUuid: string;
            ordinal: number;
            payloadJson: unknown;
        } | null>;
        sequence?: unknown;
    };
    return {
        // An entry that isn't one can't be read, as for strokes.
        questions: data.questions.flatMap((q) =>
            q && typeof q === "object" ? [q.payloadJson] : [],
        ) as unknown as Questions,
        sequence: typeof data.sequence === "number" ? data.sequence : undefined,
    };
}

interface SaveState {
    timers: Map<string, ReturnType<typeof setTimeout>>;
    // The edit not queued yet: in its debounce, or with no room to be.
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
    // A spectator's edits are never saved.
    if (isSessionReadOnly(sessionId)) return;
    // Keep rapid gameplay edits cheap. Persist the final snapshot when the
    // debounce fires (or unload flushes), before waiting for any network work.
    state.pending.set(sessionId, createEvent);
    state.timers.set(
        sessionId,
        setTimeout(() => {
            state.timers.delete(sessionId);
            let event: PendingEvent;
            try {
                event = createEvent();
            } catch (err) {
                // Still pending, said by queueEdit.
                console.warn("[sessionState] couldn't queue the edit:", err);
                return;
            }
            dispatchSave(state, event).catch((err) => {
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
    if (!sessionId) return state.pending.size > 0 || state.dispatches.size > 0;
    return (
        state.pending.has(sessionId) ||
        state.dispatches.has(sessionId) ||
        getPendingEvents(sessionId).some((event) => event.type === type)
    );
}

function queueQuestions(sessionId: string, qs: Questions): PendingEvent {
    const replacementId = randomUUID();
    // What the board's questions were made from.
    const base = questionsBase(sessionId);
    return queueEdit({
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

/**
 * An edit hasn't been queued yet: it waits in the debounce, or for room in
 * storage (see queueEdit). The board shows it, so lists from elsewhere wait.
 */
export function hasScheduledQuestionSave(sessionId: string): boolean {
    return questionSaves.pending.has(sessionId);
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
    return queueEdit({
        sessionId,
        type: "hider.update",
        payloadJson:
            mode === false
                ? { hiderLat: null, hiderLng: null }
                : { hiderLat: mode.latitude, hiderLng: mode.longitude },
        clientUuid: `hider-update-${randomUUID()}`,
        clientCreatedAt: Date.now(),
    });
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
    return queueEdit({
        sessionId,
        type: "planning.toggle",
        payloadJson: { planningModeEnabled: enabled },
        clientUuid: `planning-toggle-${randomUUID()}`,
        clientCreatedAt: Date.now(),
    });
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

// ── Read-only sessions ───────────────────────────────────────────────────────

/**
 * Forget every edit to a session this browser hasn't sent yet, debounced or
 * queued, for a user who only spectates it now: they can never be delivered.
 */
export function discardSessionEdits(sessionId: string): void {
    cancelSave(questionSaves, sessionId);
    cancelSave(hiderSaves, sessionId);
    cancelSave(planningSaves, sessionId);
    discardPendingEvents(sessionId);
    if (sessionId === activeSessionId.get()) pendingEventCount.set(0);
}

// The cached copy's role, kept in step with the server's: an offline start
// shows the board for the role the user has now, and doesn't drop a player's
// unsent edits for a role they no longer have.
export function cacheSessionRole(sessionId: string, role: SessionRole): void {
    const cached = getCachedSession(sessionId);
    if (!cached || !isOwnCopy(cached)) return;
    const next = cachedForRole(cached, role);
    if (JSON.stringify(next) !== JSON.stringify(cached)) setCachedSession(next);
}

// Whether the cached copy is this account's: another account on the same
// browser may have a different role in the session, and edits of its own.
function isOwnCopy(cached: CachedSessionState): boolean {
    const account = verifiedUserId.get() ?? offlineUserId.get();
    return account !== null && cached.userId === account;
}

// The cached copy for a user with `role`. The session details kept for an
// offline restore carry the role too, and a spectator's no hider position.
function cachedForRole(
    cached: CachedSessionState,
    role: SessionRole,
): CachedSessionState {
    if (!cached.session) return { ...cached, role };
    const session: GameSessionSummary = { ...cached.session, role };
    if (role === "viewer") {
        session.hiderLat = null;
        session.hiderLng = null;
    }
    return { ...cached, role, session };
}

/**
 * This user only spectates `sessionId` now. Takes effect right away, before
 * the session loads again: its unsent edits are dropped, the cached copy
 * says so (an offline start shows it read-only), and the active board shows
 * that copy instead of the dropped edits until the server's state arrives.
 */
export function becomeSpectator(sessionId: string): void {
    const active = sessionId === activeSessionId.get();
    if (active) activeSessionRole.set("viewer");
    discardSessionEdits(sessionId);
    const cached = getCachedSession(sessionId);
    // Another account's copy is neither changed nor shown.
    if (!cached || !isOwnCopy(cached)) return;
    setCachedSession(cachedForRole(cached, "viewer"));
    if (!active) return;
    strokes.set(cached.strokes);
    questions.set(
        suppressQuestionSave(
            filterSupportedQuestions(
                cached.questions,
                gameDefinitionReady.get() ? compiledGameAtom.get() : null,
            ),
        ),
    );
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
 * event. A window losing focus may be followed by another tab of this
 * browser taking the session over (see editSessionHere), which shows only
 * what was queued. Returns a function that removes the listeners.
 */
export function flushSavesOnPageExit(): () => void {
    // keepalive only when the page may be going away.
    const flush = (keepalive: boolean) => {
        const id = activeSessionId.get();
        // Edits made offline too: the page is often closed before it's back.
        if (!id || !(verifiedUserId.get() ?? offlineUserId.get())) return;
        console.info("[sessionState] flushing saves for", id);
        flushSessionSaves(id, keepalive);
    };
    const flushOnExit = () => flush(true);
    const flushIfHidden = () => {
        if (document.visibilityState === "hidden") flush(true);
    };
    const flushOnBlur = () => flush(false);
    window.addEventListener("beforeunload", flushOnExit);
    window.addEventListener("pagehide", flushOnExit);
    window.addEventListener("blur", flushOnBlur);
    document.addEventListener("visibilitychange", flushIfHidden);
    return () => {
        window.removeEventListener("beforeunload", flushOnExit);
        window.removeEventListener("pagehide", flushOnExit);
        window.removeEventListener("blur", flushOnBlur);
        document.removeEventListener("visibilitychange", flushIfHidden);
    };
}
// ── Session load ─────────────────────────────────────────────────────────────

export async function fetchServerCursor(
    sessionId: string,
    signal?: AbortSignal,
): Promise<number> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/events/cursor`, {
        credentials: "include",
        signal,
    });
    if (!res.ok) throw new Error(`Failed to fetch cursor: ${res.status}`);
    const data = (await res.json()) as { sequence?: number };
    if (typeof data.sequence !== "number")
        throw new Error("Invalid cursor response: missing sequence");
    return data.sequence;
}

/**
 * Read the session's state from the server and keep it as this browser's
 * copy. Aborting `signal` stops the reads, so nothing is kept.
 */
export async function loadSessionContent(
    sessionId: string,
    userId: string,
    signal?: AbortSignal,
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
        serverCursor = await fetchServerCursor(sessionId, signal);
    } catch (err) {
        console.warn(
            "[sessionState] failed to fetch server cursor, defaulting to 0:",
            err,
        );
    }

    const [loadedStrokes, loaded, session] = await Promise.all([
        loadStrokesFromServer(sessionId, signal),
        fetchQuestions(sessionId, signal),
        fetch(`${API_BASE}/sessions/${sessionId}`, {
            credentials: "include",
            signal,
        }).then(async (res) => {
            if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
            const details: unknown = await res.json();
            // Kept and activated: anything else would leave the board on no
            // session.
            if (!isSessionSummary(details, sessionId)) {
                throw new Error("Failed to load session: unreadable details");
            }
            return details;
        }),
    ]);

    // A save of ours (a retry) can land while the list is on its way: then
    // the list is older than what we saved, and showing it would undo it.
    // Read it again (a few times at most).
    let loadedList = loaded;
    for (let i = 0; i < 3; i++) {
        const saved = latestSavedQuestionsSequence(sessionId);
        const at = loadedList.sequence ?? serverCursor;
        if (saved === undefined || saved <= at) break;
        loadedList = await fetchQuestions(sessionId, signal);
    }
    const loadedQuestions = loadedList.questions;
    // Taken over meanwhile: the copy is the other tab's, and older than its.
    if (editingInOtherTab.get()) throw new Error("another tab took the session over");
    setCachedSession({
        sessionId,
        userId,
        role: session.role,
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
        questionsSequence: loadedList.sequence,
    };
}
