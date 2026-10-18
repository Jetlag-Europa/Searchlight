import { describe, expect, it } from "vitest";

import { deleteQuestions, undoDeletion } from "@/lib/questionUndo";

const q = (key: number, label = String(key)) => ({ key, label });
const keys = (list: { key: number }[]) => list.map((x) => x.key);

describe("undoing a question delete", () => {
    it("puts a deleted question back where it was", () => {
        const list = [q(1), q(2), q(3)];
        const { remaining, deletion } = deleteQuestions(
            list,
            new Set([2]),
            "s1",
        );
        expect(keys(remaining)).toEqual([1, 3]);
        expect(undoDeletion(remaining, deletion, "s1")).toEqual(list);
    });

    it("restores Delete All in the original order", () => {
        const list = [q(1), q(2), q(3), q(4)];
        const { remaining, deletion } = deleteQuestions(
            list,
            new Set(keys(list)),
            "s1",
        );
        expect(remaining).toEqual([]);
        expect(undoDeletion(remaining, deletion, "s1")).toEqual(list);
        // Inserted by ascending index, whatever order they were stored in.
        const shuffled = {
            ...deletion,
            removed: [...deletion.removed].reverse(),
        };
        expect(keys(undoDeletion([], shuffled, "s1")!)).toEqual([1, 2, 3, 4]);
    });

    it("keeps changes made to the list meanwhile", () => {
        const { remaining, deletion } = deleteQuestions(
            [q(1), q(2), q(3), q(4)],
            new Set([2, 4]),
            "s1",
        );
        // A teammate renamed 1, deleted 3 and added 5.
        const current = [q(1, "renamed"), q(5)];
        expect(keys(remaining)).toEqual([1, 3]);
        const restored = undoDeletion(current, deletion, "s1")!;
        // 4 goes below 2, the nearest question above it that is still there.
        expect(keys(restored)).toEqual([1, 2, 4, 5]);
        expect(restored[0].label).toBe("renamed");
    });

    it("keeps the order when questions above were deleted meanwhile", () => {
        const { remaining, deletion } = deleteQuestions(
            [q(1), q(2), q(3), q(4), q(5)],
            new Set([4]),
            "s1",
        );
        // A teammate deleted 1 and 2: index 3 is now past 5.
        const current = remaining.filter((x) => x.key > 2);
        expect(keys(undoDeletion(current, deletion, "s1")!)).toEqual([3, 4, 5]);
    });

    it("keeps the order when deletes are undone oldest first", () => {
        const first = deleteQuestions([q(1), q(2), q(3)], new Set([2]), "s1");
        const second = deleteQuestions(first.remaining, new Set([1]), "s1");
        const afterFirstUndo = undoDeletion(
            second.remaining,
            first.deletion,
            "s1",
        )!;
        expect(keys(afterFirstUndo)).toEqual([2, 3]);
        expect(
            keys(undoDeletion(afterFirstUndo, second.deletion, "s1")!),
        ).toEqual([1, 2, 3]);
    });

    it("puts a question at the top when nothing above it is left", () => {
        const { deletion } = deleteQuestions(
            [q(1), q(2), q(3)],
            new Set([3]),
            "s1",
        );
        expect(keys(undoDeletion([q(4)], deletion, "s1")!)).toEqual([3, 4]);
    });

    it("skips questions that are back already", () => {
        const { remaining, deletion } = deleteQuestions(
            [q(1), q(2), q(3)],
            new Set([1, 3]),
            "s1",
        );
        // Another tab's Undo, synced: 3 is back.
        const current = [...remaining, q(3, "theirs")];
        const restored = undoDeletion(current, deletion, "s1")!;
        expect(keys(restored)).toEqual([1, 2, 3]);
        expect(restored[2].label).toBe("theirs");
        expect(undoDeletion(restored, deletion, "s1")).toBeNull();
    });

    it("does nothing once another session is active", () => {
        const { remaining, deletion } = deleteQuestions(
            [q(1), q(2)],
            new Set([1]),
            "s1",
        );
        expect(undoDeletion(remaining, deletion, "s2")).toBeNull();
        expect(undoDeletion(remaining, deletion, "")).toBeNull();
    });
});
