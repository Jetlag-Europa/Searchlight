import { describe, expect, it } from "vitest";

import {
    asRestored,
    deleteQuestions,
    placeRemovedQuestions,
    placeRestored,
    undoDeletion,
    withoutCopiesOf,
} from "@/lib/questionUndo";
import { questionSchema } from "@/maps/schema";

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

describe("putting restored questions back", () => {
    const copy = (key: number, of: number[]) => ({
        key,
        data: { restoredFrom: of },
    });
    const plain = (key: number) => ({ key, data: {} });

    it("goes below the question above it, not below a copy of that one", () => {
        const board = [copy(5, [1]), plain(9), plain(1)];
        expect(
            keys(
                placeRestored(
                    board,
                    [1, 7],
                    [{ from: 7, index: 1, question: plain(7) }],
                )!,
            ),
        ).toEqual([5, 9, 1, 7]);
    });

    it("goes below a copy of the question above it, a copy of a copy too", () => {
        const board = [copy(3, [1, 2]), plain(9)];
        expect(
            keys(
                placeRestored(
                    board,
                    [2, 7, 9],
                    [{ from: 7, index: 1, question: plain(7) }],
                )!,
            ),
        ).toEqual([3, 7, 9]);
    });

    it("doesn't go below a copy that was another question on the board", () => {
        // 4 was a copy of 1 beside it, edited apart; 1 went since.
        const board = [plain(3), copy(4, [1])];
        expect(
            keys(
                placeRestored(
                    board,
                    [1, 2, 3, 4],
                    [{ from: 2, index: 1, question: plain(2) }],
                )!,
            ),
        ).toEqual([2, 3, 4]);
    });
});

describe("dropping copies of a question kept", () => {
    it("drops one as Restore re-read it, defaults filled in", () => {
        // Saved by an older build: no `enabled`.
        const was = {
            id: "radius",
            key: 0.5,
            data: {
                lat: 1,
                lng: 2,
                radius: 5,
                unit: "kilometers",
                within: true,
                color: "red",
            },
        };
        const copy = asRestored(questionSchema.parse(was), 0.75);
        const kept = { ...was, data: { ...was.data, within: false } };
        expect(keys(withoutCopiesOf([kept, copy], 0.5, was))).toEqual([0.5]);
        const moved = { ...copy, data: { ...copy.data, lat: 3 } };
        expect(keys(withoutCopiesOf([kept, moved], 0.5, was))).toEqual([
            0.5, 0.75,
        ]);
    });
});

describe("putting deleted questions back with drifted keys", () => {
    // The next double up: a key saved and read back one ulp off.
    const nextUp = (x: number) => {
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, x);
        view.setBigUint64(0, view.getBigUint64(0) + 1n);
        return view.getFloat64(0);
    };
    const [A, B, C] = [0.12345678901234566, 0.22222222222222222, 0.33];

    it("anchors below a question whose key drifted", () => {
        const board = [q(nextUp(A)), q(C)];
        expect(
            keys(
                placeRemovedQuestions(
                    board,
                    [A, B, C],
                    [{ question: q(B), index: 1 }],
                )!,
            ),
        ).toEqual([nextUp(A), B, C]);
    });

    it("doesn't undo a delete twice when the question came back with a drifted key", () => {
        const { remaining, deletion } = deleteQuestions(
            [q(A), q(B)],
            new Set([A]),
            "s1",
        );
        // Restored from History meanwhile, and read back one ulp off.
        const current = [q(nextUp(A)), ...remaining];
        expect(undoDeletion(current, deletion, "s1")).toBeNull();
    });
});
