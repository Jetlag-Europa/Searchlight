import { activeSessionId } from "@/lib/activeSession";
import type { HistoryLine, RemovedQuestion } from "@/lib/historyLines";
import { sameQuestionKey, sameQuestionSubstance } from "@/lib/questionMerge";
import { newQuestionKey } from "@/maps/schema";

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

// ── Putting deleted questions back as copies (Restore, and Undo once the
// delete may have reached the server) ─────────────────────────────────────────

/** The History's lines, for what each deleted question was restored as. */
export type Lines = readonly Pick<HistoryLine, "removed">[];

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
export function lineageKeys(
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

/** Every key some deleted question is known to have been restored as. */
export function restoredKeys(lines: Lines): number[] {
    return [
        ...lines.flatMap((line) =>
            (line.removed ?? []).flatMap((r) => r.restoredAs ?? []),
        ),
        ...pairsHere().map(([, to]) => to),
    ];
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

/** The key a deleted question is on the board under now, if it is. */
export function onBoardAs(
    removed: Pick<RemovedQuestion, "key" | "restoredAs">,
    board: readonly { key: number }[],
    lines: Lines = [],
): number | undefined {
    for (const key of lineageKeys(removed, lines)) {
        const found = board.find((q) => sameQuestionKey(q.key, key));
        if (found) return found.key;
    }
    return undefined;
}

/**
 * The key a deleted question is back on the board under, if it is: as
 * onBoardAs says, or as a teammate's restore the History hasn't loaded yet.
 * That is a question with its content that wasn't on the board when it was
 * deleted (a twin that was is another question), and isn't known as another
 * one's restore. Restoring again would make two. `parsed` is the deleted
 * question as the app reads it, if it does: compared too.
 */
export function alreadyBackAs(
    removed: Pick<RemovedQuestion, "key" | "restoredAs" | "question" | "order">,
    board: readonly { key: number }[],
    lines: Lines = [],
    parsed: unknown = null,
): number | undefined {
    const now = onBoardAs(removed, board, lines);
    if (now !== undefined || !removed.order) return now;
    const claimed = [...removed.order, ...restoredKeys(lines)];
    return board.find(
        (q) =>
            !claimed.some((key) => sameQuestionKey(key, q.key)) &&
            (sameQuestionSubstance(q, removed.question) ||
                (parsed !== null && sameQuestionSubstance(q, parsed))),
    )?.key;
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
