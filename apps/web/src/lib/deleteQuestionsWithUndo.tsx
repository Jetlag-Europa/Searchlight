import { type Id, toast } from "react-toastify";

import { activeSessionId } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { deleteQuestions, undoDeletion } from "@/lib/questionUndo";

// Only the latest delete can be undone: undoing an older one around a newer
// one is more confusing than useful.
let undoToastId: Id | null = null;

// Deletes the questions, then offers to put them back for a few seconds. Both
// go through questions.set, so they save and sync like any edit.
export const deleteQuestionsWithUndo = (keys: Iterable<number>) => {
    const { remaining, deletion } = deleteQuestions(
        questions.get(),
        new Set(keys),
        activeSessionId.get(),
    );
    const count = deletion.removed.length;
    if (count === 0) return;
    questions.set(remaining);

    if (undoToastId !== null) toast.dismiss(undoToastId);
    let stopListening = () => {};
    const id = toast(
        ({ closeToast }) => (
            <div className="flex w-full items-center justify-between gap-3">
                <span>
                    {count === 1
                        ? "Question deleted"
                        : `${count} questions deleted`}
                </span>
                <button
                    className="rounded-md border border-current px-3 py-1 text-sm font-semibold"
                    onClick={() => {
                        const next = undoDeletion(
                            questions.get(),
                            deletion,
                            activeSessionId.get(),
                        );
                        if (next) questions.set(next);
                        closeToast();
                    }}
                >
                    Undo
                </button>
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
    // Undo only applies to the session the questions were deleted from.
    stopListening = activeSessionId.listen(() => toast.dismiss(id));
};
