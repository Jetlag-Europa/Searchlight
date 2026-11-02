import { sameQuestionKey } from "@searchlight/shared";

// What a delete removed, for its Undo: the questions and the order of the list
// they were deleted from. Undo puts them back into the list as it is by then:
// a teammate may have edited, added or deleted questions meanwhile, and
// restoring the old list would wipe that.
export interface QuestionDeletion<T> {
    sessionId: string;
    order: number[];
    removed: { question: T; index: number }[];
}

export const deleteQuestions = <T extends { key: number }>(
    list: readonly T[],
    keys: ReadonlySet<number>,
    sessionId: string,
): { remaining: T[]; deletion: QuestionDeletion<T> } => ({
    remaining: list.filter((q) => !keys.has(q.key)),
    deletion: {
        sessionId,
        order: list.map((q) => q.key),
        removed: list.flatMap((question, index) =>
            keys.has(question.key) ? [{ question, index }] : [],
        ),
    },
});

// The list with the deleted questions back, or null when there is nothing to
// restore: the session changed, or every question is back already.
export const undoDeletion = <T extends { key: number }>(
    current: readonly T[],
    deletion: QuestionDeletion<T>,
    sessionId: string,
): T[] | null =>
    sessionId === deletion.sessionId
        ? placeRemovedQuestions(current, deletion.order, deletion.removed)
        : null;

// The list with removed questions put back, or null when they are all there
// already. Each goes right below the nearest question that was above it in
// `order` and is still there (or at the top), not at its old index: questions
// above may be gone by now. Order matters: a zone-size curse applies to the
// questions below it. Keys are compared allowing for a one-ulp drift: a
// question saved and read back by another client may come back that way.
export const placeRemovedQuestions = <T extends { key: number }>(
    current: readonly T[],
    order: readonly number[],
    removed: readonly { question: T; index: number }[],
): T[] | null => {
    const next = [...current];
    const at = (key: number) =>
        next.findIndex((q) => sameQuestionKey(q.key, key));
    let restored = false;
    // Top down, so one restored question can anchor the next.
    for (const { question, index } of [...removed].sort(
        (a, b) => a.index - b.index,
    )) {
        if (at(question.key) !== -1) continue;
        let position = 0;
        for (let i = index - 1; i >= 0; i--) {
            const above = at(order[i]);
            if (above !== -1) {
                position = above + 1;
                break;
            }
        }
        next.splice(position, 0, question);
        restored = true;
    }
    return restored ? next : null;
};
