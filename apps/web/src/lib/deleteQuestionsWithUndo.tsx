import { type Id, toast } from "react-toastify";

import { activeSessionId, sessionReadOnly } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { questionListSentSince } from "@/lib/eventQueue";
import { asRestored, isOnBoard, placeRestored } from "@/lib/questionHistory";
import { sameQuestionKey, sameQuestionSubstance } from "@/lib/questionMerge";
import { boardLabel } from "@/lib/questionNames";
import { showQuestionCard } from "@/lib/questionSidebarTab";
import {
    deleteQuestions,
    type QuestionDeletion,
    undoDeletion,
} from "@/lib/questionUndo";
import { flushQuestionSave } from "@/lib/sessionState";
import type { Question } from "@/maps/schema";

// Only the latest delete or restore can be undone: undoing an older one
// around a newer one is more confusing than useful.
let undoToastId: Id | null = null;

// A short toast with Undo, for the session it was shown in, closed once its
// user only spectates it. Undo goes through questions.set, so it saves and
// syncs like any edit.
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
            <div className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0 break-words">{text}</span>
                <button
                    className="shrink-0 rounded-md border border-current px-3 py-1 text-sm font-semibold"
                    onClick={() => {
                        // The toast closes once its user only spectates the
                        // session, but may still be on screen as it does.
                        if (!sessionReadOnly.get()) onUndo();
                        closeToast();
                    }}
                >
                    Undo
                </button>
                {extra && (
                    <button
                        className="shrink-0 rounded-md border border-current px-3 py-1 text-sm font-semibold"
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
    stopListening = () => {
        stopSessionListener();
        stopReadOnlyListener();
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
 * session or for a spectator. One already back (under its key, as what it
 * was restored as here, or as a teammate's restore of it) isn't put back
 * again.
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
    if (sessionReadOnly.get()) return null;
    if (activeSessionId.get() !== deletion.sessionId) return null;
    const current = questions.get();
    // Questions on the board that weren't there when it was deleted: a
    // teammate's restore of it, within the seconds Undo lasts. Not a twin
    // that was there all along.
    const since = current.filter(
        (q) => !deletion.order.some((key) => sameQuestionKey(key, q.key)),
    );
    const missing = deletion.removed.filter(({ question }) => {
        // Back under its key, or as what it was restored as here.
        if (isOnBoard({ key: question.key }, current)) return false;
        const twin = since.findIndex((q) => sameQuestionSubstance(q, question));
        if (twin === -1) return true;
        // Each one stands for one deleted question.
        since.splice(twin, 1);
        return false;
    });
    const alreadyBack = deletion.removed.length - missing.length;
    if (missing.length === 0) return { placed: [], alreadyBack };
    if (!questionListSentSince(deletion.sessionId, deletedAt)) {
        const next = undoDeletion(
            current,
            { ...deletion, removed: missing },
            deletion.sessionId,
        );
        if (!next) return { placed: [], alreadyBack };
        questions.set(next);
        // Queued now, in place of a list made since the delete but not sent
        // yet (another was on its way): sent after this, that list would
        // take the delete to the server after all.
        void flushQuestionSave(deletion.sessionId).catch((err) => {
            console.warn("[undo] couldn't save the undone delete:", err);
        });
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
    if (sessionReadOnly.get()) return null;
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
 * Says which questions Restore put back ("Radius 1 is back"): on a phone the
 * History covers the board. Its Undo takes back exactly those copies.
 */
export function showRestoredToast(
    restored: readonly { label: string; key: number }[],
): void {
    if (restored.length === 0) return;
    const sessionId = activeSessionId.get();
    showUndoToast(
        restored.length === 1
            ? `${restored[0].label} is back`
            : `${restored.length} questions are back`,
        () => {
            if (activeSessionId.get() !== sessionId) return;
            const current = questions.get();
            const next = current.filter(
                (q) => !restored.some((r) => sameQuestionKey(r.key, q.key)),
            );
            if (next.length !== current.length) questions.set(next);
        },
        { label: "Show", onClick: () => showQuestionCard(restored[0].key) },
    );
}
