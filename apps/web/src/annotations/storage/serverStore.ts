import type { StrokeFeature } from "@/annotations/types";
import {
    enqueueEvent,
    markEventSynced,
    getPendingEvents,
} from "@/lib/eventQueue";
import { syncStatus, pendingEventCount } from "@/lib/context";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function refreshSyncCounts(sessionId: string): void {
    const count = getPendingEvents(sessionId).filter((e) => e.status === "pending").length;
    pendingEventCount.set(count);
    if (count === 0) syncStatus.set("synced");
}

export async function loadStrokesFromServer(sessionId: string): Promise<StrokeFeature[]> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to load strokes: ${res.status}`);
    const data = await res.json() as { strokes: Array<{ clientUuid: string; payloadJson: unknown }> };
    return data.strokes.map((s) => s.payloadJson as StrokeFeature);
}

export async function saveStrokeToServer(sessionId: string, stroke: StrokeFeature): Promise<void> {
    const event = enqueueEvent({
        sessionId,
        type: "stroke.create",
        payloadJson: stroke,
        clientUuid: `stroke-create-${stroke.properties.clientUuid}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    try {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                clientUuid: stroke.properties.clientUuid,
                payloadJson: stroke,
            }),
        });
        if (!res.ok) throw new Error(`Failed to save stroke: ${res.status}`);
        markEventSynced(sessionId, event.localId);
        refreshSyncCounts(sessionId);
    } catch (e) {
        if (!navigator.onLine) syncStatus.set("offline");
        throw e;
    }
}

export async function deleteStrokeFromServer(
    sessionId: string,
    clientUuid: string,
): Promise<void> {
    const event = enqueueEvent({
        sessionId,
        type: "stroke.delete",
        payloadJson: { clientUuid },
        clientUuid: `stroke-delete-${clientUuid}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    try {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
            method: "DELETE",
            credentials: "include",
        });
        if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete stroke: ${res.status}`);
        }
        markEventSynced(sessionId, event.localId);
        refreshSyncCounts(sessionId);
    } catch (e) {
        if (!navigator.onLine) syncStatus.set("offline");
        throw e;
    }
}
