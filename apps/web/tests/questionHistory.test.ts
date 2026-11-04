import {
    diffQuestionLists,
    type QuestionChange,
    type QuestionHistoryEntry,
    type QuestionHistoryResponse,
} from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    activeSessionId,
    activeSessionRole,
    verifiedUserId,
} from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { historyLines } from "@/lib/historyLines";
import { setQuestionDecisionsPossible } from "@/lib/questionConflicts";
import {
    appendOlderPage,
    fetchQuestionHistory,
    formatHistoryTime,
    historyOf,
    loadedHistory,
    loadNewerHistory,
    loadNewestHistory,
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

describe("the history kept while the History is hidden", () => {
    const answer = (body: QuestionHistoryResponse) =>
        new Response(JSON.stringify(body));
    const asked = (fetchMock: ReturnType<typeof vi.fn>) =>
        fetchMock.mock.calls.map(([url]) =>
            String(url).replace(/^.*\/history/, ""),
        );

    beforeEach(() => activeSessionId.set("s1"));
    afterEach(() => {
        vi.unstubAllGlobals();
        activeSessionId.set("");
        verifiedUserId.set(null);
    });

    it("opened again, shows it and asks only for what came since", async () => {
        const fetchMock = vi.fn(async (url: string) =>
            answer(
                url.includes("after=")
                    ? page([22], null, 23)
                    : page([20, 18], 9, 21),
            ),
        );
        vi.stubGlobal("fetch", fetchMock);
        expect(await loadNewestHistory("s1")).toBe(true);
        // Hidden, then opened again: still there.
        expect(sequences(historyOf("s1")!.history)).toEqual([20, 18]);
        expect(await loadNewerHistory("s1")).toBe("added");
        expect(asked(fetchMock)).toEqual(["", "?after=21"]);
        const { history } = historyOf("s1")!;
        expect(sequences(history)).toEqual([22, 20, 18]);
        expect(history.nextBefore).toBe(9);
        expect(history.newest).toBe(23);
    });

    it("keeps what it has when a refresh fails, and says so", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(answer(page([20], null)))
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(answer(page([], null, null)));
        vi.stubGlobal("fetch", fetchMock);
        await loadNewestHistory("s1");
        await expect(loadNewerHistory("s1")).rejects.toThrow("Failed to fetch");
        expect(historyOf("s1")).toMatchObject({ refreshFailed: true });
        expect(sequences(historyOf("s1")!.history)).toEqual([20]);
        // Until a refresh works.
        await loadNewerHistory("s1");
        expect(historyOf("s1")).toMatchObject({ refreshFailed: false });
    });

    it("says to load the newest page when nothing is loaded or more came since", async () => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(answer(page([20], null)))
                .mockResolvedValueOnce(
                    answer({ ...page([], null, null), more: true }),
                ),
        );
        expect(await loadNewerHistory("s1")).toBe("more");
        await loadNewestHistory("s1");
        expect(await loadNewerHistory("s1")).toBe("more");
        expect(sequences(historyOf("s1")!.history)).toEqual([20]);
    });

    it("forgets it for another session or account, and drops answers still on the way", async () => {
        let reply = (_: Response) => {};
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValueOnce(answer(page([20], null)))
                .mockImplementation(
                    () => new Promise<Response>((r) => (reply = r)),
                ),
        );
        await loadNewestHistory("s1");
        activeSessionId.set("s2");
        expect(loadedHistory.get()).toBeNull();
        expect(historyOf("s1")).toBeNull();

        // Asked for under one account, answered under another.
        const pending = loadNewestHistory("s2");
        verifiedUserId.set("u9");
        reply(answer(page([30], null)));
        expect(await pending).toBe(false);
        expect(loadedHistory.get()).toBeNull();
    });

    it("forgets it when a spectator is made a player", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(answer(page([20], null))),
        );
        activeSessionRole.set("viewer");
        try {
            // Loaded without the deleted questions in full, as a spectator.
            await loadNewestHistory("s1");
            expect(historyOf("s1")).not.toBeNull();
            activeSessionRole.set("member");
            expect(loadedHistory.get()).toBeNull();
        } finally {
            activeSessionRole.set(null);
        }
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
        const order = [a.key, b.key, c.key];
        questions.set([{ ...a, key: nextUp(a.key) }, c]);
        restoreFromHistory([
            { key: b.key, index: 1, label: "Radius 2", question: b, order },
        ]);
        const board = questions.get();
        expect(board).toHaveLength(3);
        expect(board[0].key).toBe(nextUp(a.key));
        expect(board[2].key).toBe(c.key);
        // The same question, but not the deleted one's key.
        expect(board[1].key).not.toBe(b.key);
        expect({ ...board[1], key: b.key }).toEqual({
            ...b,
            data: { ...b.data, restoredFrom: [b.key] },
        });
        // Clicked again before the History reloads: it's there now.
        restoreFromHistory([
            { key: b.key, index: 1, label: "Radius 2", question: b, order },
        ]);
        expect(questions.get()).toBe(board);
    });

    it("keeps the order of questions restored together", () => {
        const [a, b, c] = [radar(0.25, 1), radar(0.5, 2), radar(0.75, 3)];
        const d = radar(0.9, 4);
        const order = [a.key, b.key, c.key, d.key];
        questions.set([d]);
        restoreFromHistory([
            { key: c.key, index: 2, label: "Radius 3", question: c, order },
            { key: a.key, index: 0, label: "Radius 1", question: a, order },
            { key: b.key, index: 1, label: "Radius 2", question: b, order },
        ]);
        expect(questions.get().map(latOf)).toEqual([1, 2, 3, 4]);
    });

    it("says On the board for the question it was restored as, edited or not", () => {
        const deleted = radar(0.5);
        const copy = asRestored(deleted, 0.125);
        // Answered and moved since (by a teammate, the History not loaded
        // yet): still the restored one.
        const edited = { ...copy, data: { ...copy.data, lat: 51 } };
        expect(
            restorable({ key: 0.5, question: deleted }, [edited], null),
        ).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
        // A twin with the same content isn't it: the deleted one can go back.
        expect(
            restorable(
                { key: 0.5, question: deleted },
                [{ ...structuredClone(deleted), key: 0.375 }],
                null,
            ).status,
        ).toBe("ok");
    });

    it("keeps the order of questions restored one by one", () => {
        const [x, a, b, y] = [1, 2, 3, 4].map((lat) => radar(lat / 8, lat));
        const target = (q: Radar, index: number, order: number[]) => ({
            key: q.key,
            index,
            label: `Radius ${index + 1}`,
            question: q,
            order,
        });
        const order = [x.key, a.key, b.key, y.key];
        questions.set([x, y]);
        restoreFromHistory([target(a, 1, order)]);
        restoreFromHistory([target(b, 2, order)]);
        expect(questions.get().map(latOf)).toEqual([1, 2, 3, 4]);
        // One restored by a teammate.
        const [p, q, r, z] = [5, 6, 7, 8].map((lat) => radar(lat / 16, lat));
        questions.set([p, asRestored(q, 0.9), z]);
        restoreFromHistory([target(r, 2, [p.key, q.key, r.key, z.key])]);
        expect(questions.get().map(latOf)).toEqual([5, 6, 7, 8]);
    });

    it("copies the question it restores", () => {
        const deleted = radar(0.5);
        const copy = asRestored(deleted, 0.75);
        expect(copy.key).toBe(0.75);
        expect(copy.data).not.toBe(deleted.data);
        expect(asRestored(deleted).key).not.toBe(0.5);
        // It says what it was restored from, and a copy of a copy both.
        expect(copy.data.restoredFrom).toEqual([0.5]);
        expect(asRestored(copy, 0.875).data.restoredFrom).toEqual([0.5, 0.75]);
        // Kept when the History reads the copy back.
        expect(questionSchema.parse(copy).data.restoredFrom).toEqual([0.5]);
    });

    it("takes a different custom zone at the same pin for another question", () => {
        const zone = (key: number, x: number) =>
            questionSchema.parse({
                id: "matching",
                key,
                data: {
                    lat: 52,
                    lng: 4,
                    color: "blue",
                    type: "custom-zone",
                    geo: {
                        type: "FeatureCollection",
                        features: [
                            {
                                type: "Feature",
                                properties: {},
                                geometry: {
                                    type: "Point",
                                    coordinates: [x, 52],
                                },
                            },
                        ],
                    },
                },
            });
        const [deleted, other] = [zone(0.1, 4), zone(0.2, 8)];
        const lines = historyLines(
            [
                save(diffQuestionLists([], [deleted]).changes),
                save(diffQuestionLists([deleted], []).changes, [deleted.key]),
                save(diffQuestionLists([], [other]).changes),
            ],
            {},
        );
        expect(lines[0].text).toBe("added Matching 1");
        const [removal] = deletionsOf(lines, deleted.key);
        expect(restorable(removal, [other], null).status).toBe("ok");
    });

    it("knows a copy edited before its first save as restored, and doesn't make another", () => {
        // Restored offline, and the radius changed before it was sent.
        const deleted = radar(0.1);
        const copy = asRestored(deleted, 0.2);
        copy.data.radius = 3;
        const lines = historyLines(
            [
                save(diffQuestionLists([], [deleted]).changes),
                save(diffQuestionLists([deleted], []).changes, [deleted.key]),
                save(diffQuestionLists([], [copy]).changes),
            ],
            {},
        );
        expect(lines[0].text).toBe("restored Radius 1");
        const [removal] = deletionsOf(lines, deleted.key);
        expect(restorable(removal, [copy], null)).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
        questions.set([copy]);
        expect(restoreFromHistory([removal])).toEqual({
            back: [],
            alreadyBack: 1,
        });
        expect(questions.get()).toEqual([copy]);
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
        const [deletedB] = deletionsOf(lines, b.key);
        const [deletedX] = deletionsOf(lines, x.key);
        for (const deleted of [deletedA, deletedB]) {
            expect(restorable(deleted, [c, y], null)).toEqual({
                status: "unavailable",
                reason: "On the board as Radius 1",
            });
        }
        // x goes back below c, which a became.
        questions.set([c, y]);
        restoreFromHistory([deletedX]);
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
        // Undo's same key and Restore's copy both read as restored.
        expect(lines.map((l) => l.text.split(" ")[0])).toEqual([
            "restored",
            "deleted",
            "moved",
            "restored",
            "deleted",
        ]);
        for (const deleted of deletionsOf(lines, a.key)) {
            expect(restorable(deleted, [c], null)).toEqual({
                status: "unavailable",
                reason: "On the board as Radius 1",
            });
        }
    });

    it("waits for a decision held over what it was restored as", () => {
        const deleted = radar(0.5);
        const copy = asRestored(deleted, 0.6);
        const removal = { key: 0.5, question: deleted };
        const held = (conflict: { key: number; base: unknown }) =>
            restoreBlocked(removal, {
                held: [conflict],
                decisionsPossible: true,
            });
        expect(held({ key: 0.6, base: copy })).toBe("Needs a decision first");
        // Two steps on: the copy was deleted and restored again.
        expect(held({ key: 0.7, base: asRestored(copy, 0.7) })).toBe(
            "Needs a decision first",
        );
        expect(held({ key: 0.8, base: radar(0.8) })).toBeNull();
    });

    it("doesn't wait for a decision over another question that was beside it", () => {
        // b, a copy of a, was on the board beside it, edited apart.
        const a = radar(0.5);
        const b = asRestored(moved(a, 2), 0.6);
        const both = [a.key, b.key];
        const held = (
            removal: { key: number; question: unknown; order: number[] },
            conflict: { key: number; base: unknown },
        ) =>
            restoreBlocked(removal, {
                held: [conflict],
                decisionsPossible: true,
            });
        // a deleted with b held, or a copy of b.
        const deletedA = { key: a.key, question: a, order: both };
        expect(held(deletedA, { key: b.key, base: b })).toBeNull();
        expect(
            held(deletedA, { key: 0.7, base: asRestored(b, 0.7) }),
        ).toBeNull();
        // Deleted alone, a waits: b stands for it then.
        expect(
            held({ ...deletedA, order: [a.key] }, { key: b.key, base: b }),
        ).toBe("Needs a decision first");
        // b deleted with a held waits even beside it: keeping a would take
        // an unchanged copy put back meanwhile off the board.
        const deletedB = { key: b.key, question: b, order: both };
        expect(held(deletedB, { key: a.key, base: a })).toBe(
            "Needs a decision first",
        );
    });

    it("tells apart two questions alike, each restored on its own", () => {
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
        expect(restorable(first, [copy], null).status).toBe("unavailable");
        expect(restorable(second, [copy], null).status).toBe("ok");
    });

    it("still offers one deleted beside another copy of the same question", () => {
        // Restored twice at once by two players: one copy is deleted.
        const a = radar(0.31, 3);
        const [one, two] = [asRestored(a, 0.32), asRestored(a, 0.33)];
        const lines = historyLines(
            [save([removedQ(two, 1)], [one.key, two.key])],
            {},
        );
        const [removal] = deletionsOf(lines, two.key);
        expect(restorable(removal, [one], null).status).toBe("ok");
        // Restored, it says what it was restored from.
        questions.set([one]);
        restoreFromHistory([removal]);
        expect(questions.get().map((x) => x.data.restoredFrom)).toEqual([
            [a.key],
            [a.key, two.key],
        ]);
    });

    it("still offers one of two copies deleted together once the other is back", () => {
        const a = radar(0.31, 3);
        const one = asRestored(moved(a, 4), 0.32);
        const two = asRestored(moved(a, 5), 0.33);
        const lines = historyLines(
            [save([removedQ(one, 0), removedQ(two, 1)], [one.key, two.key])],
            {},
        );
        const [deletedOne] = deletionsOf(lines, one.key);
        const [deletedTwo] = deletionsOf(lines, two.key);
        questions.set([]);
        restoreFromHistory([deletedOne]);
        expect(restorable(deletedOne, questions.get(), null).status).toBe(
            "unavailable",
        );
        expect(restorable(deletedTwo, questions.get(), null).status).toBe("ok");
    });

    it("tells a copy of another question on the board from one of this one", () => {
        // b was a copy of a beside it, edited apart. a was deleted; then
        // b, restored as d.
        const a = radar(0.51, 1);
        const b = asRestored(moved(a, 2), 0.52);
        const d = asRestored(b, 0.53);
        const lines = historyLines(
            [
                save([removedQ(a, 0)], [a.key, b.key]),
                save([removedQ(b, 0)], [b.key]),
            ],
            {},
        );
        const [deletedA] = deletionsOf(lines, a.key);
        const [deletedB] = deletionsOf(lines, b.key);
        expect(restorable(deletedA, [d], null).status).toBe("ok");
        expect(restorable(deletedB, [d], null)).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 1",
        });
        // Its own ancestor beside it doesn't count against it.
        const both = historyLines([save([removedQ(b, 1)], [a.key, b.key])], {});
        expect(restorable(deletionsOf(both, b.key)[0], [a, d], null)).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 2",
        });
    });

    it("keeps the order of questions restored one by one, below a copy restored again", () => {
        // b was a restore already; b and x deleted together.
        const [r, x, tail] = [radar(0.41, 1), radar(0.42, 2), radar(0.43, 3)];
        const b = asRestored(r, 0.44);
        const lines = historyLines(
            [save([removedQ(b, 0), removedQ(x, 1)], [b.key, x.key, tail.key])],
            {},
        );
        const [deletedB] = deletionsOf(lines, b.key);
        const [deletedX] = deletionsOf(lines, x.key);
        questions.set([tail]);
        restoreFromHistory([deletedB]);
        restoreFromHistory([deletedX]);
        expect(questions.get().map(latOf)).toEqual([1, 2, 3]);
    });
});

describe("a teammate's restore the History hasn't loaded yet", () => {
    it("counts a copy of the deleted one as back, and not a twin", () => {
        const deleted = radar(0.5, 51);
        const removed = {
            key: 0.5,
            index: 1,
            label: "Radius 2",
            question: deleted,
            order: [0.25, 0.5],
        };
        // A question with the same content isn't it.
        const twin = { ...structuredClone(deleted), key: 0.25 };
        const added = { ...structuredClone(deleted), key: 0.125 };
        expect(restorable(removed, [twin, added], null)).not.toMatchObject({
            reason: expect.stringMatching(/^On the board/),
        });
        // A teammate's restore is, as soon as it reaches the board.
        expect(
            restorable(removed, [twin, asRestored(deleted, 0.75)], null),
        ).toEqual({
            status: "unavailable",
            reason: "On the board as Radius 2",
        });
    });
});

describe("when Restore waits", () => {
    afterEach(() => {
        questions.set([]);
        setQuestionDecisionsPossible(false);
    });

    it("waits for a decision over that question, and for an editable board", () => {
        const blocked = (held: { key: number }[], decisionsPossible: boolean) =>
            restoreBlocked(
                { key: 0.5, question: null },
                { held, decisionsPossible },
            );
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
            order: [0.5],
        };
        // The board isn't showing a saved session yet.
        setQuestionDecisionsPossible(false);
        expect(restorable(target, [], null)).toEqual({
            status: "unavailable",
            reason: notRightNowReason(),
        });
        restoreFromHistory([target]);
        expect(questions.get()).toEqual([]);
        // Once it is, it goes back.
        setQuestionDecisionsPossible(true);
        expect(restoreBlocked({ key: 0.5, question: null })).toBeNull();
        restoreFromHistory([target]);
        expect(questions.get().map(latOf)).toEqual([50]);
    });

    it("names what it put back as the board calls it now", () => {
        setQuestionDecisionsPossible(true);
        // Radius 2 when deleted; Radius 1 went too, so it's back as Radius 1.
        const { back } = restoreFromHistory([
            {
                key: 0.5,
                index: 1,
                label: "Radius 2",
                question: radar(0.5),
                order: [0.25, 0.5],
            },
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
            order: [0.5],
        };
        setQuestionDecisionsPossible(true);
        activeSessionRole.set("viewer");
        try {
            restoreFromHistory([target]);
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
            restorable({ key: b.key, question: b }, [a, copy], null),
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
