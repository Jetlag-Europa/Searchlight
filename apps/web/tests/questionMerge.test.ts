import { describe, expect, test } from "vitest";

import {
    mergeQuestionLists,
    sameQuestion,
    sameQuestionList,
} from "@/lib/questionMerge";

const q = (key: number, label = "a") => ({ id: "radius", key, data: { label } });

describe("merging question lists", () => {
    test("keeps a question added elsewhere next to ours (the clobbered-offline case)", () => {
        // Offline from an empty list we add a radius; another device added one.
        expect(mergeQuestionLists([], [q(1)], [q(2)])).toEqual([q(1), q(2)]);
    });

    test("applies our additions, changes and removals", () => {
        const base = [q(1), q(2), q(3)];
        const local = [q(1, "ours"), q(3), q(4)];
        expect(mergeQuestionLists(base, local, base)).toEqual(local);
    });

    test("keeps their changes and removals to questions we left alone", () => {
        const base = [q(1), q(2), q(3)];
        const server = [q(1, "theirs"), q(3)];
        expect(mergeQuestionLists(base, base, server)).toEqual(server);
    });

    test("keeps our version of a question both sides changed", () => {
        expect(
            mergeQuestionLists([q(1)], [q(1, "ours")], [q(1, "theirs")]),
        ).toEqual([q(1, "ours")]);
    });

    test("keeps a question we removed that they changed, with their change", () => {
        expect(mergeQuestionLists([q(1), q(2)], [q(2)], [q(1, "theirs"), q(2)])).toEqual([
            q(2),
            q(1, "theirs"),
        ]);
    });

    test("drops a question removed on both sides", () => {
        expect(mergeQuestionLists([q(1), q(2)], [q(2)], [q(2)])).toEqual([q(2)]);
    });

    test("is the server's list when nothing changed here", () => {
        const server = [q(3), q(1, "theirs")];
        expect(mergeQuestionLists([q(1)], [q(1)], server)).toEqual([
            q(1, "theirs"),
            q(3),
        ]);
    });

    test("is our list when nothing changed there", () => {
        expect(mergeQuestionLists([q(1)], [q(2), q(1)], [q(1)])).toEqual([
            q(2),
            q(1),
        ]);
    });

    test("reads stored payloads with reordered keys as unchanged", () => {
        const stored = { data: { label: "a" }, key: 1, id: "radius" };
        expect(sameQuestion(q(1), stored)).toBe(true);
        expect(mergeQuestionLists([stored], [q(1)], [stored, q(2)])).toEqual([
            stored,
            q(2),
        ]);
        expect(sameQuestionList([q(1)], [stored])).toBe(true);
        expect(sameQuestionList([q(1)], [q(1, "b")])).toBe(false);
    });

    test("tells keyless questions apart by content", () => {
        const a = { id: "zone-size", data: { size: 1 } };
        const b = { id: "zone-size", data: { size: 2 } };
        expect(mergeQuestionLists([a], [a], [a, b])).toEqual([a, b]);
        expect(mergeQuestionLists([a], [], [a])).toEqual([]);
    });
});
