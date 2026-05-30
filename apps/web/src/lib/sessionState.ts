import type { Questions } from "@/maps/schema";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import { randomUUID } from "@/lib/utils";
import {
    enqueueEvent,
    markEventSynced,
    getPendingEvents,
    setCachedSession,
    getCachedSession,
} from "@/lib/eventQueue";
import { syncStatus, pendingEventCount } from "@/lib/context";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

function refreshSyncCounts(sessionId: string): void {
    const count = getPendingEvents(sessionId).filter((e) => e.status === "pending").length;
    pendingEventCount.set(count);
    if (count === 0) syncStatus.set("synced");
}

// ── Questions ────────────────────────────────────────────────────────────────

export async function loadQuestionsFromServer(sessionId: string): Promise<Questions> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`);
    const data = await res.json() as { questions: Array<{ clientUuid: string; ordinal: number; payloadJson: unknown }> };
    return data.questions.map((q) => q.payloadJson) as unknown as Questions;
}

export async function saveQuestionsToServer(
    sessionId: string,
    qs: Questions,
): Promise<void> {
    const replacementId = randomUUID();
    const mappedQuestions = qs.map((q, i) => ({
        clientUuid: randomUUID(),
        ordinal: i,
        payloadJson: q,
    }));

    const event = enqueueEvent({
        sessionId,
        type: "questions.replace",
        payloadJson: { replacementId, questions: mappedQuestions },
        clientUuid: `questions-replace-${replacementId}`,
        clientCreatedAt: Date.now(),
    });
    refreshSyncCounts(sessionId);

    try {
        const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ replacementId, questions: mappedQuestions }),
        });
        if (!res.ok) throw new Error(`Failed to save questions: ${res.status}`);
        markEventSynced(sessionId, event.localId);
        // Keep the cache in sync so offline reloads see the current state.
        const cachedState = getCachedSession(sessionId);
        if (cachedState) {
            setCachedSession({ ...cachedState, questions: qs, lastSyncedAt: Date.now() });
        }
        refreshSyncCounts(sessionId);
    } catch (e) {
        if (!navigator.onLine) syncStatus.set("offline");
        throw e;
    }
}

let questionSaveTimer: ReturnType<typeof setTimeout> | null = null;
const QUESTION_DEBOUNCE_MS = 500;

// ── Hider mode ────────────────────────────────────────────────────────────────

let hiderSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveHiderModeToServer(
    sessionId: string,
    mode: false | { latitude: number; longitude: number },
): void {
    if (hiderSaveTimer) clearTimeout(hiderSaveTimer);
    hiderSaveTimer = setTimeout(() => {
        hiderSaveTimer = null;
        const body = mode === false
            ? { hiderLat: null, hiderLng: null }
            : { hiderLat: mode.latitude, hiderLng: mode.longitude };
        fetch(`${API_BASE}/sessions/${sessionId}`, {
            method: "PATCH",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }).catch((err) => {
            console.warn("[sessionState] failed to save hider mode:", err);
        });
    }, 800);
}

export function cancelPendingQuestionSave(): void {
    if (questionSaveTimer) {
        clearTimeout(questionSaveTimer);
        questionSaveTimer = null;
    }
}

export function cancelPendingHiderSave(): void {
    if (hiderSaveTimer) {
        clearTimeout(hiderSaveTimer);
        hiderSaveTimer = null;
    }
}

export function saveQuestionsDebounced(sessionId: string, qs: Questions): void {
    if (questionSaveTimer) clearTimeout(questionSaveTimer);
    questionSaveTimer = setTimeout(() => {
        questionSaveTimer = null;
        saveQuestionsToServer(sessionId, qs).catch((err) => {
            console.warn("[sessionState] failed to save questions:", err);
        });
    }, QUESTION_DEBOUNCE_MS);
}

// ── Session load ─────────────────────────────────────────────────────────────

export async function loadSessionContent(sessionId: string): Promise<{
    strokes: StrokeFeature[];
    questions: Questions;
}> {
    const [loadedStrokes, loadedQuestions] = await Promise.all([
        loadStrokesFromServer(sessionId),
        loadQuestionsFromServer(sessionId),
    ]);

    strokes.set(loadedStrokes);

    // Cache the freshly loaded server state for offline-first reloads.
    setCachedSession({
        sessionId,
        strokes: loadedStrokes,
        questions: loadedQuestions,
        lastSyncedAt: Date.now(),
        lastServerEventAt: new Date().toISOString(),
    });

    return { strokes: loadedStrokes, questions: loadedQuestions };
}
