import type { StrokeFeature } from "@/annotations/types";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export async function loadStrokesFromServer(sessionId: string): Promise<StrokeFeature[]> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to load strokes: ${res.status}`);
    const data = await res.json() as { strokes: Array<{ clientUuid: string; payloadJson: unknown }> };
    return data.strokes.map((s) => s.payloadJson as StrokeFeature);
}

export async function saveStrokeToServer(sessionId: string, stroke: StrokeFeature): Promise<void> {
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
}

export async function deleteStrokeFromServer(
    sessionId: string,
    clientUuid: string,
): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/strokes/${clientUuid}`, {
        method: "DELETE",
        credentials: "include",
    });
    if (!res.ok && res.status !== 404) {
        throw new Error(`Failed to delete stroke: ${res.status}`);
    }
}
