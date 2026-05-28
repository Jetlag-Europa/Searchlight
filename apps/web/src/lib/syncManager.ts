import { activeSessionId } from "@/lib/activeSession";
import { syncStatus, pendingEventCount } from "@/lib/context";
import {
    getPendingEvents,
    markEventSynced,
    markEventFailed,
    resetFailedEvents,
    type PendingEvent,
} from "@/lib/eventQueue";
import type { StrokeFeature } from "@/annotations/types";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

async function sendEvent(event: PendingEvent): Promise<void> {
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
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ replacementId, questions }),
        });
        if (!res.ok) throw new Error(`questions.replace failed: ${res.status}`);
    }
}

export async function flushPendingEvents(sessionId: string): Promise<void> {
    // Reset any previously-failed events so they get retried.
    resetFailedEvents(sessionId);

    const pending = getPendingEvents(sessionId).filter((e) => e.status === "pending");
    if (pending.length === 0) {
        syncStatus.set("synced");
        pendingEventCount.set(0);
        return;
    }

    syncStatus.set("syncing");
    pendingEventCount.set(pending.length);

    for (const event of pending) {
        try {
            await sendEvent(event);
            markEventSynced(sessionId, event.localId);
            const remaining = getPendingEvents(sessionId).filter((e) => e.status === "pending").length;
            pendingEventCount.set(remaining);
        } catch (e) {
            console.warn("[taibled:sync] event send failed, stopping flush:", e);
            markEventFailed(sessionId, event.localId);
            syncStatus.set("offline");
            pendingEventCount.set(
                getPendingEvents(sessionId).filter((e) => e.status === "pending").length,
            );
            return;
        }
    }

    syncStatus.set("synced");
    pendingEventCount.set(0);
}

function handleOnline() {
    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    console.info("[taibled:sync] online — flushing pending events for", sessionId);
    flushPendingEvents(sessionId).catch((e) => {
        console.warn("[taibled:sync] flush error:", e);
    });
}

function handleOffline() {
    syncStatus.set("offline");
}

let started = false;

export function startSyncManager(): void {
    if (started) return;
    started = true;
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    if (!navigator.onLine) syncStatus.set("offline");
}

export function stopSyncManager(): void {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
    started = false;
}
