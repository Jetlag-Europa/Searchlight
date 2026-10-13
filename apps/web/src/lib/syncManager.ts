import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId } from "@/lib/activeSession";
import { pendingEventCount,syncStatus } from "@/lib/context";
import {
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
        if (!res.ok) throw new Error(`stroke.create failed: ${res.status}`);
    } else if (event.type === "stroke.delete") {
        const { clientUuid } = event.payloadJson as { clientUuid: string };
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
            method: "DELETE",
            credentials: "include",
        });
        if (!res.ok && res.status !== 404) throw new Error(`stroke.delete failed: ${res.status}`);
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
        if (!res.ok) throw new Error(`questions.replace failed: ${res.status}`);
    } else if (event.type === "hider.update") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new Error(`hider.update failed: ${res.status}`);
    } else if (event.type === "planning.toggle") {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event.payloadJson),
            keepalive,
        });
        if (!res.ok) throw new Error(`planning.toggle failed: ${res.status}`);
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
        markEventFailed(sessionId, event.localId);
        syncStatus.set("offline");
        scheduleRetry(sessionId);
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
