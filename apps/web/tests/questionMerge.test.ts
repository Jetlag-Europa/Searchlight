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

// A radius question as the cards keep it: answer fields and device fields.
const radius = (key: number, data: Record<string, unknown> = {}) => ({
    id: "radius",
    key,
    data: { lat: 47, lng: 8, radius: 5, within: true, drag: true, collapsed: false, ...data },
});

describe("merging the same question changed on both sides", () => {
    test("takes our question whole when both changed what it asks or its answer", () => {
        const base = [radius(1)];
        expect(
            mergeQuestionLists(base, [radius(1, { radius: 10 })], [radius(1, { within: false })]),
        ).toEqual([radius(1, { radius: 10 })]);
    });

    test("never pairs fields that belong together from different sides", () => {
        const tentacle = (data: Record<string, unknown>) => ({
            id: "tentacles",
            key: 1,
            data: { lat: 47, lng: 8, radius: 15, unit: "kilometers", locationType: "tentacle-museum", places: [], ...data },
        });
        const theirs = tentacle({ locationType: "tentacle-zoo", places: [{ name: "Zoo" }] });
        const ours = tentacle({ radius: 2, unit: "miles" });
        expect(mergeQuestionLists([tentacle({})], [ours], [theirs])).toEqual([ours]);
        // Only they changed it: theirs, whole, with our fold.
        const folded = tentacle({ collapsed: true });
        expect(mergeQuestionLists([tentacle({})], [folded], [theirs])).toEqual([
            { ...theirs, data: { ...theirs.data, collapsed: true } },
        ]);
    });

    test("keeps ours for a field both changed", () => {
        expect(
            mergeQuestionLists([radius(1)], [radius(1, { radius: 10 })], [radius(1, { radius: 20 })]),
        ).toEqual([radius(1, { radius: 10 })]);
    });

    test("doesn't revert their answer for a lock we toggled offline", () => {
        // Device 1 only locked it; device 2 answered it.
        expect(
            mergeQuestionLists(
                [radius(1)],
                [radius(1, { drag: false })],
                [radius(1, { within: false, drag: true })],
            ),
        ).toEqual([radius(1, { within: false, drag: false })]);
    });

    test("doesn't revert their answer for a card we folded", () => {
        expect(
            mergeQuestionLists(
                [radius(1)],
                [radius(1, { collapsed: true })],
                [radius(1, { lat: 46 })],
            ),
        ).toEqual([radius(1, { lat: 46, collapsed: true })]);
    });

    test("keeps a question we removed if they answered it, not if they only folded it", () => {
        expect(mergeQuestionLists([radius(1)], [], [radius(1, { within: false })])).toEqual([
            radius(1, { within: false }),
        ]);
        expect(mergeQuestionLists([radius(1)], [], [radius(1, { collapsed: true })])).toEqual([]);
    });

    test("keeps a question they removed if we answered it, not if we only locked it", () => {
        expect(mergeQuestionLists([radius(1)], [radius(1, { radius: 9 })], [])).toEqual([
            radius(1, { radius: 9 }),
        ]);
        expect(mergeQuestionLists([radius(1)], [radius(1, { drag: false })], [])).toEqual([]);
    });
});

describe("numbers the API stored a digit short", () => {
    test("don't make a question count as changed, so our removal holds", () => {
        const exact = radius(0.25, { lat: 47.42790359754809, lng: 8.540192 });
        const rounded = radius(0.25, { lat: 47.427903597548094, lng: 8.540192 });
        const other = radius(0.5);
        expect(mergeQuestionLists([exact, other], [other], [rounded, other])).toEqual([other]);
    });

    test("still differ from a real change", () => {
        expect(sameQuestion(radius(1, { lat: 47.4279 }), radius(1, { lat: 47.4280 }))).toBe(false);
    });
});

describe("question keys the API stored a digit short", () => {
    // A 17-digit Math.random() key, and what the API used to store.
    const k = 0.47550004144641034;
    const stored = 0.4755000414464103;

    test("are the same key", () => {
        expect(sameQuestion(radius(k), radius(stored))).toBe(true);
        expect(sameQuestion(radius(k), radius(0.4755000414464))).toBe(false);
    });

    test("never join two distinct new keys, however close", () => {
        expect(
            mergeQuestionLists([], [radius(0.123456789012345)], [radius(0.123456789012346)]),
        ).toHaveLength(2);
        expect(mergeQuestionLists([], [radius(0.999999999999999)], [radius(0.999999999999998)])).toHaveLength(2);
        expect(mergeQuestionLists([], [radius(0)], [radius(1e-15)])).toHaveLength(2);
        expect(mergeQuestionLists([], [radius(0)], [radius(1e-16)])).toHaveLength(2);
    });

    test("an edited question isn't doubled", () => {
        const merged = mergeQuestionLists(
            [radius(k)],
            [radius(k, { radius: 7 })],
            [radius(stored), radius(0.25)],
        );
        expect(merged).toEqual([radius(stored, { radius: 7 }), radius(0.25)]);
    });

    test("a removed question doesn't come back", () => {
        expect(mergeQuestionLists([radius(k)], [], [radius(stored), radius(0.25)])).toEqual([
            radius(0.25),
        ]);
    });
});

describe("new question keys", () => {
    test("read back as exactly the same number, even when parsed to 15 digits", async () => {
        const { newQuestionKey } = await import("@/maps/schema");
        for (let i = 0; i < 1000; i++) {
            const key = newQuestionKey();
            expect(key).toBeGreaterThanOrEqual(0);
            expect(key).toBeLessThan(1);
            expect(Number(key.toPrecision(15))).toBe(key);
            expect(JSON.parse(JSON.stringify(key))).toBe(key);
        }
    });
});
