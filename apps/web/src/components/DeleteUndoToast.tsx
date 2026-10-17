import { toast } from "react-toastify";

import { activeSessionId } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { deleteQuestions, undoDeletion } from "@/lib/questionUndo";

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
            onClose: () => stopListening(),
        },
    );
    // Undo only applies to the session the questions were deleted from.
    stopListening = activeSessionId.listen(() => toast.dismiss(id));
};
