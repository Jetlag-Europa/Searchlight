import {
    type QuestionHistoryResponse,
    sameQuestionKey,
} from "@searchlight/shared";

import type { CompiledGame } from "@/game-definition/compile";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import { questions } from "@/lib/context";
import type { HistoryLine, RemovedQuestion } from "@/lib/historyLines";
import { placeRemovedQuestions } from "@/lib/questionUndo";
import { type Question, questionSchema } from "@/maps/schema";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

export class QuestionHistoryError extends Error {
    constructor(readonly status: number) {
        super(`Failed to load the question history: ${status}`);
    }
}

/**
 * A page of a session's question history, newest first: the newest page,
 * the one `before` a sequence, or the saves `after` one.
 */
export async function fetchQuestionHistory(
    sessionId: string,
    { before, after }: { before?: number; after?: number } = {},
): Promise<QuestionHistoryResponse> {
    const query =
        after !== undefined
            ? `?after=${after}`
            : before !== undefined
              ? `?before=${before}`
              : "";
    const res = await fetch(
        `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/questions/history${query}`,
        { credentials: "include" },
    );
    if (!res.ok) throw new QuestionHistoryError(res.status);
    return (await res.json()) as QuestionHistoryResponse;
}

const bySequenceDesc = (
    entries: QuestionHistoryResponse["entries"],
): QuestionHistoryResponse["entries"] =>
    [...new Map(entries.map((e) => [e.sequence, e])).values()].sort(
        (a, b) => b.sequence - a.sequence,
    );

/** The loaded history with the saves since its newest on top. */
export function prependNewer(
    loaded: QuestionHistoryResponse,
    newer: QuestionHistoryResponse,
): QuestionHistoryResponse {
    return {
        entries: bySequenceDesc([...newer.entries, ...loaded.entries]),
        nextBefore: loaded.nextBefore,
        newest:
            newer.newest === null
                ? loaded.newest
                : Math.max(newer.newest, loaded.newest ?? 0),
    };
}

/** The loaded history with an older page below it. */
export function appendOlderPage(
    loaded: QuestionHistoryResponse,
    older: QuestionHistoryResponse,
): QuestionHistoryResponse {
    return {
        entries: bySequenceDesc([...loaded.entries, ...older.entries]),
        nextBefore: older.nextBefore,
        newest: loaded.newest,
    };
}

export type Restorable =
    | { status: "ok"; question: Question }
    | { status: "unavailable"; reason: string };

// Parsing a question can be slow-ish and the board changes often, so each
// deleted question is parsed once. Keyed by the change's question object,
// which stays the same while its history entry is loaded.
const parsed = new WeakMap<object, Question | null>();
const parseRemoved = (question: unknown): Question | null => {
    if (typeof question !== "object" || question === null) return null;
    if (!parsed.has(question)) {
        const result = questionSchema.safeParse(question);
        parsed.set(question, result.success ? result.data : null);
    }
    return parsed.get(question)!;
};

/**
 * Whether a deleted question can go back on the board, and why not. It is
 * re-read like a question from the server, so one saved by an older or newer
 * client, or one the game no longer has, isn't put back broken.
 */
export function restorable(
    removed: Pick<RemovedQuestion, "key" | "question">,
    current: readonly { key: number }[],
    compiled: Pick<CompiledGame, "questionMap"> | null,
): Restorable {
    if (current.some((q) => sameQuestionKey(q.key, removed.key))) {
        return { status: "unavailable", reason: "On the board" };
    }
    const question = parseRemoved(removed.question);
    if (!question) {
        return { status: "unavailable", reason: "Can't be restored" };
    }
    if (filterSupportedQuestions([question], compiled).length === 0) {
        return {
            status: "unavailable",
            reason: "Can't be restored in this game",
        };
    }
    return { status: "ok", question };
}

/**
 * Puts deleted questions back on the board where they were, as Undo does.
 * Goes through questions.set, so it saves and syncs like any edit.
 */
export function restoreFromHistory(
    line: Pick<HistoryLine, "order">,
    targets: readonly RemovedQuestion[],
): void {
    const current = questions.get();
    const compiled = compiledGameAtom.get();
    const ready = targets.flatMap((target) => {
        const check = restorable(target, current, compiled);
        return check.status === "ok"
            ? // A copy: cards edit questions in place, and the parsed one
              // stays cached for this line's next Restore.
              [
                  {
                      question: structuredClone(check.question),
                      index: target.index,
                  },
              ]
            : [];
    });
    const next = placeRemovedQuestions(current, line.order ?? [], ready);
    if (next) questions.set(next);
}

/** "14:05", with the day ("3 Nov") when it isn't today. */
export function formatHistoryTime(
    at: string,
    now = new Date(),
): { day: string | null; time: string } {
    const date = new Date(at);
    const time = date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
    if (date.toDateString() === now.toDateString()) return { day: null, time };
    const day = date.toLocaleDateString([], {
        day: "numeric",
        month: "short",
        ...(date.getFullYear() === now.getFullYear()
            ? {}
            : { year: "numeric" }),
    });
    return { day, time };
}
