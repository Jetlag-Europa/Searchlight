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
        expect(keys(restored)).toEqual([1, 2, 5, 4]);
        expect(restored[0].label).toBe("renamed");
    });

    it("appends questions whose old position is past the end", () => {
        const { deletion } = deleteQuestions(
            [q(1), q(2), q(3)],
            new Set([3]),
            "s1",
        );
        expect(keys(undoDeletion([], deletion, "s1")!)).toEqual([3]);
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
