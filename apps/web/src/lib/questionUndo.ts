import { sameQuestionKey, sameQuestionSubstance } from "@/lib/questionMerge";
import { newQuestionKey, questionSchema } from "@/maps/schema";

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

// ── Putting deleted questions back as copies (Restore, and Undo once the
// delete may have reached the server) ─────────────────────────────────────────

// The keys of the questions `question` is a copy of, oldest first: what it
// was restored from, what that was restored from, and so on.
const restoredFrom = (question: unknown): number[] => {
    const from = (question as { data?: { restoredFrom?: unknown } } | null)
        ?.data?.restoredFrom;
    return Array.isArray(from)
        ? from.filter((key): key is number => typeof key === "number")
        : [];
};

/** Whether `question` is a copy of the one with `key`, or of a copy of it. */
export const isCopyOf = (question: unknown, key: number): boolean =>
    restoredFrom(question).some((from) => sameQuestionKey(from, key));

/**
 * A deleted question as Restore puts it back: a copy under a new key, with
 * everything else as it was. To every merge it is then a question added,
 * not the deleted one coming back, which a list made before the delete
 * would read as unchanged and delete again. It says what it is a copy of
 * (restoredFrom), so every device can tell the deleted one is back.
 */
export function asRestored<T extends { key: number; data: object }>(
    question: T,
    key: number = newQuestionKey(),
): T {
    const copy = structuredClone(question);
    return {
        ...copy,
        key,
        data: {
            ...copy.data,
            restoredFrom: [...restoredFrom(question), question.key],
        },
    };
}

// Whether `q` is the question with `key` or a copy of it, and not one of
// another question in `beside` (on the board beside it) or a copy of that.
export function standsFor(
    q: { key: number },
    key: number,
    beside: readonly number[],
): boolean {
    const lineage = [...restoredFrom(q), q.key];
    const at = lineage.findIndex((k) => sameQuestionKey(k, key));
    return (
        at !== -1 &&
        !lineage
            .slice(at + 1)
            .some((k) => beside.some((other) => sameQuestionKey(other, k)))
    );
}

/**
 * The question a deleted one is back on the board as, if it is: under its
 * key (Undo put it back), or a copy of it, edited since or not. Not one that
 * was itself on the board when it was deleted (`order`), nor a copy of such
 * a one: that is another question.
 */
export function backAs<T extends { key: number }>(
    removed: { key: number },
    board: readonly T[],
    order: readonly number[] = [],
): T | undefined {
    return (
        board.find((q) => sameQuestionKey(q.key, removed.key)) ??
        board.find((q) => standsFor(q, removed.key, order))
    );
}

/**
 * The board with restored questions put back where they were in `order`
 * (as Undo does), or null when there's nothing to put back. A key in
 * `order` no longer on the board stands for a copy of it there, so
 * questions restored one by one keep their order.
 */
export function placeRestored<T extends { key: number }>(
    current: readonly T[],
    order: readonly number[],
    restored: readonly { from: number; index: number; question: T }[],
): T[] | null {
    const placed = order.map(
        (key) =>
            restored.find((r) => sameQuestionKey(r.from, key))?.question.key ??
            backAs({ key }, current, order)?.key ??
            key,
    );
    return placeRemovedQuestions(current, placed, restored);
}

/**
 * `board` without the copies of the question with `key` that are as `was`,
 * the version it was deleted from (or as Restore re-read it, defaults filled
 * in): kept, the question itself is back, and they would be a second
 * version of it shaping the zone. A copy changed since is someone's edit,
 * and stays, as do those in `beside`, on the board beside it before.
 */
export function withoutCopiesOf<T extends { key: number }>(
    board: readonly T[],
    key: number,
    was: unknown,
    beside: readonly number[] = [],
): T[] {
    const untagged = (q: unknown) => ({
        ...(q as object),
        data: { ...(q as { data?: object }).data, restoredFrom: undefined },
    });
    const reread = questionSchema.safeParse(was);
    const versions = [was, ...(reread.success ? [reread.data] : [])].map(
        untagged,
    );
    return board.filter(
        (q) =>
            sameQuestionKey(q.key, key) ||
            !standsFor(q, key, beside) ||
            !versions.some((v) => sameQuestionSubstance(untagged(q), v)),
    );
}
