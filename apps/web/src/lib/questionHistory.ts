import type { QuestionHistoryResponse } from "@searchlight/shared";
import { atom } from "nanostores";

import type { CompiledGame } from "@/game-definition/compile";
import {
    compiledGameAtom,
    filterSupportedQuestions,
} from "@/game-definition/store";
import {
    activeSessionId,
    sessionReadOnly,
    verifiedUserId,
} from "@/lib/activeSession";
import { questions } from "@/lib/context";
import type { HistoryLine, RemovedQuestion } from "@/lib/historyLines";
import {
    questionConflicts,
    questionDecisionsPossible,
} from "@/lib/questionConflicts";
import { sameQuestionKey } from "@/lib/questionMerge";
import { boardLabel } from "@/lib/questionNames";
import {
    asRestored,
    backAs,
    isCopyOf,
    placeRestored,
    standsFor,
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

// ── The history as loaded, kept while the History is hidden ──────────────

/**
 * The active session's history as loaded. Kept while the History is hidden
 * (on the Questions tab, or the sheet closed), so that opened again it shows
 * at once, offline too, and only asks for what came since. In memory only,
 * and dropped for another session or account.
 */
export interface LoadedHistory {
    sessionId: string;
    history: QuestionHistoryResponse;
    /** The last refresh failed: what's shown may be behind. */
    refreshFailed: boolean;
}

export const loadedHistory = atom<LoadedHistory | null>(null);

// Bumped whenever the loaded history is replaced (another session or
// account, or the newest page loaded afresh): responses asked for before are
// dropped. Here rather than in the History, as one can arrive while it's
// hidden, and still counts.
let generation = 0;

const forgetHistory = () => {
    generation++;
    loadedHistory.set(null);
};
activeSessionId.listen(forgetHistory);
verifiedUserId.listen(forgetHistory);
// A spectator's history has no deleted questions in full, to restore: made
// a player (or back), it's loaded again.
sessionReadOnly.listen(forgetHistory);

/** The history loaded for this session, if any. */
export const historyOf = (
    sessionId: string,
    loaded: LoadedHistory | null = loadedHistory.get(),
): LoadedHistory | null => (loaded?.sessionId === sessionId ? loaded : null);

const updateHistory = (
    sessionId: string,
    change: (loaded: LoadedHistory) => LoadedHistory,
) => {
    const loaded = historyOf(sessionId);
    if (loaded) loadedHistory.set(change(loaded));
};

// The response to a request made while `gen` was current, or "stale" when
// it no longer counts. Throws what the request threw, if it still counts.
async function unlessStale<T>(
    gen: number,
    request: Promise<T>,
): Promise<T | "stale"> {
    try {
        const response = await request;
        return gen === generation ? response : "stale";
    } catch (error) {
        if (gen !== generation) return "stale";
        throw error;
    }
}

/**
 * Loads the newest page afresh, without the older ones loaded. False when
 * the answer came too late to count; throws when the request failed.
 */
export async function loadNewestHistory(sessionId: string): Promise<boolean> {
    const gen = ++generation;
    const history = await unlessStale(gen, fetchQuestionHistory(sessionId));
    if (history === "stale") return false;
    loadedHistory.set({ sessionId, history, refreshFailed: false });
    return true;
}

/**
 * Puts the saves since the newest one loaded on top. "more" when nothing
 * is loaded, or more came since than one answer holds: load the newest page
 * instead. A failed request is noted (refreshFailed) and thrown.
 */
export async function loadNewerHistory(
    sessionId: string,
): Promise<"added" | "more" | "stale"> {
    const loaded = historyOf(sessionId);
    if (!loaded) return "more";
    let page: QuestionHistoryResponse | "stale";
    try {
        page = await unlessStale(
            generation,
            fetchQuestionHistory(sessionId, {
                after: loaded.history.newest ?? 0,
            }),
        );
    } catch (error) {
        updateHistory(sessionId, (current) => ({
            ...current,
            refreshFailed: true,
        }));
        throw error;
    }
    if (page === "stale") return "stale";
    if (page.more) return "more";
    const newer = page;
    updateHistory(sessionId, (current) => ({
        ...current,
        history: prependNewer(current.history, newer),
        refreshFailed: false,
    }));
    return "added";
}

/**
 * Puts the page before the oldest one loaded below it. False when there's
 * none, or the answer came too late to count; throws when the request
 * failed.
 */
export async function loadOlderHistory(sessionId: string): Promise<boolean> {
    const before = historyOf(sessionId)?.history.nextBefore;
    if (!before) return false;
    const page = await unlessStale(
        generation,
        fetchQuestionHistory(sessionId, { before }),
    );
    if (page === "stale") return false;
    // Only below the page it was asked for.
    updateHistory(sessionId, (current) =>
        current.history.nextBefore === before
            ? { ...current, history: appendOlderPage(current.history, page) }
            : current,
    );
    return true;
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
 * player still has to decide about it, or about a copy of it: Restore would
 * decide for them. Nor while no decision can be taken (the board is loading
 * another session, or offline on a board not kept): what Restore put there
 * wouldn't be saved.
 */
export function restoreBlocked(
    {
        key,
        question,
        order = [],
    }: Pick<RemovedQuestion, "key" | "question" | "order">,
    {
        held = questionConflicts.get(),
        decisionsPossible = questionDecisionsPossible.get(),
    }: {
        held?: readonly { key: number; base?: unknown }[];
        decisionsPossible?: boolean;
    } = {},
): string | null {
    // A question on the board beside it when it was deleted is another
    // one, and so is a copy of that (as backAs).
    if (
        held.some(
            (c) =>
                sameQuestionKey(c.key, key) ||
                standsFor({ ...(c.base as object), key: c.key }, key, order) ||
                (isCopyOf(question, c.key) &&
                    !order.some((k) => sameQuestionKey(k, c.key))),
        )
    ) {
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
    removed: Pick<RemovedQuestion, "key" | "question" | "order">,
    current: readonly { key: number }[],
    compiled: Pick<CompiledGame, "questionMap"> | null,
): Restorable {
    const back = backAs(removed, current, removed.order);
    if (back) {
        // As the board calls it now: "Radius 2" may be another question
        // since the delete shifted the positions.
        const label = boardLabel(current, back.key);
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
            reason: "Not in this game",
        };
    }
    const blocked = restoreBlocked(removed);
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
): Restored {
    // A spectator's board isn't saved (as deleteQuestionsWithUndo).
    if (sessionReadOnly.get()) return { back: [], alreadyBack: 0 };
    const current = questions.get();
    const compiled = compiledGameAtom.get();
    let alreadyBack = 0;
    const restored = targets.flatMap((target) => {
        const check = restorable(target, current, compiled);
        if (check.status !== "ok") {
            if (backAs(target, current, target.order)) alreadyBack++;
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
    const next = placeRestored(current, line.order ?? [], restored);
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
