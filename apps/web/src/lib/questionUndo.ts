// What a delete removed, for its Undo. Each question keeps the index it had,
// so Undo can put it back into the list as it is by then: a teammate may have
// edited, added or deleted questions meanwhile, and restoring the old list
// would wipe that.
export interface QuestionDeletion<T> {
    sessionId: string;
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
        removed: list.flatMap((question, index) =>
            keys.has(question.key) ? [{ question, index }] : [],
        ),
    },
});

// The list with the deleted questions back at their old positions (or at the
// end, if it has shrunk since), or null when there is nothing to restore: the
// session changed, or every question is back already. Ascending order matters:
// a zone-size curse applies to the questions below it.
export const undoDeletion = <T extends { key: number }>(
    current: readonly T[],
    deletion: QuestionDeletion<T>,
    sessionId: string,
): T[] | null => {
    if (sessionId !== deletion.sessionId) return null;
    const keys = new Set(current.map((q) => q.key));
    const next = [...current];
    let restored = false;
    for (const { question, index } of [...deletion.removed].sort(
        (a, b) => a.index - b.index,
    )) {
        if (keys.has(question.key)) continue;
        next.splice(Math.min(index, next.length), 0, question);
        keys.add(question.key);
        restored = true;
    }
    return restored ? next : null;
};
