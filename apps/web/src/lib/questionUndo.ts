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
// restore: the session changed, or every question is back already. Each goes
// right below the nearest question that was above it and is still there (or at
// the top), not at its old index: questions above may be gone by now. Order
// matters: a zone-size curse applies to the questions below it.
export const undoDeletion = <T extends { key: number }>(
    current: readonly T[],
    deletion: QuestionDeletion<T>,
    sessionId: string,
): T[] | null => {
    if (sessionId !== deletion.sessionId) return null;
    const next = [...current];
    let restored = false;
    // Top down, so one restored question can anchor the next.
    for (const { question, index } of [...deletion.removed].sort(
        (a, b) => a.index - b.index,
    )) {
        if (next.some((q) => q.key === question.key)) continue;
        let at = 0;
        for (let i = index - 1; i >= 0; i--) {
            const above = next.findIndex((q) => q.key === deletion.order[i]);
            if (above !== -1) {
                at = above + 1;
                break;
            }
        }
        next.splice(at, 0, question);
        restored = true;
    }
    return restored ? next : null;
};
