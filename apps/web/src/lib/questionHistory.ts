import type { QuestionHistoryResponse } from "@searchlight/shared";

import type { CompiledGame } from "@/game-definition/compile";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import { activeSessionId, sessionReadOnly } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import type { HistoryLine, RemovedQuestion } from "@/lib/historyLines";
import {
    questionConflicts,
    questionDecisionsPossible,
} from "@/lib/questionConflicts";
import { sameQuestionKey } from "@/lib/questionMerge";
import { boardLabel } from "@/lib/questionNames";
import { placeRemovedQuestions } from "@/lib/questionUndo";
import { newQuestionKey, type Question, questionSchema } from "@/maps/schema";

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

type Lines = readonly Pick<HistoryLine, "removed">[];

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
    held: readonly { key: number }[] = questionConflicts.get(),
    decisionsPossible: boolean = questionDecisionsPossible.get(),
    lines: Lines = [],
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
    return online === false ? "Offline: try again when connected" : "Loading…";
}

/**
 * The note atop the History while this device has question changes not
 * saved yet: they aren't in the History until they are.
 */
export function unsavedChangesNote(pendingSave: boolean): string | null {
    return pendingSave
        ? "Your latest changes will show here once they're saved."
        : null;
}

/**
 * A deleted question as Restore puts it back: a copy under a new key, with
 * everything else as it was. To every merge it is then a question added,
 * not the deleted one coming back, which a list made before the delete
 * would read as unchanged and delete again.
 */
export function asRestored<T extends { key: number }>(
    question: T,
    key: number = newQuestionKey(),
): T {
    return { ...structuredClone(question), key };
}

// Restores made here, old key to new, for the session they were made in:
// the lines say so (restoredAs) only once the History has loaded the save.
let restoredHere: { sessionId: string; pairs: [number, number][] } = {
    sessionId: "",
    pairs: [],
};
const pairsHere = () => {
    const sessionId = activeSessionId.get();
    if (restoredHere.sessionId !== sessionId) {
        restoredHere = { sessionId, pairs: [] };
    }
    return restoredHere.pairs;
};

// The keys a deleted question has had: its own, what it was restored as,
// what that was restored as once deleted in turn, and so on, by every line
// loaded (its key may have been deleted more than once, put back by Undo)
// and by the restores made here since.
function lineageKeys(
    removed: Pick<RemovedQuestion, "key" | "restoredAs">,
    lines: Lines,
): number[] {
    const keys = [removed.key];
    const add = (key: number) => {
        if (!keys.some((k) => sameQuestionKey(k, key))) keys.push(key);
    };
    for (const key of removed.restoredAs ?? []) add(key);
    // Grows as it goes, until no new key turns up.
    for (let i = 0; i < keys.length; i++) {
        for (const line of lines) {
            for (const other of line.removed ?? []) {
                if (!sameQuestionKey(other.key, keys[i])) continue;
                for (const key of other.restoredAs ?? []) add(key);
            }
        }
        for (const [from, to] of pairsHere()) {
            if (sameQuestionKey(from, keys[i])) add(to);
        }
    }
    return keys;
}

const holds = (board: readonly { key: number }[], key: number) =>
    board.some((q) => sameQuestionKey(q.key, key));

/**
 * Whether a deleted question is on the board: under its key, or as the
 * question it was restored as (edited since or not).
 */
export function isOnBoard(
    removed: Pick<RemovedQuestion, "key" | "restoredAs">,
    board: readonly { key: number }[],
    lines: Lines = [],
): boolean {
    return onBoardAs(removed, board, lines) !== undefined;
}

// The key it is on the board under now, if it is.
function onBoardAs(
    removed: Pick<RemovedQuestion, "key" | "restoredAs">,
    board: readonly { key: number }[],
    lines: Lines,
): number | undefined {
    for (const key of lineageKeys(removed, lines)) {
        const found = board.find((q) => sameQuestionKey(q.key, key));
        if (found) return found.key;
    }
    return undefined;
}

/**
 * The board with restored questions put back where they were in `order`
 * (as Undo does), or null when there's nothing to put back. Keys in `order`
 * no longer on the board stand for what they were restored as, so questions
 * restored one by one keep their order. Remembers what each was restored
 * as, so the line says "On the board" before the History reloads.
 */
export function placeRestored<T extends { key: number }>(
    current: readonly T[],
    order: readonly number[],
    restored: readonly { from: number; index: number; question: T }[],
    lines: Lines = [],
): T[] | null {
    const placed = order.map((key) => {
        const now = restored.find((r) => sameQuestionKey(r.from, key));
        if (now) return now.question.key;
        if (holds(current, key)) return key;
        return (
            lineageKeys({ key }, lines).find((k) => holds(current, k)) ?? key
        );
    });
    const next = placeRemovedQuestions(current, placed, restored);
    if (next) {
        for (const r of restored) pairsHere().push([r.from, r.question.key]);
    }
    return next;
}

/**
 * Whether a deleted question can go back on the board, and why not. It is
 * re-read like a question from the server, so one saved by an older or newer
 * client, or one the game no longer has, isn't put back broken.
 */
export function restorable(
    removed: Pick<RemovedQuestion, "key" | "question" | "restoredAs">,
    current: readonly { key: number }[],
    compiled: Pick<CompiledGame, "questionMap"> | null,
    // Every line loaded, for what it was restored as since.
    lines: Lines = [],
): Restorable {
    const now = onBoardAs(removed, current, lines);
    if (now !== undefined) {
        // As the board calls it now: "Radius 2" may be another question
        // since the delete shifted the positions.
        const label = boardLabel(
            current as unknown as Parameters<typeof boardLabel>[0],
            now,
        );
        return {
            status: "unavailable",
            reason: label ? `On the board as ${label}` : "On the board",
        };
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
    const blocked = restoreBlocked(removed, undefined, undefined, lines);
    if (blocked) return { status: "unavailable", reason: blocked };
    return { status: "ok", question };
}

/** What Restore did: the questions it put back, and how many were back already. */
export interface Restored {
    back: { label: string; key: number }[];
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
            if (isOnBoard(target, current, lines)) alreadyBack++;
            return [];
        }
        // A copy (asRestored): cards edit questions in place, and the parsed
        // one stays cached for this line's next Restore.
        return [
            {
                from: target.key,
                index: target.index,
                label: target.label,
                question: asRestored(check.question),
            },
        ];
    });
    const next = placeRestored(current, line.order ?? [], restored, lines);
    if (!next) return { back: [], alreadyBack };
    questions.set(next);
    return {
        back: restored.map((r) => ({ label: r.label, key: r.question.key })),
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
