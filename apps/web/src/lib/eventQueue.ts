import type { SessionVisibility } from "@searchlight/shared";

import type { StrokeFeature } from "@/annotations/types";
import { forgetLegacyDisabledZones } from "@/lib/disabledZones";
import type { Questions } from "@/maps/schema";

export type EventType =
    | "stroke.create"
    | "stroke.delete"
    | "questions.replace"
    | "hider.update"
    | "planning.toggle"
    | "zones.disabled";

// zones.disabled events are deltas (see disabledZones), so unlike the
// snapshots below each one must be sent, in order.
export function isReplacementEventType(type: EventType): boolean {
    return (
        type === "questions.replace" ||
        type === "hider.update" ||
        type === "planning.toggle"
    );
}

export interface PendingEvent {
    localId: string;
    sessionId: string;
    type: EventType;
    payloadJson: unknown;
    clientUuid: string;
    clientCreatedAt: number;
    status: "pending" | "synced" | "failed";
    createdAt: number;
}

export interface CachedSessionState {
    sessionId: string;
    userId?: string;
    visibility?: SessionVisibility;
    strokes: StrokeFeature[];
    questions: Questions;
    // The server's disabled zones, without this device's unsaved changes.
    disabledZoneIds?: string[];
    lastSyncedAt: number;
    lastSequence: number;
}

export const CACHE_PREFIX = "taibled-cache-";
export const PENDING_PREFIX = "taibled-pending-";
export const MAX_CACHED_SESSIONS = 10;

function pendingKey(sessionId: string) {
    return `${PENDING_PREFIX}${sessionId}`;
}

function cacheKey(sessionId: string) {
    return `${CACHE_PREFIX}${sessionId}`;
}

export function evictOldCachedSessions(
    maxEntries = MAX_CACHED_SESSIONS,
    protectedSessionId?: string,
): void {
    try {
        const matchingKeys: string[] = [];
        if (
            typeof localStorage.length === "number" &&
            typeof localStorage.key === "function"
        ) {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(CACHE_PREFIX)) {
                    matchingKeys.push(key);
                }
            }
        } else {
            for (const key of Object.keys(localStorage)) {
                if (key.startsWith(CACHE_PREFIX)) {
                    matchingKeys.push(key);
                }
            }
        }

        if (matchingKeys.length <= maxEntries) {
            return;
        }

        // Only read and parse timestamps when the count actually exceeds the cap
        const cacheEntries: Array<{
            key: string;
            lastSyncedAt: number;
            hasPending: boolean;
        }> = [];
        for (const key of matchingKeys) {
            try {
                const raw = localStorage.getItem(key);
                const parsed = raw
                    ? (JSON.parse(raw) as Partial<CachedSessionState>)
                    : null;
                cacheEntries.push({
                    key,
                    lastSyncedAt:
                        typeof parsed?.lastSyncedAt === "number"
                            ? parsed.lastSyncedAt
                            : 0,
                    hasPending:
                        key ===
                            (protectedSessionId
                                ? cacheKey(protectedSessionId)
                                : undefined) ||
                        getPendingEvents(key.slice(CACHE_PREFIX.length)).some(
                            (event) => event.status !== "synced",
                        ),
                });
            } catch {
                cacheEntries.push({ key, lastSyncedAt: 0, hasPending: true });
            }
        }

        // Pending edits need their base snapshot for offline reconciliation.
        const disposable = cacheEntries
            .filter((entry) => !entry.hasPending)
            .sort((a, b) => a.lastSyncedAt - b.lastSyncedAt);
        const toRemove = Math.min(
            cacheEntries.length - maxEntries,
            disposable.length,
        );
        for (let i = 0; i < toRemove; i++) {
            localStorage.removeItem(disposable[i].key);
        }
    } catch (e) {
        console.warn("[eventQueue] evictOldCachedSessions failed:", e);
    }
}

function writePendingQueue(sessionId: string, events: PendingEvent[]): void {
    const key = pendingKey(sessionId);
    const serialized = JSON.stringify(events);
    try {
        localStorage.setItem(key, serialized);
    } catch (firstErr) {
        console.warn(
            "[eventQueue] localStorage write failed for pending events, evicting disposable cache entries:",
            firstErr,
        );
        evictOldCachedSessions(0, sessionId);
        try {
            localStorage.setItem(key, serialized);
        } catch (secondErr) {
            console.error(
                "[eventQueue] localStorage write failed after evicting snapshots:",
                secondErr,
            );
            throw new Error(
                `Failed to persist pending event to storage: ${String(secondErr)}`,
            );
        }
    }
}

export function enqueueEvent(
    event: Omit<PendingEvent, "localId" | "status" | "createdAt">,
): PendingEvent {
    // These events contain complete field snapshots. Persist the new snapshot
    // atomically in place of older intent, including requests with a lost ACK.
    const events = getPendingEvents(event.sessionId).filter(
        (queued) =>
            !isReplacementEventType(event.type) || queued.type !== event.type,
    );
    const newEvent: PendingEvent = {
        ...event,
        localId: crypto.randomUUID(),
        status: "pending",
        createdAt: Date.now(),
    };
    events.push(newEvent);
    writePendingQueue(event.sessionId, events);
    return newEvent;
}

export function getPendingEvents(sessionId: string): PendingEvent[] {
    try {
        const raw = localStorage.getItem(pendingKey(sessionId));
        if (!raw) return [];
        return JSON.parse(raw) as PendingEvent[];
    } catch {
        return [];
    }
}

function savePendingEvents(sessionId: string, events: PendingEvent[]): void {
    writePendingQueue(sessionId, events);
}

export function markEventSynced(sessionId: string, localId: string): void {
    const events = getPendingEvents(sessionId);
    const index = events.findIndex((event) => event.localId === localId);
    if (index === -1) return;
    const synced = events[index];
    // Also retire older snapshots from queues written before coalescing.
    savePendingEvents(
        sessionId,
        events.filter(
            (event, i) =>
                event.localId !== localId &&
                !(i < index && event.type === synced.type && isReplacementEventType(synced.type)),
        ),
    );
}

/** Drop an event the server rejected: resending it can never succeed. */
export function discardEvent(sessionId: string, localId: string): void {
    savePendingEvents(
        sessionId,
        getPendingEvents(sessionId).filter(
            (event) => event.localId !== localId,
        ),
    );
}

export function markEventFailed(sessionId: string, localId: string): void {
    const events = getPendingEvents(sessionId).map((e) =>
        e.localId === localId ? { ...e, status: "failed" as const } : e,
    );
    savePendingEvents(sessionId, events);
}

export function resetFailedEvents(sessionId: string): void {
    const events = getPendingEvents(sessionId).map((e) =>
        e.status === "failed" ? { ...e, status: "pending" as const } : e,
    );
    savePendingEvents(sessionId, events);
}

export function getCachedSession(sessionId: string): CachedSessionState | null {
    try {
        const raw = localStorage.getItem(cacheKey(sessionId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<CachedSessionState>;
        if (!parsed || typeof parsed !== "object") return null;
        // Migrate cached cursor to numeric 0 on old snapshots
        const lastSequence =
            typeof parsed.lastSequence === "number" ? parsed.lastSequence : 0;
        return {
            sessionId: parsed.sessionId ?? sessionId,
            userId: parsed.userId,
            visibility: parsed.visibility,
            strokes: Array.isArray(parsed.strokes) ? parsed.strokes : [],
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
            disabledZoneIds: Array.isArray(parsed.disabledZoneIds)
                ? parsed.disabledZoneIds.filter(
                      (id): id is string => typeof id === "string",
                  )
                : undefined,
            lastSyncedAt:
                typeof parsed.lastSyncedAt === "number"
                    ? parsed.lastSyncedAt
                    : 0,
            lastSequence,
        };
    } catch {
        return null;
    }
}

export function setCachedSession(state: CachedSessionState): void {
    try {
        localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(state));
        evictOldCachedSessions();
    } catch (e) {
        console.warn("[eventQueue] localStorage write failed (cache):", e);
        try {
            evictOldCachedSessions(Math.max(1, MAX_CACHED_SESSIONS - 2));
            localStorage.setItem(
                cacheKey(state.sessionId),
                JSON.stringify(state),
            );
        } catch {
            // Ignore if still failing
        }
    }
}

export function clearCachedSession(sessionId: string): void {
    localStorage.removeItem(cacheKey(sessionId));
    // Do NOT remove pendingKey(sessionId) — avoid losing pending queue on cache eviction
}

// For a session that can never sync again (deleted, or this user removed):
// unlike cache eviction, also drop its queue, which would otherwise pin the
// snapshot in storage forever, and its legacy disabled zones.
export function discardSessionData(sessionId: string): void {
    forgetLegacyDisabledZones(sessionId);
    try {
        localStorage.removeItem(pendingKey(sessionId));
        localStorage.removeItem(cacheKey(sessionId));
    } catch (e) {
        console.warn("[eventQueue] failed to discard session data:", e);
    }
}

// Derive current local state by replaying pending events on top of a cached snapshot.
// Call this on session load when a cache hit exists to get the full offline-safe state.
export function applyPendingEventsToState(
    base: { strokes: StrokeFeature[]; questions: Questions },
    events: PendingEvent[],
): { strokes: StrokeFeature[]; questions: Questions } {
    let { strokes, questions } = base;
    for (const event of events) {
        if (event.type === "stroke.create") {
            const stroke = event.payloadJson as StrokeFeature;
            if (
                !strokes.find(
                    (s) =>
                        s.properties.clientUuid ===
                        stroke.properties.clientUuid,
                )
            ) {
                strokes = [...strokes, stroke];
            }
        } else if (event.type === "stroke.delete") {
            const { clientUuid } = event.payloadJson as { clientUuid: string };
            strokes = strokes.filter(
                (s) => s.properties.clientUuid !== clientUuid,
            );
        } else if (event.type === "questions.replace") {
            const payload = event.payloadJson;
            if (
                payload &&
                typeof payload === "object" &&
                "questions" in payload &&
                Array.isArray(payload.questions)
            ) {
                questions = payload.questions.map((q) =>
                    q && typeof q === "object" && "payloadJson" in q
                        ? q.payloadJson
                        : q,
                ) as Questions;
            } else if (Array.isArray(payload)) {
                questions = payload.map((q) =>
                    q && typeof q === "object" && "payloadJson" in q
                        ? q.payloadJson
                        : q,
                ) as Questions;
            }
        }
    }
    return { strokes, questions };
}

// Replay the edits the server hasn't acknowledged (pending or failed) on top of
// a snapshot, so loading server or cached state never hides unsynced work.
export function applyUnsyncedEvents(
    sessionId: string,
    base: { strokes: StrokeFeature[]; questions: Questions },
): { strokes: StrokeFeature[]; questions: Questions } {
    return applyPendingEventsToState(
        base,
        getPendingEvents(sessionId).filter((event) => event.status !== "synced"),
    );
}
