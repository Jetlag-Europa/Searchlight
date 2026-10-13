import type { StrokeFeature } from "@/annotations/types";
import { pendingEventCount,syncStatus } from "@/lib/context";
import {
    enqueueEvent,
    getPendingEvents,
    markEventFailed,
    markEventSynced,
} from "@/lib/eventQueue";
import { scheduleRetry } from "@/lib/syncManager";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

const inFlightCreates = new Map<string, Promise<void>>();
const strokeTombstones = new Set<string>();

export function recordStrokeTombstone(clientUuid: string): void {
    strokeTombstones.add(clientUuid);
}

export function isStrokeTombstoned(clientUuid: string): boolean {
    return strokeTombstones.has(clientUuid);
}

export function clearStrokeTombstones(): void {
    strokeTombstones.clear();
}

function refreshSyncCounts(sessionId: string): void {
    const count = getPendingEvents(sessionId).filter(
        (e) => e.status === "pending" || e.status === "failed",
    ).length;
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

export async function saveStrokeToServer(
    sessionId: string,
    stroke: StrokeFeature,
): Promise<void> {
    const clientUuid = stroke.properties.clientUuid;
    if (strokeTombstones.has(clientUuid)) {
        console.info(
            "[serverStore] stroke.create skipped — tombstone already exists:",
            clientUuid,
        );
        return;
    }

    const event = enqueueEvent({
        sessionId,
        type: "stroke.create",
        payloadJson: stroke,
        clientUuid: `stroke-create-${clientUuid}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    const postPromise = (async () => {
        try {
            const res = await fetch(
                `${API_BASE}/sessions/${sessionId}/strokes`,
                {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        clientUuid,
                        payloadJson: stroke,
                    }),
                },
            );
            if (!res.ok) throw new Error(`Failed to save stroke: ${res.status}`);
            markEventSynced(sessionId, event.localId);
            refreshSyncCounts(sessionId);
        } catch (e) {
            markEventFailed(sessionId, event.localId);
            refreshSyncCounts(sessionId);
            if (!navigator.onLine) syncStatus.set("offline");
            scheduleRetry(sessionId);
            throw e;
        } finally {
            inFlightCreates.delete(clientUuid);
        }
    })();

    inFlightCreates.set(clientUuid, postPromise);
    return postPromise;
}

export async function deleteStrokeFromServer(
    sessionId: string,
    clientUuid: string,
): Promise<void> {
    recordStrokeTombstone(clientUuid);

    const event = enqueueEvent({
        sessionId,
        type: "stroke.delete",
        payloadJson: { clientUuid },
        clientUuid: `stroke-delete-${clientUuid}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    // Wait for any in-flight create for the same stroke to finish first
    const inFlight = inFlightCreates.get(clientUuid);
    if (inFlight) {
        try {
            await inFlight;
        } catch {
            // Even if create failed, proceed with delete so server tombstone is created
        }
    }

    try {
        const res = await fetch(
            `${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`,
            {
                method: "DELETE",
                credentials: "include",
            },
        );
        if (!res.ok && res.status !== 404) {
            throw new Error(`Failed to delete stroke: ${res.status}`);
        }
        markEventSynced(sessionId, event.localId);
        refreshSyncCounts(sessionId);
    } catch (e) {
        markEventFailed(sessionId, event.localId);
        refreshSyncCounts(sessionId);
        if (!navigator.onLine) syncStatus.set("offline");
        scheduleRetry(sessionId);
        throw e;
    }
}
