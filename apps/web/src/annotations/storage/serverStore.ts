import { isStrokeLike, type StrokeFeature } from "@/annotations/types";
import { isSessionReadOnly } from "@/lib/activeSession";
import { pendingEventCount,syncStatus } from "@/lib/context";
import {
    enqueueEvent,
    getPendingEvents,
    markEventSynced,
    type PendingEvent,
} from "@/lib/eventQueue";
import { sayStorageFull } from "@/lib/storageFull";
import {
    assertMaySend,
    assertStrokeDeleted,
    recordSendFailure,
    SyncRequestError,
    withTimeout,
} from "@/lib/syncManager";

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
    const count = getPendingEvents(sessionId).length;
    pendingEventCount.set(count);
    if (count === 0) syncStatus.set("synced");
}

// Storage too full to queue a stroke's edit: said, and the board shows it
// until a reload.
function queueStrokeEdit(event: Parameters<typeof enqueueEvent>[0]): PendingEvent {
    try {
        return enqueueEvent(event);
    } catch (err) {
        sayStorageFull();
        throw err;
    }
}

export async function loadStrokesFromServer(
    sessionId: string,
    signal?: AbortSignal,
): Promise<StrokeFeature[]> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
        credentials: "include",
        signal,
    });
    if (!res.ok) throw new Error(`Failed to load strokes: ${res.status}`);
    const data = (await res.json()) as { strokes: unknown[] };
    const loaded: StrokeFeature[] = [];
    for (const entry of data.strokes) {
        const stroke = (entry as { payloadJson?: unknown } | null)?.payloadJson;
        if (isStrokeLike(stroke)) loaded.push(stroke);
        else console.warn("[serverStore] skipping a malformed stroke:", entry);
    }
    return loaded;
}

export async function saveStrokeToServer(
    sessionId: string,
    stroke: StrokeFeature,
): Promise<void> {
    const clientUuid = stroke.properties.clientUuid;
    // Spectators can't draw.
    if (isSessionReadOnly(sessionId)) return;
    if (strokeTombstones.has(clientUuid)) {
        console.info(
            "[serverStore] stroke.create skipped — tombstone already exists:",
            clientUuid,
        );
        return;
    }

    const event = queueStrokeEdit({
        sessionId,
        type: "stroke.create",
        payloadJson: stroke,
        clientUuid: `stroke-create-${clientUuid}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    const postPromise = (async () => {
        try {
            assertMaySend();
            const res = await withTimeout((signal) =>
                fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        clientUuid,
                        payloadJson: stroke,
                    }),
                    signal,
                }),
            );
            if (!res.ok)
                throw await SyncRequestError.from("stroke.create", res);
            markEventSynced(sessionId, event.localId);
            refreshSyncCounts(sessionId);
        } catch (e) {
            recordSendFailure(event, e);
            refreshSyncCounts(sessionId);
            if (!navigator.onLine) syncStatus.set("offline");
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
    if (isSessionReadOnly(sessionId)) return;
    recordStrokeTombstone(clientUuid);

    const event = queueStrokeEdit({
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
        assertMaySend();
        const res = await withTimeout((signal) =>
            fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
                method: "DELETE",
                credentials: "include",
                signal,
            }),
        );
        await assertStrokeDeleted(res);
        markEventSynced(sessionId, event.localId);
        refreshSyncCounts(sessionId);
    } catch (e) {
        recordSendFailure(event, e);
        refreshSyncCounts(sessionId);
        if (!navigator.onLine) syncStatus.set("offline");
        throw e;
    }
}
