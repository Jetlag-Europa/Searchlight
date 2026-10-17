import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId } from "@/lib/activeSession";
import { pendingEventCount,syncStatus } from "@/lib/context";
import {
    discardEvent,
    type EventType,
    getCachedSession,
    getPendingEvents,
    isReplacementEventType,
    markEventFailed,
    markEventSynced,
    type PendingEvent,
    setCachedSession,
} from "@/lib/eventQueue";
import type { Questions } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Browsers reject keepalive requests once their bodies exceed 64 KiB in total.
// A larger body is sent normally: it is queued durably either way, and a
// hidden tab that is not unloaded can still deliver it.
const KEEPALIVE_BODY_LIMIT = 64 * 1024;

/** The server answered an edit with an error status. */
export class SyncRequestError extends Error {
    readonly status: number;

    constructor(type: EventType, status: number) {
        super(`${type} failed: ${status}`);
        this.status = status;
    }
}

export type SendFailure = "retry" | "unavailable" | "rejected";

/**
 * What a failed send means. A 403 or 404 means the session is gone or this
 * user lost access to it. Any other 4xx but 401, 408 and 429 refuses the edit
 * itself (too large, invalid, a conflict): resending it would fail again and
 * block the edits behind it, and incoming updates to its field, forever. A
 * network error (no status), a 5xx, 401, 408 or 429 may pass on a retry.
 */
export function classifySendFailure(status: number | undefined): SendFailure {
    if (status === undefined || status < 400 || status >= 500) return "retry";
    if (status === 401 || status === 408 || status === 429) return "retry";
    if (status === 403 || status === 404) return "unavailable";
    return "rejected";
}

function failureOf(err: unknown): { kind: SendFailure; status?: number } {
    const status = err instanceof SyncRequestError ? err.status : undefined;
    return { kind: classifySendFailure(status), status };
}

type RejectionListener = (event: PendingEvent, status: number) => void;
const rejectionListeners = new Set<RejectionListener>();

/**
 * Hear about edits the server refused for good. A rejected edit has already
 * left the queue, so the listener should show the server's state for its
 * field again. An edit to an unavailable session (403/404) stays queued.
 */
export function onEventRejected(listener: RejectionListener): () => void {
    rejectionListeners.add(listener);
    return () => {
        rejectionListeners.delete(listener);
    };
}

async function sendEvent(event: PendingEvent, keepalive: boolean): Promise<void> {
    const { sessionId } = event;

    if (event.type === "stroke.create") {
        const stroke = event.payloadJson as StrokeFeature;
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientUuid: stroke.properties.clientUuid,
                payloadJson: stroke,
            }),
        });
        if (!res.ok) throw new SyncRequestError("stroke.create", res.status);
    } else if (event.type === "stroke.delete") {
        const { clientUuid } = event.payloadJson as { clientUuid: string };
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
            method: "DELETE",
            credentials: "include",
        });
        if (!res.ok && res.status !== 404)
            throw new SyncRequestError("stroke.delete", res.status);
    } else if (event.type === "questions.replace") {
        const { replacementId, questions } = event.payloadJson as {
            replacementId: string;
            questions: unknown[];
        };
        const body = JSON.stringify({ replacementId, questions });
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: keepalive && new Blob([body]).size <= KEEPALIVE_BODY_LIMIT,
        });
        if (!res.ok)
            throw new SyncRequestError("questions.replace", res.status);
    } else if (event.type === "hider.update") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new SyncRequestError("hider.update", res.status);
    } else if (event.type === "planning.toggle") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new SyncRequestError("planning.toggle", res.status);
    }
}

// Live saves and reconnect/unload replay share one dispatcher. A second caller
// must never resend an in-flight snapshot or overtake its acknowledgement.
const dispatches = new Map<string, Promise<void>>();

// A failed event keeps blocking incoming updates to its field until it syncs,
// so retry with capped backoff while its session stays active instead of
// waiting for the next `online` event. Other sessions flush when next loaded.
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = RETRY_MIN_MS;

function hasUnsyncedEvents(sessionId: string): boolean {
    return getPendingEvents(sessionId).some((event) => event.status !== "synced");
}

/**
 * Record a failed send of `event`: keep it queued for a retry, or drop it if
 * the server rejected it. Returns whether it was dropped.
 */
export function recordSendFailure(event: PendingEvent, err: unknown): boolean {
    const { sessionId, localId } = event;
    const { kind, status } = failureOf(err);
    // A newer snapshot may have replaced it meanwhile; that one is sent next.
    const queued = getPendingEvents(sessionId).some(
        (candidate) => candidate.localId === localId,
    );
    if (kind === "rejected") {
        if (queued) discardEvent(sessionId, localId);
    } else {
        markEventFailed(sessionId, localId);
        scheduleRetry(sessionId);
    }
    if (kind !== "retry" && queued && status !== undefined) {
        for (const listener of rejectionListeners) listener(event, status);
    }
    return kind === "rejected";
}

function cancelRetry(): void {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = RETRY_MIN_MS;
}

export function scheduleRetry(sessionId: string): void {
    if (retryTimer !== undefined || sessionId !== activeSessionId.get()) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (sessionId !== activeSessionId.get()) return;
        console.info("[searchlight:sync] retrying unsynced events for", sessionId);
        flushPendingEvents(sessionId).catch((e) => {
            console.warn("[searchlight:sync] retry error:", e);
        });
    }, delay);
}

/** Flush now instead of waiting out the backoff, e.g. after a reconnect. */
export function retryPendingEvents(sessionId: string): void {
    cancelRetry();
    if (!hasUnsyncedEvents(sessionId)) return;
    flushPendingEvents(sessionId).catch((e) => {
        console.warn("[searchlight:sync] flush error:", e);
    });
}

function refreshSyncCounts(sessionId: string): void {
    const remaining = getPendingEvents(sessionId).filter(
        (event) => event.status !== "synced",
    ).length;
    pendingEventCount.set(remaining);
    if (remaining === 0) {
        syncStatus.set("synced");
        if (sessionId === activeSessionId.get()) cancelRetry();
    }
}

async function dispatchQueuedEvent(
    requested: PendingEvent,
    keepalive: boolean,
): Promise<void> {
    const { sessionId } = requested;
    const queued = getPendingEvents(sessionId);
    const event = isReplacementEventType(requested.type)
        ? queued.findLast((candidate) => candidate.type === requested.type)
        : queued.find((candidate) => candidate.localId === requested.localId);
    if (!event) return;

    syncStatus.set("syncing");
    try {
        await sendEvent(event, keepalive);
        // Its SSE echo can arrive first, and later replaces may already be
        // cached on top of it: only a still-queued replace updates the cache.
        const stillQueued = getPendingEvents(sessionId).some(
            (candidate) => candidate.localId === event.localId,
        );
        if (event.type === "questions.replace" && stillQueued) {
            const { questions } = event.payloadJson as {
                questions: Array<{ payloadJson: Questions[number] }>;
            };
            const cached = getCachedSession(sessionId);
            setCachedSession({
                ...cached,
                sessionId,
                strokes: cached?.strokes ?? [],
                questions: questions.map((question) => question.payloadJson),
                lastSyncedAt: Date.now(),
                lastSequence: cached?.lastSequence ?? 0,
            });
        }
        markEventSynced(sessionId, event.localId);
    } catch (err) {
        if (!recordSendFailure(event, err)) syncStatus.set("offline");
        throw err;
    } finally {
        refreshSyncCounts(sessionId);
    }
}

export function sendPendingEvent(
    event: PendingEvent,
    keepalive = false,
): Promise<void> {
    const previous = dispatches.get(event.sessionId);
    const run = () => dispatchQueuedEvent(event, keepalive);
    const result = previous ? previous.catch(() => {}).then(run) : run();
    dispatches.set(event.sessionId, result);
    const cleanup = () => {
        if (dispatches.get(event.sessionId) === result) {
            dispatches.delete(event.sessionId);
        }
    };
    void result.then(cleanup, cleanup);
    return result;
}

export async function flushPendingEvents(sessionId: string): Promise<void> {
    const pending = getPendingEvents(sessionId).filter(
        (event) => event.status !== "synced",
    );
    for (const event of pending) {
        try {
            await sendPendingEvent(event);
        } catch (err) {
            // A rejected edit has left the queue: the ones after it can sync.
            if (failureOf(err).kind === "rejected") continue;
            console.warn("[searchlight:sync] event send failed, stopping flush:", err);
            return;
        }
    }
    refreshSyncCounts(sessionId);
}
function handleOnline() {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    console.info("[searchlight:sync] online — flushing pending events for", sessionId);
    cancelRetry();
    flushPendingEvents(sessionId).catch((e) => {
        console.warn("[searchlight:sync] flush error:", e);
    });
}

function handleOffline() {
    syncStatus.set("offline");
}

function handleVisibilityChange() {
    const sessionId = activeSessionId.get();
    if (document.visibilityState === "visible" && sessionId) {
        retryPendingEvents(sessionId);
    }
}

function handleActiveSessionChange(sessionId: string) {
    // Retries follow the active session, including a load whose flush failed
    // before the session was published.
    cancelRetry();
    if (sessionId && hasUnsyncedEvents(sessionId)) scheduleRetry(sessionId);
}

let started = false;
let unlistenActiveSession: (() => void) | undefined;

export function startSyncManager(): void {
    if (started) return;
    started = true;
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    unlistenActiveSession = activeSessionId.listen(handleActiveSessionChange);
    if (!navigator.onLine) syncStatus.set("offline");
}

export function stopSyncManager(): void {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    unlistenActiveSession?.();
    unlistenActiveSession = undefined;
    cancelRetry();
    started = false;
}
