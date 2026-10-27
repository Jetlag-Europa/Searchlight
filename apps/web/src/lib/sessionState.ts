import type { GameSessionSummary } from "@searchlight/shared";

import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId, verifiedUserId } from "@/lib/activeSession";
import {
    disabledStations,
    hiderMode,
    pendingEventCount,
    planningModeEnabled,
    syncStatus,
} from "@/lib/context";
import {
    applyZonesDelta,
    diffZoneIds,
    forgetLegacyDisabledZones,
    isNoZonesChange,
    legacyDisabledZones,
    sameZoneIds,
    type ZonesDelta,
    zonesDeltaOf,
} from "@/lib/disabledZones";
import {
    enqueueEvent,
    getPendingEvents,
    markEventSynced,
    type PendingEvent,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    flushPendingEvents,
    onEventRejected,
    onEventSynced,
    sendPendingEvent,
} from "@/lib/syncManager";
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

export async function loadQuestionsFromServer(
    sessionId: string,
): Promise<Questions> {
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
    };
    return data.questions.map((q) => q.payloadJson) as unknown as Questions;
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

// ── Disabled zones ───────────────────────────────────────────────────────────

// The board shows the server's list (the base) with this device's changes
// the base doesn't show yet applied on top, oldest first:
// - acknowledged: saved, but the reply beat the SSE echo. Kept until the echo
//   arrives, so the board doesn't flicker back in between. Every saved
//   change has one: the server records a change with an ID even when it
//   changed nothing.
// - queued: in the event queue, so they show after a reload too.
// - scheduled: the edit waiting out the debounce.
// The base follows the server (session loads and every zones.disabled event):
// other players' edits show while ours are on their way, and our own echo
// changes nothing.
let zonesBase: { sessionId: string; ids: string[] } | null = null;
// For zonesBase's session.
let acknowledgedZones: Array<{ clientUuid: string; delta: ZonesDelta }> = [];
const zonesTimers = new Map<string, ReturnType<typeof setTimeout>>();
const scheduledZones = new Map<string, ZonesDelta>();

function isUnsyncedZonesEvent(event: PendingEvent): boolean {
    return event.type === "zones.disabled" && event.status !== "synced";
}

/** The server's disabled zones for a session, as last heard, if known. */
export function getDisabledZonesBase(sessionId: string): string[] | undefined {
    return zonesBase?.sessionId === sessionId ? zonesBase.ids : undefined;
}

// The base with the changes already sent or queued: the board without the
// edit waiting in the debounce.
function savedDisabledZones(sessionId: string): string[] {
    const acknowledged =
        zonesBase?.sessionId === sessionId
            ? acknowledgedZones.map((entry) => entry.delta)
            : [];
    const queued = getPendingEvents(sessionId)
        .filter(isUnsyncedZonesEvent)
        .map((event) => zonesDeltaOf(event.payloadJson));
    return [...acknowledged, ...queued].reduce(
        applyZonesDelta,
        getDisabledZonesBase(sessionId) ?? [],
    );
}

/** Show a session's disabled zones: the base with our changes on top. */
export function showDisabledZones(sessionId: string): void {
    const saved = savedDisabledZones(sessionId);
    const scheduled = scheduledZones.get(sessionId);
    const ids = scheduled ? applyZonesDelta(saved, scheduled) : saved;
    // Keep the array (and the zone layers) when nothing changed.
    if (!sameZoneIds(disabledStations.get(), ids)) disabledStations.set(ids);
}

function showDisabledZonesIfOnBoard(sessionId: string): void {
    if (zonesBase?.sessionId === sessionId) showDisabledZones(sessionId);
}

/**
 * Show a session's disabled zones from a fresh session load. Every change
 * acknowledged before is in it.
 */
export function setDisabledZonesBase(sessionId: string, ids: string[]): void {
    zonesBase = { sessionId, ids: [...ids] };
    acknowledgedZones = [];
    showDisabledZones(sessionId);
}

/**
 * A zones.disabled event: the whole list after a change, ours or another
 * player's. Events arrive in sequence order (see sseManager).
 */
export function applyDisabledZonesEvent(
    sessionId: string,
    ids: string[],
    clientUuid: string,
): void {
    // Our own change came back (perhaps before its reply): it's in the base.
    const own = getPendingEvents(sessionId).find(
        (event) => isUnsyncedZonesEvent(event) && event.clientUuid === clientUuid,
    );
    if (own) {
        markEventSynced(sessionId, own.localId);
        refreshSyncCounts(sessionId);
    }
    if (zonesBase?.sessionId !== sessionId) acknowledgedZones = [];
    zonesBase = { sessionId, ids: [...ids] };
    acknowledgedZones = acknowledgedZones.filter(
        (entry) => entry.clientUuid !== clientUuid,
    );
    showDisabledZones(sessionId);
}

// A change acknowledged before its echo stays on the board until the echo
// comes (see applyDisabledZonesEvent).
onEventSynced((event) => {
    if (
        event.type !== "zones.disabled" ||
        zonesBase?.sessionId !== event.sessionId
    ) {
        return;
    }
    acknowledgedZones.push({
        clientUuid: event.clientUuid,
        delta: zonesDeltaOf(event.payloadJson),
    });
    showDisabledZones(event.sessionId);
});

// A refused change has left the queue: stop showing it.
onEventRejected((event) => {
    if (event.type === "zones.disabled") {
        showDisabledZonesIfOnBoard(event.sessionId);
    }
});

// No session, no zones (signing out, a session that's gone).
activeSessionId.listen((sessionId) => {
    if (sessionId) return;
    zonesBase = null;
    acknowledgedZones = [];
    if (disabledStations.get().length > 0) disabledStations.set([]);
});

function queueZonesDelta(sessionId: string, delta: ZonesDelta): PendingEvent {
    const event = enqueueEvent({
        sessionId,
        type: "zones.disabled",
        payloadJson: delta,
        clientUuid: `zones-disabled-${randomUUID()}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);
    return event;
}

// Deltas must reach the server in order. One queued behind an earlier
// unsynced delta (in flight, or failed and waiting for a retry) goes with
// the in-order flush, which stops at a failure, instead of overtaking it.
function sendZonesDelta(event: PendingEvent, keepalive = false): Promise<void> {
    const behindAnother = getPendingEvents(event.sessionId).some(
        (queued) =>
            isUnsyncedZonesEvent(queued) && queued.localId !== event.localId,
    );
    return behindAnother
        ? flushPendingEvents(event.sessionId)
        : sendPendingEvent(event, keepalive);
}

export function cancelPendingDisabledZonesSave(sessionId?: string): void {
    const ids = sessionId ? [sessionId] : [...zonesTimers.keys()];
    for (const id of ids) {
        clearTimeout(zonesTimers.get(id));
        zonesTimers.delete(id);
        scheduledZones.delete(id);
    }
}

/**
 * Save a change the player made to the board. The debounced delta is what
 * the board now differs by from the changes already saved or queued, so a
 * zone toggled back and forth saves nothing, unless another player changed
 * it meanwhile.
 */
export function saveDisabledZonesDelta(
    sessionId: string,
    delta: ZonesDelta,
): void {
    const saved = savedDisabledZones(sessionId);
    const scheduled = scheduledZones.get(sessionId);
    const board = applyZonesDelta(
        scheduled ? applyZonesDelta(saved, scheduled) : saved,
        delta,
    );
    const next = diffZoneIds(saved, board);
    cancelPendingDisabledZonesSave(sessionId);
    if (!isNoZonesChange(next)) {
        scheduledZones.set(sessionId, next);
        zonesTimers.set(
            sessionId,
            setTimeout(() => {
                flushDisabledZonesSave(sessionId).catch((err) => {
                    console.warn("[sessionState] failed to save disabled zones:", err);
                });
            }, 300),
        );
    }
    showDisabledZonesIfOnBoard(sessionId);
}

/**
 * Queue the debounced delta durably now and start sending it. Rejects, never
 * throws, if it can't even be queued.
 */
export async function flushDisabledZonesSave(
    sessionId: string,
    keepalive = false,
): Promise<void> {
    const delta = scheduledZones.get(sessionId);
    if (!delta) return;
    const event = queueZonesDelta(sessionId, delta);
    cancelPendingDisabledZonesSave(sessionId);
    await sendZonesDelta(event, keepalive);
}

// Disabled zones used to stay on the device (see legacyDisabledZones). Add
// this device's to the session, whatever the server has: every player's old
// list ends up on it. They are queued durably before the device's copy goes,
// and the board shows them on top of the server's list once queued.
function adoptLegacyDisabledZones(session: GameSessionSummary): void {
    // A server without the field would drop the save, and the zones with it.
    if (!Array.isArray(session.disabledZoneIds)) return;
    const onServer = new Set(session.disabledZoneIds);
    const legacy = legacyDisabledZones(session.id).filter(
        (id) => !onServer.has(id),
    );
    if (legacy.length > 0) {
        console.info(
            "[sessionState] adding",
            legacy.length,
            "disabled zone(s) from this device to the session",
        );
        let event: PendingEvent;
        try {
            event = queueZonesDelta(session.id, {
                disableZoneIds: legacy,
                enableZoneIds: [],
            });
        } catch (err) {
            // Storage is full: keep the device's copy for the next load.
            console.warn("[sessionState] failed to queue legacy disabled zones:", err);
            return;
        }
        sendZonesDelta(event).catch((err) => {
            console.warn(
                "[sessionState] failed to save legacy disabled zones:",
                err,
            );
        });
    }
    forgetLegacyDisabledZones(session.id);
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
    flushDisabledZonesSave(sessionId, keepalive).catch((err) => {
        console.warn("[sessionState] failed to flush disabled zones save:", err);
    });
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
        if (!id || !verifiedUserId.get()) return;
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

    const [loadedStrokes, loadedQuestions, session] = await Promise.all([
        loadStrokesFromServer(sessionId),
        loadQuestionsFromServer(sessionId),
        fetch(`${API_BASE}/sessions/${sessionId}`, {
            credentials: "include",
        }).then(async (res) => {
            if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
            return (await res.json()) as GameSessionSummary;
        }),
    ]);

    setCachedSession({
        sessionId,
        userId,
        strokes: loadedStrokes,
        questions: loadedQuestions,
        disabledZoneIds: Array.isArray(session.disabledZoneIds)
            ? session.disabledZoneIds
            : undefined,
        lastSyncedAt: Date.now(),
        lastSequence: serverCursor,
    });
    adoptLegacyDisabledZones(session);

    return {
        strokes: loadedStrokes,
        session,
        questions: loadedQuestions,
        cursor: serverCursor,
    };
}
