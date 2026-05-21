import type { Questions } from "@/maps/schema";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import { randomUUID } from "@/lib/utils";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// ── Questions ────────────────────────────────────────────────────────────────

export async function loadQuestionsFromServer(sessionId: string): Promise<Questions> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        credentials: "include",
    });
    if (!res.ok) throw new Error(`Failed to load questions: ${res.status}`);
    const data = await res.json() as { questions: Array<{ clientUuid: string; ordinal: number; payloadJson: unknown }> };
    // The server stores question objects as payloadJson; trust the shape.
    return data.questions.map((q) => q.payloadJson) as unknown as Questions;
}

export async function saveQuestionsToServer(
    sessionId: string,
    qs: Questions,
): Promise<void> {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/questions`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            questions: qs.map((q, i) => ({
                clientUuid: randomUUID(),
                ordinal: i,
                payloadJson: q,
            })),
        }),
    });
    if (!res.ok) throw new Error(`Failed to save questions: ${res.status}`);
}

let questionSaveTimer: ReturnType<typeof setTimeout> | null = null;
const QUESTION_DEBOUNCE_MS = 500;

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

    return { strokes: loadedStrokes, questions: loadedQuestions };
}
