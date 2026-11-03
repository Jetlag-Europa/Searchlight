import type { QuestionHistoryResponse } from "@searchlight/shared";

import type { CompiledGame } from "@/game-definition/compile";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import { sessionReadOnly } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import type { HistoryLine, RemovedQuestion } from "@/lib/historyLines";
import {
    questionConflicts,
    questionDecisionsPossible,
} from "@/lib/questionConflicts";
import { sameQuestionKey, sameQuestionSubstance } from "@/lib/questionMerge";
import { boardLabel } from "@/lib/questionNames";
import {
    asRestored,
    lineageKeys,
    type Lines,
    onBoardAs,
    placeRestored,
    restoredKeys,
} from "@/lib/questionUndo";
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
 * Why a deleted question can't be put back just now, or null. Not while the
 * player still has to decide about it, under its key or as what it was
 * restored as: Restore would decide for them. Nor while no decision can be
 * taken (the board is loading another session, or offline on a board not
 * kept): what Restore put there wouldn't be saved.
 */
export function restoreBlocked(
    removed: number | Pick<RemovedQuestion, "key" | "restoredAs">,
    {
        held = questionConflicts.get(),
        decisionsPossible = questionDecisionsPossible.get(),
        lines = [],
    }: {
        held?: readonly { key: number }[];
        decisionsPossible?: boolean;
        // Every line loaded, for what it was restored as since.
        lines?: Lines;
    } = {},
): string | null {
    const keys = lineageKeys(
        typeof removed === "number" ? { key: removed } : removed,
        lines,
    );
    if (held.some((c) => keys.some((key) => sameQuestionKey(c.key, key)))) {
        return "Needs a decision first";
    }
    if (!decisionsPossible) return notRightNowReason();
    return null;
}

/**
 * Why Restore waits for the board: offline on a board not kept here, or
 * a session still loading.
 */
export function notRightNowReason(
    online: boolean | undefined = typeof navigator === "undefined"
        ? undefined
        : navigator.onLine,
): string {
    return online === false ? "Offline" : "Loading…";
}

/**
 * Whether a deleted question can go back on the board, and why not. It is
 * re-read like a question from the server, so one saved by an older or newer
 * client, or one the game no longer has, isn't put back broken.
 */
export function restorable(
    removed: Pick<RemovedQuestion, "key" | "question" | "restoredAs" | "order">,
    current: readonly { key: number }[],
    compiled: Pick<CompiledGame, "questionMap"> | null,
    // Every line loaded, for what it was restored as since.
    lines: Lines = [],
): Restorable {
    const now = onBoardAs(removed, current, lines);
    if (now !== undefined) {
        // As the board calls it now: "Radius 2" may be another question
        // since the delete shifted the positions.
        const label = boardLabel(current, now);
        return {
            status: "unavailable",
            reason: label ? `On the board as ${label}` : "On the board",
        };
    }
    const question = parseRemoved(removed.question);
    // A teammate's restore the History hasn't loaded yet: a question with
    // its content that wasn't on the board when it was deleted (a twin that
    // was is another question), and isn't known as another one's restore.
    // Restoring again would make two.
    const claimed = [...(removed.order ?? []), ...restoredKeys(lines)];
    const since = current.filter(
        (q) => !claimed.some((key) => sameQuestionKey(key, q.key)),
    );
    const twin = since.find(
        (q) =>
            sameQuestionSubstance(q, removed.question) ||
            (question !== null && sameQuestionSubstance(q, question)),
    );
    if (removed.order && twin) {
        const label = boardLabel(current, twin.key);
        return {
            status: "unavailable",
            reason: label ? `On the board as ${label}` : "On the board",
        };
    }
    if (!question) {
        return { status: "unavailable", reason: "Can't be restored" };
    }
    if (filterSupportedQuestions([question], compiled).length === 0) {
        return {
            status: "unavailable",
            reason: "Not in this game",
        };
    }
    const blocked = restoreBlocked(removed, { lines });
    if (blocked) return { status: "unavailable", reason: blocked };
    return { status: "ok", question };
}

/**
 * What Restore did: the copies it put back (as the board now calls them,
 * and as put there, for an Undo to tell if they were changed since), and
 * how many were back already.
 */
export interface Restored {
    back: { label: string; key: number; question: Question }[];
    alreadyBack: number;
}

/**
 * Puts deleted questions back on the board where they were, under new keys
 * (asRestored). Goes through questions.set, so it saves and syncs like any
 * edit.
 */
export function restoreFromHistory(
    line: Pick<HistoryLine, "order">,
    targets: readonly RemovedQuestion[],
    // Every line loaded, for what other questions were restored as.
    lines: Lines = [],
): Restored {
    // A spectator's board isn't saved (as deleteQuestionsWithUndo).
    if (sessionReadOnly.get()) return { back: [], alreadyBack: 0 };
    const current = questions.get();
    const compiled = compiledGameAtom.get();
    let alreadyBack = 0;
    const restored = targets.flatMap((target) => {
        const check = restorable(target, current, compiled, lines);
        if (check.status !== "ok") {
            if (onBoardAs(target, current, lines) !== undefined) alreadyBack++;
            return [];
        }
        // A copy (asRestored): cards edit questions in place, and the parsed
        // one stays cached for this line's next Restore.
        return [
            {
                from: target.key,
                index: target.index,
                question: asRestored(check.question),
            },
        ];
    });
    const next = placeRestored(current, line.order ?? [], restored, lines);
    if (!next) return { back: [], alreadyBack };
    questions.set(next);
    return {
        back: restored.map((r) => ({
            label: boardLabel(next, r.question.key),
            key: r.question.key,
            question: structuredClone(r.question),
        })),
        alreadyBack,
    };
}

/** "14:05", with the day ("3 Nov") when it isn't today. */
export function formatHistoryTime(
    at: string,
    now = new Date(),
): { day: string | null; time: string } {
    const date = new Date(at);
    const time = date.toLocaleTimeString([], {
        hour: "numeric",
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
