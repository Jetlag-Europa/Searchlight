import type {
    QuestionHistoryEntry,
    QuestionHistoryResponse,
} from "@searchlight/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { questions } from "@/lib/context";
import {
    appendOlderPage,
    fetchQuestionHistory,
    formatHistoryTime,
    prependNewer,
    QuestionHistoryError,
    restorable,
    restoreFromHistory,
} from "@/lib/questionHistory";
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

const radar = (key: number, lat = 50): Question =>
    questionSchema.parse({ id: "radius", key, data: { lat, lng: 6 } });

describe("restoring from the history", () => {
    afterEach(() => questions.set([]));

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
        ).toEqual({ status: "unavailable", reason: "On the board" });
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
            reason: "Can't be restored in this game",
        });
    });

    it("puts a question back where it was, on the board everyone sees", () => {
        const [a, b, c] = [radar(0.25, 1), radar(0.5, 2), radar(0.75, 3)];
        // The board's first question was saved one ulp off since.
        questions.set([{ ...a, key: nextUp(a.key) }, c]);
        restoreFromHistory({ order: [a.key, b.key, c.key] }, [
            { key: b.key, index: 1, label: "Radius 2", question: b },
        ]);
        expect(questions.get().map((q) => q.key)).toEqual([
            nextUp(a.key),
            b.key,
            c.key,
        ]);
        // Again: it's there now.
        const before = questions.get();
        restoreFromHistory({ order: [a.key, b.key, c.key] }, [
            { key: b.key, index: 1, label: "Radius 2", question: b },
        ]);
        expect(questions.get()).toBe(before);
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
