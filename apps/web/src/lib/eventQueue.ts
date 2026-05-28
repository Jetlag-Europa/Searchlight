import type { Questions } from "@/maps/schema";
import type { StrokeFeature } from "@/annotations/types";

export type EventType = "stroke.create" | "stroke.delete" | "questions.replace";

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
    strokes: StrokeFeature[];
    questions: Questions;
    lastSyncedAt: number;
    lastServerEventAt: string;
}

function pendingKey(sessionId: string) {
    return `taibled-pending-${sessionId}`;
}

function cacheKey(sessionId: string) {
    return `taibled-cache-${sessionId}`;
}

export function enqueueEvent(
    event: Omit<PendingEvent, "localId" | "status" | "createdAt">,
): PendingEvent {
    const events = getPendingEvents(event.sessionId);
    const newEvent: PendingEvent = {
        ...event,
        localId: crypto.randomUUID(),
        status: "pending",
        createdAt: Date.now(),
    };
    events.push(newEvent);
    try {
        localStorage.setItem(pendingKey(event.sessionId), JSON.stringify(events));
    } catch (e) {
        console.warn("[eventQueue] localStorage write failed:", e);
    }
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
    try {
        localStorage.setItem(pendingKey(sessionId), JSON.stringify(events));
    } catch (e) {
        console.warn("[eventQueue] localStorage write failed:", e);
    }
}

export function markEventSynced(sessionId: string, localId: string): void {
    // Remove synced events immediately to keep the queue lean.
    const events = getPendingEvents(sessionId).filter((e) => e.localId !== localId);
    savePendingEvents(sessionId, events);
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
        return JSON.parse(raw) as CachedSessionState;
    } catch {
        return null;
    }
}

export function setCachedSession(state: CachedSessionState): void {
    try {
        localStorage.setItem(cacheKey(state.sessionId), JSON.stringify(state));
    } catch (e) {
        console.warn("[eventQueue] localStorage write failed (cache):", e);
    }
}

export function clearCachedSession(sessionId: string): void {
    localStorage.removeItem(cacheKey(sessionId));
    localStorage.removeItem(pendingKey(sessionId));
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
            if (!strokes.find((s) => s.properties.clientUuid === stroke.properties.clientUuid)) {
                strokes = [...strokes, stroke];
            }
        } else if (event.type === "stroke.delete") {
            const { clientUuid } = event.payloadJson as { clientUuid: string };
            strokes = strokes.filter((s) => s.properties.clientUuid !== clientUuid);
        } else if (event.type === "questions.replace") {
            const payload = event.payloadJson as { questions: Questions };
            questions = payload.questions;
        }
    }
    return { strokes, questions };
}
