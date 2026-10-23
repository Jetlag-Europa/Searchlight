import type {
    GameSessionSummary,
    SessionVisibility,
} from "@searchlight/shared";

import type { StrokeFeature } from "@/annotations/types";
import { offlineUserId, verifiedUserId } from "@/lib/activeSession";
import { forgetDisabledZones } from "@/lib/disabledZones";
import type { Questions } from "@/maps/schema";

export type EventType =
    | "stroke.create"
    | "stroke.delete"
    | "questions.replace"
    | "hider.update"
    | "planning.toggle";

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

/**
 * The server's question list a queued list was made from, and the event
 * sequence it was at. A save sends the sequence: if the server's list has
 * changed since, it refuses, and the two are merged (see questionMerge.ts).
 */
export interface QuestionsBase {
    sequence: number;
    questions: Questions;
}

export interface QuestionsReplacePayload {
    replacementId: string;
    questions: Array<{
        clientUuid: string;
        ordinal: number;
        payloadJson: Questions[number];
    }>;
    // Missing in events queued by builds from before.
    base?: QuestionsBase;
}

export interface CachedSessionState {
    sessionId: string;
    userId?: string;
    visibility?: SessionVisibility;
    // The session's details as last shown, its hider and planning mode
    // included: an offline restore has nothing else to load its game from.
    session?: GameSessionSummary;
    strokes: StrokeFeature[];
    // What the board showed, edits not yet synced included.
    questions: Questions;
    // The server's own list, as last known: the base for the next edit.
    serverQuestions?: QuestionsBase;
    lastSyncedAt: number;
    lastSequence: number;
}

export function isQuestionsBase(value: unknown): value is QuestionsBase {
    if (!value || typeof value !== "object") return false;
    const base = value as Partial<QuestionsBase>;
    return (
        typeof base.sequence === "number" &&
        Number.isSafeInteger(base.sequence) &&
        base.sequence >= 0 &&
        Array.isArray(base.questions)
    );
}

function isSessionSummary(
    value: unknown,
    sessionId: string,
): value is GameSessionSummary {
    if (!value || typeof value !== "object") return false;
    const session = value as Partial<GameSessionSummary>;
    return (
        session.id === sessionId &&
        typeof session.gameId === "string" &&
        typeof session.gameRevisionId === "string" &&
        typeof session.name === "string"
    );
}

export const CACHE_PREFIX = "taibled-cache-";
export const PENDING_PREFIX = "taibled-pending-";
export const MAX_CACHED_SESSIONS = 10;

// Each account has its own queue for a session, so edits queued by one are
// never shown to, or sent with the cookie of, another on the same browser.
// Before /me names an account (and in tests) the unowned queue is used.
function queueOwner(): string | null {
    return verifiedUserId.get() ?? offlineUserId.get();
}

function legacyPendingKey(sessionId: string) {
    return `${PENDING_PREFIX}${sessionId}`;
}

function pendingKey(sessionId: string) {
    const owner = queueOwner();
    if (!owner) return legacyPendingKey(sessionId);
    const key = `${PENDING_PREFIX}${sessionId}~${owner}`;
    // Builds from before queued without an owner: the snapshot's owner made
    // those edits. Anyone else's stay where they are.
    try {
        const legacy = localStorage.getItem(legacyPendingKey(sessionId));
        if (legacy && getCachedSession(sessionId)?.userId === owner) {
            const own = localStorage.getItem(key);
            const events = [
                ...(JSON.parse(legacy) as PendingEvent[]),
                ...(own ? (JSON.parse(own) as PendingEvent[]) : []),
            ];
            localStorage.setItem(key, JSON.stringify(events));
            localStorage.removeItem(legacyPendingKey(sessionId));
        }
    } catch {
        // Storage is best-effort; the legacy queue stays put.
    }
    return key;
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
            serverQuestions: isQuestionsBase(parsed.serverQuestions)
                ? parsed.serverQuestions
                : undefined,
            visibility: parsed.visibility,
            session: isSessionSummary(parsed.session, sessionId)
                ? parsed.session
                : undefined,
            strokes: Array.isArray(parsed.strokes) ? parsed.strokes : [],
            questions: Array.isArray(parsed.questions) ? parsed.questions : [],
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

/**
 * The base for a new question list: the one the edits still queued were
 * made from, else the server's list as last known. Undefined when this
 * browser knows neither; the list is then saved as before, over whatever
 * the server has.
 */
export function questionsBase(sessionId: string): QuestionsBase | undefined {
    const queued = getPendingEvents(sessionId).findLast(
        (event) =>
            event.type === "questions.replace" && event.status !== "synced",
    );
    if (queued) {
        const base = (queued.payloadJson as Partial<QuestionsReplacePayload>)
            ?.base;
        return isQuestionsBase(base) ? base : undefined;
    }
    const cached = getCachedSession(sessionId);
    if (!cached) return undefined;
    // A snapshot from before: its list as of its last event is the best
    // there is.
    return (
        cached.serverQuestions ?? {
            sequence: cached.lastSequence,
            questions: cached.questions,
        }
    );
}

/** The server's list is now `base` (if it's newer than what was known). */
export function setServerQuestions(
    sessionId: string,
    base: QuestionsBase,
): void {
    const cached = getCachedSession(sessionId);
    if (!cached) return;
    if ((cached.serverQuestions?.sequence ?? -1) > base.sequence) return;
    setCachedSession({ ...cached, serverQuestions: base });
}

/**
 * Give the queued question lists a new base, e.g. once the list they
 * followed on from is saved.
 */
export function rebaseQueuedQuestions(
    sessionId: string,
    base: QuestionsBase,
    exceptLocalId?: string,
): void {
    const events = getPendingEvents(sessionId);
    let changed = false;
    const rebased = events.map((event) => {
        if (
            event.type !== "questions.replace" ||
            event.status === "synced" ||
            event.localId === exceptLocalId ||
            !isQuestionsBase(
                (event.payloadJson as Partial<QuestionsReplacePayload>)?.base,
            )
        ) {
            return event;
        }
        changed = true;
        return {
            ...event,
            payloadJson: {
                ...(event.payloadJson as QuestionsReplacePayload),
                base,
            },
        };
    });
    if (changed) writePendingQueue(sessionId, rebased);
}

export function clearCachedSession(sessionId: string): void {
    localStorage.removeItem(cacheKey(sessionId));
    // Do NOT remove pendingKey(sessionId) — avoid losing pending queue on cache eviction
}

// For a session that can never sync again (deleted, or this user removed):
// unlike cache eviction, also drop its queue, which would otherwise pin the
// snapshot in storage forever, and its disabled zones.
export function discardSessionData(sessionId: string): void {
    forgetDisabledZones(sessionId);
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

type HiderModeValue = false | { latitude: number; longitude: number };

/**
 * A session's hider and planning mode: the latest of `events` that set them
 * (edits not yet synced), else the session's own.
 */
export function applyPendingModes(
    session: Pick<
        GameSessionSummary,
        "hiderLat" | "hiderLng" | "planningModeEnabled"
    >,
    events: PendingEvent[],
): { hiderMode: HiderModeValue; planningModeEnabled: boolean } {
    let hiderLat = session.hiderLat;
    let hiderLng = session.hiderLng;
    let planningModeEnabled = session.planningModeEnabled ?? false;
    for (const event of events) {
        const payload = event.payloadJson as Record<string, unknown> | null;
        if (!payload || typeof payload !== "object") continue;
        if (event.type === "hider.update") {
            hiderLat = typeof payload.hiderLat === "number" ? payload.hiderLat : null;
            hiderLng = typeof payload.hiderLng === "number" ? payload.hiderLng : null;
        } else if (
            event.type === "planning.toggle" &&
            typeof payload.planningModeEnabled === "boolean"
        ) {
            planningModeEnabled = payload.planningModeEnabled;
        }
    }
    return {
        hiderMode:
            hiderLat != null && hiderLng != null
                ? { latitude: hiderLat, longitude: hiderLng }
                : false,
        planningModeEnabled,
    };
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
