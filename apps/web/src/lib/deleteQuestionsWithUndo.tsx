import { type Id, toast } from "react-toastify";

import {
    activeSessionId,
    editingInOtherTab,
    isSessionReadOnly,
    sessionReadOnly,
} from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { questionListSentSince } from "@/lib/eventQueue";
import {
    questionConflicts,
    questionDecisionsPossible,
    resolveQuestionConflict,
} from "@/lib/questionConflicts";
import { sameQuestionKey, sameQuestionSubstance } from "@/lib/questionMerge";
import { boardLabel } from "@/lib/questionNames";
import { showQuestionCard } from "@/lib/questionSidebarTab";
import {
    asRestored,
    backAs,
    deleteQuestions,
    placeRemovedQuestions,
    placeRestored,
    type QuestionDeletion,
} from "@/lib/questionUndo";
import {
    cancelPendingQuestionSave,
    flushQuestionSave,
    hasPendingQuestionSave,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import type { Question } from "@/maps/schema";

// Only the latest delete or restore can be undone: undoing an older one
// around a newer one is more confusing than useful.
let undoToastId: Id | null = null;

// A short toast with Undo, for the session it was shown in, closed once its
// user only spectates it or another tab takes it over. Undo goes through
// questions.set, so it saves and syncs like any edit.
function showUndoToast(
    text: string,
    onUndo: () => void,
    // Another button after Undo, such as Show.
    extra?: { label: string; onClick: () => void },
): void {
    if (undoToastId !== null) toast.dismiss(undoToastId);
    let stopListening = () => {};
    const id = toast(
        ({ closeToast }) => (
            <div className="flex w-full items-center gap-2">
                <span className="min-w-0 flex-1 break-words">{text}</span>
                <button
                    className="min-h-9 shrink-0 rounded-md border border-current px-3 text-sm font-semibold"
                    onClick={() => {
                        // The toast closes once the session is read-only
                        // here, but may still be on screen as it does.
                        if (!isSessionReadOnly(activeSessionId.get())) onUndo();
                        closeToast();
                    }}
                >
                    Undo
                </button>
                {extra && (
                    <button
                        className="min-h-9 shrink-0 rounded-md border border-current px-3 text-sm font-semibold"
                        onClick={() => {
                            extra.onClick();
                            closeToast();
                        }}
                    >
                        {extra.label}
                    </button>
                )}
            </div>
        ),
        {
            autoClose: 8000,
            closeOnClick: false,
            // Hovering still pauses it, but leaving the app doesn't: coming
            // back much later shouldn't find the Undo still there.
            pauseOnFocusLoss: false,
            onClose: () => {
                stopListening();
                if (undoToastId === id) undoToastId = null;
            },
        },
    );
    undoToastId = id;
    const stopSessionListener = activeSessionId.listen(() => toast.dismiss(id));
    const stopReadOnlyListener = sessionReadOnly.listen((readOnly) => {
        if (readOnly) toast.dismiss(id);
    });
    const stopTakeOverListener = editingInOtherTab.listen((takenOver) => {
        if (takenOver) toast.dismiss(id);
    });
    stopListening = () => {
        stopSessionListener();
        stopReadOnlyListener();
        stopTakeOverListener();
    };
}

/** A delete that can still be undone, and when it was made. */
export interface PendingUndo {
    deletion: QuestionDeletion<Question>;
    deletedAt: number;
}

/** What an Undo did: old key to new (the same when put back as they were). */
export interface UndoneDeletion {
    placed: { from: number; key: number }[];
    // Already on the board, so not put back again.
    alreadyBack: number;
}

/**
 * Puts a delete's questions back where they were, or null in another
 * session or on a read-only board (a spectator's, or one another tab took
 * the session over from). One already back (under its key, or as a
 * copy: a teammate's restore of it) isn't put back again. One a teammate
 * edited meanwhile, held for a decision ("we deleted it"), comes back as
 * they left it: Undo takes the delete back, as Keep theirs does.
 *
 * While no question list made since the delete has been sent, it is undone
 * outright: the questions go back under their keys, and the server never
 * hears of the delete. Once one may have landed, they go back as copies
 * under new keys, as Restore puts them: the same key back would be merged
 * away again by a list made before the delete (see asRestored).
 */
export function undoQuestionDeletion(
    { deletion, deletedAt }: PendingUndo,
    newKey?: () => number,
): UndoneDeletion | null {
    if (isSessionReadOnly(deletion.sessionId)) return null;
    if (activeSessionId.get() !== deletion.sessionId) return null;
    const before = questions.get();
    // Held as "we deleted it": their version stands, and goes on the board.
    for (const { key, mine } of questionConflicts.get()) {
        if (
            mine === null &&
            deletion.removed.some(({ question }) =>
                sameQuestionKey(question.key, key),
            )
        ) {
            resolveQuestionConflict(deletion.sessionId, key, "theirs");
        }
    }
    const current = questions.get();
    const missing = deletion.removed.filter(
        ({ question }) => !backAs(question, current, deletion.order),
    );
    // Back before this Undo: one it put back as theirs isn't.
    const alreadyBack = deletion.removed.filter(({ question }) =>
        backAs(question, before, deletion.order),
    ).length;
    if (missing.length === 0) return { placed: [], alreadyBack };
    if (!questionListSentSince(deletion.sessionId, deletedAt)) {
        const next = placeRemovedQuestions(current, deletion.order, missing);
        if (!next) return { placed: [], alreadyBack };
        // The delete's own list may still be waiting: in the debounce, or
        // queued behind a list on its way. Sent, it would take the delete
        // to the server after all, so the undone board takes its place now.
        // (SessionManager schedules the board's save only after it redraws,
        // too late to replace it; that save is the same board again.)
        // Only while the board's edits are saved at all (SessionManager's
        // own guards), as for Restore.
        const sessionId = deletion.sessionId;
        const waiting =
            questionDecisionsPossible.get() &&
            hasPendingQuestionSave(sessionId);
        if (waiting) cancelPendingQuestionSave(sessionId);
        questions.set(next);
        if (waiting) {
            saveQuestionsDebounced(sessionId, next);
            void flushQuestionSave(sessionId).catch((err) => {
                console.warn("[undo] couldn't save the undone delete:", err);
            });
        }
        return {
            placed: missing.map(({ question }) => ({
                from: question.key,
                key: question.key,
            })),
            alreadyBack,
        };
    }
    const restored = missing.map(({ question, index }) => ({
        from: question.key,
        index,
        question: asRestored(question, newKey?.()),
    }));
    const next = placeRestored(current, deletion.order, restored);
    if (!next) return { placed: [], alreadyBack };
    questions.set(next);
    return {
        placed: restored.map(({ from, question }) => ({
            from,
            key: question.key,
        })),
        alreadyBack,
    };
}

/** Undo or Restore found the questions back already: say so. */
export function showAlreadyOnBoard(): void {
    toast("Already on the board", { autoClose: 3000 });
}

/**
 * Deletes the questions, then offers to put them back for a few seconds
 * (undoQuestionDeletion). Returns the delete, or null when nothing was.
 */
export const deleteQuestionsWithUndo = (
    keys: Iterable<number>,
): PendingUndo | null => {
    if (isSessionReadOnly(activeSessionId.get())) return null;
    const board = questions.get();
    const { remaining, deletion } = deleteQuestions(
        board,
        new Set(keys),
        activeSessionId.get(),
    );
    const count = deletion.removed.length;
    if (count === 0) return null;
    const pending: PendingUndo = { deletion, deletedAt: Date.now() };
    // As its card said it, before the delete shifted the positions.
    const label =
        count === 1 ? boardLabel(board, deletion.removed[0].question.key) : "";
    questions.set(remaining);
    showUndoToast(
        count === 1
            ? `${label || "Question"} deleted`
            : `${count} questions deleted`,
        () => {
            const undone = undoQuestionDeletion(pending);
            if (undone && undone.placed.length === 0 && undone.alreadyBack) {
                showAlreadyOnBoard();
            }
        },
    );
    return pending;
};

/**
 * Says which questions Restore put back ("Radius 2 is back"): on a phone the
 * History covers the board. Its Undo takes back those copies, but not one
 * changed since (by anyone): that stays, and the toast says so.
 */
export function showRestoredToast(
    restored: readonly { label: string; key: number; question: unknown }[],
): void {
    if (restored.length === 0) return;
    const sessionId = activeSessionId.get();
    showUndoToast(
        restored.length === 1
            ? `${restored[0].label || "The question"} is back`
            : `${restored.length} questions are back`,
        () => {
            if (activeSessionId.get() !== sessionId) return;
            const { next, changed } = withoutRestored(
                questions.get(),
                restored,
            );
            if (next) questions.set(next);
            if (changed.length > 0) {
                toast(
                    changed.length === 1
                        ? `${changed[0]} was changed meanwhile, so it stays`
                        : `${changed.length} questions were changed meanwhile, so they stay`,
                    { autoClose: 4000 },
                );
            }
        },
        { label: "Show", onClick: () => showQuestionCard(restored[0].key) },
    );
}

/**
 * The board without the copies Restore put back that are as it put them
 * (null when none is), and the labels of those changed since, which stay
 * (as that board calls them).
 */
function withoutRestored<T extends { key: number }>(
    board: readonly T[],
    restored: readonly { key: number; question: unknown }[],
): { next: T[] | null; changed: string[] } {
    const stay: T[] = [];
    const remove = new Set<T>();
    for (const r of restored) {
        const now = board.find((q) => sameQuestionKey(q.key, r.key));
        if (!now) continue;
        if (sameQuestionSubstance(now, r.question)) remove.add(now);
        else stay.push(now);
    }
    const next = remove.size > 0 ? board.filter((q) => !remove.has(q)) : null;
    return {
        next,
        changed: stay.map(
            (q) => boardLabel(next ?? board, q.key) || "A question",
        ),
    };
}
