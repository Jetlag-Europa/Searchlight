import type {
    QuestionChange,
    QuestionHistoryEntry,
    QuestionHistoryResponse,
} from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeSessionRole } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { historyLines } from "@/lib/historyLines";
import { setQuestionDecisionsPossible } from "@/lib/questionConflicts";
import {
    appendOlderPage,
    fetchQuestionHistory,
    formatHistoryTime,
    prependNewer,
    notRightNowReason,
    QuestionHistoryError,
    restorable,
    restoreBlocked,
    restoreFromHistory,
} from "@/lib/questionHistory";
import { asRestored } from "@/lib/questionUndo";
import { type Question, questionSchema } from "@/maps/schema";

// The next double up: a key saved one ulp off by an older client.
const nextUp = (x: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    return view.getFloat64(0);
};

const entry = (sequence: number): QuestionHistoryEntry => ({
    sequence,
    userId: "u1",
    displayName: "Sam",
    at: "2026-11-02T14:00:00.000Z",
    changes: [],
    reordered: true,
});
const page = (
    sequences: number[],
    nextBefore: number | null,
    newest: number | null = sequences[0] ?? null,
): QuestionHistoryResponse => ({
    entries: sequences.map(entry),
    nextBefore,
    newest,
});
const sequences = (response: QuestionHistoryResponse) =>
    response.entries.map((e) => e.sequence);

describe("merging history pages", () => {
    it("puts the saves since on top, keeping older pages", () => {
        const merged = prependNewer(
            page([20, 18, 15], 9, 21),
            page([25, 22], null, 26),
        );
        expect(sequences(merged)).toEqual([25, 22, 20, 18, 15]);
        expect(merged.nextBefore).toBe(9);
        expect(merged.newest).toBe(26);
    });

    it("moves the cursor on for saves that changed nothing", () => {
        const merged = prependNewer(page([20], 9, 20), page([], null, 23));
        expect(sequences(merged)).toEqual([20]);
        expect(merged.newest).toBe(23);
        // Nothing read: the cursor stays.
        expect(prependNewer(merged, page([], null, null)).newest).toBe(23);
    });

    it("doesn't repeat a save read twice", () => {
        const merged = prependNewer(page([20], null), page([21, 20], null));
        expect(sequences(merged)).toEqual([21, 20]);
    });

    it("adds an older page below", () => {
        const merged = appendOlderPage(
            page([20, 18], 17),
            page([16, 12], null),
        );
        expect(sequences(merged)).toEqual([20, 18, 16, 12]);
        expect(merged.nextBefore).toBeNull();
        expect(merged.newest).toBe(20);
    });
});

describe("fetching the history", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("asks the API with the session cookie", async () => {
        const fetchMock = vi.fn(
            async (_url: string, _init?: RequestInit) =>
                new Response(JSON.stringify(page([5], null))),
        );
        vi.stubGlobal("fetch", fetchMock);
        await expect(
            fetchQuestionHistory("s 1", { before: 40 }),
        ).resolves.toEqual(page([5], null));
        await fetchQuestionHistory("s1", { after: 7 });
        await fetchQuestionHistory("s1");
        const urls = fetchMock.mock.calls.map(([url]) => url);
        expect(urls[0]).toMatch(
            /\/sessions\/s%201\/questions\/history\?before=40$/,
        );
        expect(urls[1]).toMatch(/\/sessions\/s1\/questions\/history\?after=7$/);
        expect(urls[2]).toMatch(/\/sessions\/s1\/questions\/history$/);
        for (const [, init] of fetchMock.mock.calls) {
            expect(init).toEqual({ credentials: "include" });
        }
    });

    it("throws the status of a failed request", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("", { status: 404 })),
        );
        const error = await fetchQuestionHistory("s1").catch((e) => e);
        expect(error).toBeInstanceOf(QuestionHistoryError);
        expect(error.status).toBe(404);
    });
});

type Radar = Extract<Question, { id: "radius" }>;
const radar = (key: number, lat = 50): Radar =>
    questionSchema.parse({
        id: "radius",
        key,
        data: { lat, lng: 6 },
    }) as Radar;
const latOf = (q: Question) => (q as Radar).data.lat;

describe("restoring from the history", () => {
    // As on a session's board, saved and editable.
    beforeEach(() => setQuestionDecisionsPossible(true));
    afterEach(() => {
        questions.set([]);
        setQuestionDecisionsPossible(false);
    });

    it("says why a question can't go back", () => {
        const deleted = radar(0.5);
        expect(restorable({ key: 0.5, question: deleted }, [], null)).toEqual({
            status: "ok",
            question: deleted,
        });
        expect(
            restorable(
                { key: 0.5, question: deleted },
                [{ key: nextUp(0.5) }],
                null,
            ),
        ).toEqual({
            status: "unavailable",
            reason: "On the board",
        });
        expect(
            restorable(
                { key: 0.5, question: { id: "radius", key: 0.5, data: {} } },
                [],
                null,
            ),
        ).toEqual({ status: "unavailable", reason: "Can't be restored" });
        expect(
            restorable({ key: 0.5, question: "junk" }, [], null).status,
        ).toBe("unavailable");
        // A radar in a game that has none.
        expect(
            restorable({ key: 0.5, question: deleted }, [], {
                questionMap: new Map(),
            }),
        ).toEqual({
            status: "unavailable",
            reason: "Not in this game",
        });
    });

    it("puts a question back where it was, under a new key", () => {
        const [a, b, c] = [radar(0.25, 1), radar(0.5, 2), radar(0.75, 3)];
        // The board's first question was saved one ulp off since.
        questions.set([{ ...a, key: nextUp(a.key) }, c]);
        restoreFromHistory({ order: [a.key, b.key, c.key] }, [
            { key: b.key, index: 1, label: "Radius 2", question: b },
        ]);
        const board = questions.get();
        expect(board).toHaveLength(3);
        expect(board[0].key).toBe(nextUp(a.key));
        expect(board[2].key).toBe(c.key);
        // The same question, but not the deleted one's key.
        expect(board[1].key).not.toBe(b.key);
        expect({ ...board[1], key: b.key }).toEqual(b);
        // Clicked again before the History reloads: it's there now.
        restoreFromHistory({ order: [a.key, b.key, c.key] }, [
            { key: b.key, index: 1, label: "Radius 2", question: b },
        ]);
        expect(questions.get()).toBe(board);
    });

    it("keeps the order of questions restored together", () => {
        const [a, b, c] = [radar(0.25, 1), radar(0.5, 2), radar(0.75, 3)];
        const d = radar(0.9, 4);
        questions.set([d]);
        restoreFromHistory({ order: [a.key, b.key, c.key, d.key] }, [
            { key: c.key, index: 2, label: "Radius 3", question: c },
            { key: a.key, index: 0, label: "Radius 1", question: a },
            { key: b.key, index: 1, label: "Radius 2", question: b },
        ]);
        expect(questions.get().map(latOf)).toEqual([1, 2, 3, 4]);
    });

    it("says On the board for the question it was restored as, edited or not", () => {
        const deleted = radar(0.5);
        const copy = asRestored(deleted, 0.125);
        // Answered and moved since: still the restored one.
        const edited = { ...copy, data: { ...copy.data, lat: 51 } };
        expect(
            restorable(
                { key: 0.5, question: deleted, restoredAs: [0.125] },
                [edited],
                null,
            ),
        ).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
        // A twin with the same content isn't it: the deleted one can go back.
        expect(
            restorable(
                { key: 0.5, question: deleted },
                [asRestored(deleted, 0.375)],
                null,
            ).status,
        ).toBe("ok");
    });

    it("keeps the order of questions restored one by one", () => {
        const [x, a, b, y] = [1, 2, 3, 4].map((lat) => radar(lat / 8, lat));
        const order = [x.key, a.key, b.key, y.key];
        const target = (q: Radar, index: number) => ({
            key: q.key,
            index,
            label: `Radius ${index + 1}`,
            question: q,
        });
        questions.set([x, y]);
        restoreFromHistory({ order }, [target(a, 1)]);
        restoreFromHistory({ order }, [target(b, 2)]);
        expect(questions.get().map(latOf)).toEqual([1, 2, 3, 4]);
        // As the History tells it once reloaded, with nothing restored here.
        const [p, q, r, z] = [5, 6, 7, 8].map((lat) => radar(lat / 16, lat));
        const qCopy = asRestored(q, 0.9);
        questions.set([p, qCopy, z]);
        const removed = [{ ...target(q, 1), restoredAs: [0.9] }, target(r, 2)];
        restoreFromHistory(
            { order: [p.key, q.key, r.key, z.key] },
            [removed[1]],
            [{ removed }],
        );
        expect(questions.get().map(latOf)).toEqual([5, 6, 7, 8]);
    });

    it("copies the question it restores", () => {
        const deleted = radar(0.5);
        const copy = asRestored(deleted, 0.75);
        expect(copy.key).toBe(0.75);
        expect(copy.data).not.toBe(deleted.data);
        expect(asRestored(deleted).key).not.toBe(0.5);
    });
});

// A history as the API gives it, oldest save first.
let seq = 100;
const save = (
    changes: QuestionChange[],
    order?: number[],
): QuestionHistoryEntry => ({
    sequence: ++seq,
    userId: "u1",
    displayName: "Sam",
    at: new Date(Date.UTC(2026, 10, 2, 14, 0, seq)).toISOString(),
    changes,
    ...(order ? { order } : {}),
});
const addedQ = (q: Radar, index = 0): QuestionChange => ({
    kind: "added",
    key: q.key,
    id: "radius",
    index,
    typeIndex: index + 1,
    after: q.data,
});
const removedQ = (q: Radar, index = 0): QuestionChange => ({
    kind: "removed",
    key: q.key,
    id: "radius",
    index,
    typeIndex: index + 1,
    question: q,
});
const changedQ = (q: Radar, lat: number): QuestionChange => ({
    kind: "changed",
    key: q.key,
    id: "radius",
    index: 0,
    typeIndex: 1,
    fields: ["lat"],
    before: { lat: q.data.lat, lng: q.data.lng },
    after: { lat, lng: q.data.lng },
});
const moved = (q: Radar, lat: number): Radar => ({
    ...q,
    data: { ...q.data, lat },
});
// The deletions of a key in the lines, oldest first.
const deletionsOf = (lines: ReturnType<typeof historyLines>, key: number) =>
    lines
        .flatMap((line) => line.removed ?? [])
        .filter((r) => r.key === key)
        .reverse();

describe("what a deleted question became", () => {
    beforeEach(() => setQuestionDecisionsPossible(true));
    afterEach(() => {
        questions.set([]);
        setQuestionDecisionsPossible(false);
    });

    it("follows restores of restores, for the line and its order", () => {
        // a and x deleted together; a restored as b, b moved and deleted,
        // then restored as c.
        const [a, x, y] = [radar(0.11, 1), radar(0.12, 2), radar(0.13, 3)];
        const b = asRestored(a, 0.21);
        const c = asRestored(moved(b, 4), 0.31);
        const lines = historyLines(
            [
                save([removedQ(a, 0), removedQ(x, 1)], [a.key, x.key, y.key]),
                save([addedQ(b)]),
                save([changedQ(b, 4)]),
                save([removedQ(moved(b, 4))], [b.key, y.key]),
                save([addedQ(c)]),
            ],
            {},
        );
        const [deletedA] = deletionsOf(lines, a.key);
        const [deletedX] = deletionsOf(lines, x.key);
        expect(deletedA.restoredAs).toEqual([b.key]);
        expect(restorable(deletedA, [c, y], null, lines)).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
        // x goes back below c, which a became.
        questions.set([c, y]);
        const line = lines.find((l) => l.removed?.includes(deletedX))!;
        restoreFromHistory(line, [deletedX], lines);
        expect(questions.get().map(latOf)).toEqual([4, 2, 3]);
    });

    it("doesn't offer an older line of a key put back by Undo and restored since", () => {
        // a deleted, put back by Undo (its key), moved, deleted again and
        // restored from that newer line as c.
        const a = radar(0.41, 1);
        const c = asRestored(moved(a, 5), 0.51);
        const lines = historyLines(
            [
                save([removedQ(a)], [a.key]),
                save([addedQ(a)]),
                save([changedQ(a, 5)]),
                save([removedQ(moved(a, 5))], [a.key]),
                save([addedQ(c)]),
            ],
            {},
        );
        const [older, newer] = deletionsOf(lines, a.key);
        expect(older.restoredAs).toBeUndefined();
        expect(newer.restoredAs).toEqual([c.key]);
        // Only the other lines tell.
        expect(restorable(older, [c], null).status).toBe("ok");
        expect(restorable(older, [c], null, lines)).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
    });

    it("waits for a decision held over what it was restored as", () => {
        expect(
            restoreBlocked(
                { key: 0.5, restoredAs: [0.6] },
                { held: [{ key: 0.6 }], decisionsPossible: true },
            ),
        ).toBe("Needs a decision first");
        // Two steps on: 0.6 was deleted and restored as 0.7.
        const lines = [
            {
                removed: [
                    {
                        key: 0.6,
                        index: 0,
                        label: "Radius 1",
                        question: null,
                        restoredAs: [0.7],
                    },
                ],
            },
        ];
        expect(
            restoreBlocked(
                { key: 0.5, restoredAs: [0.6] },
                { held: [{ key: 0.7 }], decisionsPossible: true, lines },
            ),
        ).toBe("Needs a decision first");
        expect(
            restoreBlocked(
                { key: 0.5, restoredAs: [0.6] },
                { held: [{ key: 0.8 }], decisionsPossible: true, lines },
            ),
        ).toBeNull();
    });

    it("takes a question added as the restore of one deleted question at most", () => {
        // Two identical questions, deleted one after the other.
        const p = radar(0.61, 6);
        // Parsed once: a random default would tell them apart.
        const q = { ...p, key: 0.62 };
        const copy = asRestored(p, 0.71);
        const lines = historyLines(
            [
                save([removedQ(p)], [p.key, q.key]),
                save([removedQ(q)], [q.key]),
                save([addedQ(copy)]),
            ],
            {},
        );
        expect(lines[0].text).toBe("restored Radius 1");
        const [first] = deletionsOf(lines, p.key);
        const [second] = deletionsOf(lines, q.key);
        // The newest one.
        expect(second.restoredAs).toEqual([copy.key]);
        expect(first.restoredAs).toBeUndefined();
        expect(restorable(first, [copy], null, lines).status).toBe("ok");
    });
});

describe("when Restore waits", () => {
    afterEach(() => {
        questions.set([]);
        setQuestionDecisionsPossible(false);
    });

    it("waits for a decision over that question, and for an editable board", () => {
        const blocked = (held: { key: number }[], decisionsPossible: boolean) =>
            restoreBlocked(0.5, { held, decisionsPossible });
        expect(blocked([], true)).toBeNull();
        // Held under a key saved one ulp off.
        expect(blocked([{ key: nextUp(0.5) }], true)).toBe(
            "Needs a decision first",
        );
        expect(blocked([{ key: 0.25 }], true)).toBeNull();
        expect(blocked([], false)).toMatch(/^(Loading…|Offline)$/);
        expect(blocked([{ key: 0.5 }], false)).toBe("Needs a decision first");
    });

    it("says so instead of putting the question back", () => {
        const deleted = radar(0.5);
        const target = {
            key: 0.5,
            index: 0,
            label: "Radius 1",
            question: deleted,
        };
        // The board isn't showing a saved session yet.
        setQuestionDecisionsPossible(false);
        expect(restorable(target, [], null)).toEqual({
            status: "unavailable",
            reason: notRightNowReason(),
        });
        restoreFromHistory({ order: [0.5] }, [target]);
        expect(questions.get()).toEqual([]);
        // Once it is, it goes back.
        setQuestionDecisionsPossible(true);
        expect(restoreBlocked(0.5)).toBeNull();
        restoreFromHistory({ order: [0.5] }, [target]);
        expect(questions.get().map(latOf)).toEqual([50]);
    });

    it("names what it put back as the board calls it now", () => {
        setQuestionDecisionsPossible(true);
        // Radius 2 when deleted; Radius 1 went too, so it's back as Radius 1.
        const { back } = restoreFromHistory({ order: [0.25, 0.5] }, [
            { key: 0.5, index: 1, label: "Radius 2", question: radar(0.5) },
        ]);
        expect(back.map((r) => r.label)).toEqual(["Radius 1"]);
        expect(back[0].key).not.toBe(0.5);
    });

    it("restores nothing for a spectator", () => {
        const deleted = radar(0.5);
        const target = {
            key: 0.5,
            index: 0,
            label: "Radius 1",
            question: deleted,
        };
        setQuestionDecisionsPossible(true);
        activeSessionRole.set("viewer");
        try {
            restoreFromHistory({ order: [0.5] }, [target]);
            expect(questions.get()).toEqual([]);
        } finally {
            activeSessionRole.set(null);
        }
    });
});

describe("what the History says", () => {
    it("tells offline from loading when Restore waits", () => {
        expect(notRightNowReason(false)).toBe("Offline");
        expect(notRightNowReason(true)).toBe("Loading…");
        expect(notRightNowReason(undefined)).toBe("Loading…");
    });

    it("names a restored question as the board does now", () => {
        // Radius 1 was deleted, so the copy of Radius 3 is Radius 2 now.
        const [a, b] = [radar(0.11, 1), radar(0.13, 3)];
        const copy = asRestored(b, 0.31);
        expect(
            restorable(
                { key: b.key, question: b, restoredAs: [copy.key] },
                [a, copy],
                null,
            ),
        ).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 2",
        });
    });
});

describe("history times", () => {
    it("shows only the time today, and the day before it otherwise", () => {
        const now = new Date(2026, 10, 2, 18, 0);
        expect(
            formatHistoryTime(new Date(2026, 10, 2, 14, 5).toISOString(), now)
                .day,
        ).toBeNull();
        expect(
            formatHistoryTime(new Date(2026, 10, 1, 14, 5).toISOString(), now)
                .day,
        ).not.toBeNull();
    });
});
