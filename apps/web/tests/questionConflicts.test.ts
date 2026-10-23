import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    get length() {
        return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
});
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
);

import type { GameDefinition } from "@searchlight/shared";

import { setActiveGameDefinition } from "@/game-definition/store";
import {
    activeSessionId,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import { gameDefinitionReady, questions } from "@/lib/context";
import {
    applyUnsyncedEvents,
    discardSessionData,
    getCachedSession,
    getPendingEvents,
    queuedQuestionsBase,
    setBoardBase,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    lookUpConflictAuthors,
    type QuestionConflict,
    questionConflictArrivals,
    questionConflicts,
    reconcileQuestionConflicts,
    resolveAllQuestionConflicts,
    resolveQuestionConflict,
    trackBoardQuestions,
    withResolvedConflictsSeen,
} from "@/lib/questionConflicts";
import { mergeQuestionLists, sameQuestionList } from "@/lib/questionMerge";
import { suppressQuestionSave } from "@/lib/questionSaveSuppress";
import {
    flushQuestionSave,
    saveQuestionsDebounced,
    saveQuestionsToServer,
} from "@/lib/sessionState";
import {
    flushPendingEvents,
    onQuestionsSaved,
    startSyncManager,
    stopSyncManager,
} from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const SID = "conflicts-session";
type Q = Questions[number];
const q = (
    key: number,
    label = String(key),
    extra: Record<string, unknown> = {},
) => ({ id: "radius", key, data: { label, ...extra } }) as unknown as Q;
const wire = (list: Questions) =>
    list.map((payloadJson, ordinal) => ({
        clientUuid: `server-${ordinal}`,
        ordinal,
        payloadJson,
    }));
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
const putBodies = () =>
    mockFetch.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([, init]) => JSON.parse(init.body as string));
const changeLookups = () =>
    mockFetch.mock.calls.filter(([url]) =>
        String(url).includes("/questions/changes"),
    );
const labels = (list: readonly unknown[]) =>
    list.map((x) => {
        const question = x as { key: number; data: { label: string } };
        return `${question.key}:${question.data.label}`;
    });
const held = () => questionConflicts.get();
const stored = (owner = "u1"): QuestionConflict[] =>
    JSON.parse(store.get(`taibled-conflicts-${SID}~${owner}`) ?? "[]");

function snapshot(list: Questions, sequence: number, userId = "u1") {
    setCachedSession({
        sessionId: SID,
        userId,
        strokes: [],
        questions: list,
        serverQuestions: { sequence, questions: list },
        lastSyncedAt: 1,
        lastSequence: sequence,
    });
    questions.set(suppressQuestionSave([...list]));
    trackBoardQuestions(SID, list, false);
}

// A server that refuses a stale base and knows the saves it has by their
// replacementId. `hold` keeps PUTs unanswered until released; `lose` loses
// the answer of a PUT that lands.
function fakeServer(seq: number, list: Questions) {
    const server = {
        seq,
        list,
        committed: new Map<string, number>(),
        hold: false,
        lose: false,
        held: [] as Array<() => void>,
        changes: [] as Array<{
            sequence: number;
            userId: string;
            displayName: string;
            list: Questions;
        }>,
        // Another player saves a list.
        other(next: Questions, userId = "u2", displayName = "Alex") {
            server.seq += 1;
            server.list = next;
            server.changes.push({
                sequence: server.seq,
                userId,
                displayName,
                list: next,
            });
        },
    };
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/questions/changes")) {
            const params = new URL(String(url)).searchParams;
            const after = Number(params.get("after"));
            const keys = params.get("keys")!.split(",").map(Number);
            return json(200, {
                changes: server.changes
                    .filter((c) => c.sequence > after)
                    .map((c) => ({
                        sequence: c.sequence,
                        userId: c.userId,
                        displayName: c.displayName,
                        questions: c.list.filter((x) =>
                            keys.includes(
                                (x as unknown as { key: number }).key,
                            ),
                        ),
                    })),
            });
        }
        if (init?.method !== "PUT") {
            return json(200, {
                questions: wire(server.list),
                sequence: server.seq,
            });
        }
        const body = JSON.parse(init.body as string);
        if (server.committed.has(body.replacementId)) {
            return json(200, {
                sequence: server.committed.get(body.replacementId),
                duplicate: true,
            });
        }
        if (body.baseSequence < server.seq)
            return json(409, { code: "QUESTIONS_CHANGED" });
        // Held up on its way: it lands when released.
        if (server.hold) {
            await new Promise<void>((resolve) => server.held.push(resolve));
            if (body.baseSequence < server.seq)
                return json(409, { code: "QUESTIONS_CHANGED" });
        }
        server.seq += 1;
        server.list = body.questions.map(
            (x: { payloadJson: Q }) => x.payloadJson,
        );
        server.committed.set(body.replacementId, server.seq);
        server.changes.push({
            sequence: server.seq,
            userId: "u1",
            displayName: "Me",
            list: server.list,
        });
        if (server.lose) throw new TypeError("Failed to fetch");
        return json(200, { sequence: server.seq });
    });
    servers.push(server);
    return server;
}
const servers: Array<{ hold: boolean; held: Array<() => void> }> = [];

// What SessionManager does when a merged save is answered: show it.
function showMergedSaves() {
    return onQuestionsSaved(
        ({ sessionId, local, saved, sequence, mergedWith, replacementId }) => {
            if (!mergedWith || sequence === undefined) return;
            const cached = getCachedSession(sessionId);
            if ((cached?.serverQuestions?.sequence ?? -1) >= sequence) return;
            reconcileQuestionConflicts(sessionId, saved, sequence);
            const shown = withResolvedConflictsSeen(sessionId, {
                local,
                saved,
                replacementId,
            });
            const current = questions.get();
            const visible = mergeQuestionLists(shown, current, saved);
            if (cached) {
                setCachedSession({
                    ...cached,
                    questions: visible,
                    serverQuestions: { sequence, questions: saved },
                });
            }
            if (sameQuestionList(visible, current)) return;
            trackBoardQuestions(sessionId, visible, false);
            questions.set(
                sameQuestionList(current, shown)
                    ? suppressQuestionSave(visible)
                    : visible,
            );
        },
    );
}

// What SessionManager's save effect does with a board the player edited.
async function edit(list: Questions) {
    questions.set(list);
    trackBoardQuestions(SID, list, true);

    await saveQuestionsToServer(SID, list).catch(() => {});
}

// The board set by a decision is saved like any edit (SessionManager).
async function saveBoard() {
    trackBoardQuestions(SID, questions.get(), true);
    await saveQuestionsToServer(SID, questions.get()).catch(() => {});
}

let stopShowing: () => void;

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    verifiedUserId.set("u1");
    offlineUserId.set(null);
    activeSessionId.set(SID);
    startSyncManager();
    stopShowing = showMergedSaves();
});

afterEach(async () => {
    // Nothing may stay on its way into the next test.
    for (const server of servers.splice(0)) {
        server.hold = false;
        server.held.splice(0).forEach((release) => release());
    }
    await flushPendingEvents(SID).catch(() => {});
    stopShowing();
    stopSyncManager();
    activeSessionId.set("");
    verifiedUserId.set(null);
    questions.set([]);
    vi.restoreAllMocks();
});

describe("a question both sides changed", () => {
    test("is held before the merged list is sent, which has their version", async () => {
        const A = q(1),
            B = q(2);
        snapshot([A, B], 4);
        const server = fakeServer(4, [A, B]);
        server.other([q(1, "theirs"), B]);
        // The merged save never answers.
        server.hold = true;
        const arrivals = questionConflictArrivals.get();
        void saveQuestionsToServer(SID, [q(1, "mine"), B]);
        await vi.waitFor(() => expect(server.held).toHaveLength(1));

        const merged = putBodies().at(-1);
        expect(
            labels(
                merged.questions.map((x: { payloadJson: Q }) => x.payloadJson),
            ),
        ).toEqual(["1:theirs", "2:2"]);
        // Stored, and queued with the merged list, before that PUT.
        const [record] = stored();
        expect(record).toMatchObject({
            key: 1,
            kind: "both-changed",
            mine: q(1, "mine"),
            theirs: q(1, "theirs"),
            base: A,
            mineAfterKey: null,
            theirsAfterKey: null,
            baseSequence: 4,
            theirsSequence: 5,
        });
        const queued = getPendingEvents(SID)[0].payloadJson as {
            questions: Array<{ payloadJson: Q }>;
        };
        expect(labels(queued.questions.map((x) => x.payloadJson))).toEqual([
            "1:theirs",
            "2:2",
        ]);
        expect(held()).toHaveLength(1);
        expect(questionConflictArrivals.get()).toBe(arrivals + 1);
        // Held conflicts aren't edits in the queue.
        expect(getPendingEvents(SID)).toHaveLength(1);
    });

    test("is held when the page goes away, without looking anything up", async () => {
        const A = q(1);
        snapshot([A], 4);
        const server = fakeServer(4, [A]);
        server.other([q(1, "theirs")]);
        saveQuestionsDebounced(SID, [q(1, "mine")]);
        await flushQuestionSave(SID, true);
        expect(stored()).toHaveLength(1);
        expect(labels(server.list)).toEqual(["1:theirs"]);
        expect(changeLookups()).toHaveLength(0);
        const keepalive = mockFetch.mock.calls
            .filter(([, init]) => init?.method === "PUT")
            .map(([, init]) => init.keepalive);
        expect(keepalive).toEqual([true, true]);
    });

    test("isn't held when both made the same change, or only one side changed it", async () => {
        const A = q(1),
            B = q(2),
            C = q(3, "3", { collapsed: false });
        snapshot([A, B, C], 4);
        const server = fakeServer(4, [A, B, C]);
        // Same answer on both; their edit to B, our fold of B; our edit to
        // C, their fold of C.
        server.other([
            q(1, "same"),
            q(2, "theirs"),
            q(3, "3", { collapsed: true }),
        ]);
        await edit([
            q(1, "same"),
            q(2, "2", { collapsed: true }),
            q(3, "mine", { collapsed: false }),
        ]);
        expect(stored()).toEqual([]);
        expect(server.list).toEqual([
            q(1, "same"),
            q(2, "theirs", { collapsed: true }),
            q(3, "mine", { collapsed: true }),
        ]);
    });

    test("they removed and we edited: held, removed until decided", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(2)]);
        await edit([q(1, "mine"), q(2)]);
        expect(labels(server.list)).toEqual(["2:2"]);
        expect(held()[0]).toMatchObject({
            kind: "they-deleted",
            mine: q(1, "mine"),
            theirs: null,
            mineAfterKey: null,
        });
        expect(held()[0]).not.toHaveProperty("theirsAfterKey");
    });

    test("we removed and they edited: held, kept until decided", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1), q(2, "theirs")]);
        await edit([q(1)]);
        expect(labels(server.list)).toEqual(["1:1", "2:theirs"]);
        expect(held()[0]).toMatchObject({
            kind: "we-deleted",
            mine: null,
            theirs: q(2, "theirs"),
            theirsAfterKey: 1,
        });
    });

    test("names who changed it, and an older API names nobody", async () => {
        snapshot([q(1)], 4);
        const server = fakeServer(4, [q(1)]);
        server.other([q(1, "theirs")], "u3", "Alex");
        await edit([q(1, "mine")]);
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).toEqual({
            userId: "u3",
            displayName: "Alex",
            self: false,
        });
        const url = String(changeLookups()[0][0]);
        expect(url).toContain(
            `/sessions/${SID}/questions/changes?after=4&keys=1`,
        );

        // Ours, on another device.
        store.clear();
        snapshot([q(1)], 4);
        const again = fakeServer(4, [q(1)]);
        again.other([q(1, "theirs")], "u1", "Me");
        await edit([q(1, "mine")]);
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).toMatchObject({ userId: "u1", self: true });

        // No lookup on the server: unknown for good.
        store.clear();
        snapshot([q(1)], 4);
        const old = fakeServer(4, [q(1)]);
        old.other([q(1, "theirs")]);
        const inner = mockFetch.getMockImplementation()!;
        mockFetch.mockImplementation(async (url: string, init?: RequestInit) =>
            String(url).includes("/changes") ? json(404, {}) : inner(url, init),
        );
        await edit([q(1, "mine")]);
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).toBeNull();
    });

    test("is looked up again after a network error", async () => {
        snapshot([q(1)], 4);
        const server = fakeServer(4, [q(1)]);
        server.other([q(1, "theirs")]);
        const inner = mockFetch.getMockImplementation()!;
        mockFetch.mockImplementation(
            async (url: string, init?: RequestInit) => {
                if (String(url).includes("/changes"))
                    throw new TypeError("Failed to fetch");
                return inner(url, init);
            },
        );
        await edit([q(1, "mine")]);
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).toBeUndefined();
        mockFetch.mockImplementation(inner);
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).toMatchObject({
            userId: "u2",
            displayName: "Alex",
        });
    });
});

describe("deciding", () => {
    test("keep mine, once the merged list is shown", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        await edit([q(1, "mine"), q(2)]);
        // The merged list shows: theirs.
        expect(labels(questions.get())).toEqual(["1:theirs", "2:2"]);
        resolveQuestionConflict(SID, 1, "mine");
        expect(held()).toEqual([]);
        expect(labels(questions.get())).toEqual(["1:mine", "2:2"]);
        await saveBoard();
        expect(labels(server.list)).toEqual(["1:mine", "2:2"]);
        expect(stored()).toEqual([]);
    });

    test("keep theirs changes nothing on the server", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1), q(2, "theirs")]);
        await edit([q(1), q(2, "mine")]);
        const seq = server.seq;
        const before = questions.get();
        resolveQuestionConflict(SID, 2, "theirs");
        expect(held()).toEqual([]);
        // Already shown: nothing to save.
        expect(questions.get()).toBe(before);
        expect(server.seq).toBe(seq);
    });

    test("keep mine while the merged save is still unanswered", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        server.hold = true;
        questions.set([q(1, "mine"), q(2)]);
        const first = saveQuestionsToServer(SID, questions.get());
        await vi.waitFor(() => expect(server.held).toHaveLength(1));
        // The board still shows ours as first made.
        const board = questions.get();
        resolveQuestionConflict(SID, 1, "mine");
        // Unchanged, but set again so it's saved: the queued list has theirs.
        expect(questions.get()).not.toBe(board);
        expect(labels(questions.get())).toEqual(["1:mine", "2:2"]);
        const second = saveBoard();
        server.hold = false;
        server.held.forEach((release) => release());
        await Promise.all([first, second]);
        expect(labels(server.list)).toEqual(["1:mine", "2:2"]);
        // And the board, once the merged list is shown, still has ours.
        expect(labels(questions.get())).toEqual(["1:mine", "2:2"]);
        expect(stored()).toEqual([]);
    });

    test("keep theirs while the merged save is still unanswered", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        server.hold = true;
        questions.set([q(1, "mine"), q(2)]);
        const first = saveQuestionsToServer(SID, questions.get());
        await vi.waitFor(() => expect(server.held).toHaveLength(1));
        resolveQuestionConflict(SID, 1, "theirs");
        expect(labels(questions.get())).toEqual(["1:theirs", "2:2"]);
        const second = saveBoard();
        server.hold = false;
        server.held.forEach((release) => release());
        await Promise.all([first, second]);
        expect(labels(server.list)).toEqual(["1:theirs", "2:2"]);
        expect(labels(questions.get())).toEqual(["1:theirs", "2:2"]);
    });

    test("keep mine after a reload, the merged save's answer lost", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        server.lose = true;
        await edit([q(1, "mine"), q(2)]);
        server.lose = false;
        // Reopened: the board shows the queued (merged) list, on its base.
        const cached = getCachedSession(SID)!;
        questions.set(
            suppressQuestionSave(applyUnsyncedEvents(SID, cached).questions),
        );
        setBoardBase(SID, queuedQuestionsBase(SID)!);
        trackBoardQuestions(SID, questions.get(), false);
        expect(labels(questions.get())).toEqual(["1:theirs", "2:2"]);
        expect(held()).toHaveLength(1);

        resolveQuestionConflict(SID, 1, "mine");
        await saveBoard();
        await flushPendingEvents(SID);
        expect(labels(server.list)).toEqual(["1:mine", "2:2"]);
    });

    test("asks again if theirs changed again before the decision landed", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        await edit([q(1, "mine"), q(2)]);
        resolveQuestionConflict(SID, 1, "mine");
        const arrivals = questionConflictArrivals.get();
        // They change it again before our decision is saved.
        server.other([q(1, "theirs again"), q(2)]);
        await saveBoard();
        expect(labels(server.list)).toEqual(["1:theirs again", "2:2"]);
        expect(held()).toHaveLength(1);
        expect(held()[0]).toMatchObject({
            mine: q(1, "mine"),
            theirs: q(1, "theirs again"),
        });
        expect(questionConflictArrivals.get()).toBe(arrivals + 1);
    });

    test("puts a question removed on one side back where it was", async () => {
        snapshot([q(1), q(2), q(3)], 4);
        const server = fakeServer(4, [q(1), q(2), q(3)]);
        server.other([q(1), q(3)]);
        await edit([q(1), q(2, "mine"), q(3)]);
        expect(labels(questions.get())).toEqual(["1:1", "3:3"]);
        resolveQuestionConflict(SID, 2, "mine");
        expect(labels(questions.get())).toEqual(["1:1", "2:mine", "3:3"]);
        await saveBoard();
        expect(labels(server.list)).toEqual(["1:1", "2:mine", "3:3"]);
    });

    test("all at once", async () => {
        snapshot([q(1), q(2), q(3)], 4);
        const server = fakeServer(4, [q(1), q(2), q(3)]);
        server.other([q(1, "theirs"), q(3, "theirs")]);
        await edit([q(1, "mine"), q(2, "mine"), q(3)]);
        // q(3): only they changed it.
        expect(held().map((c) => [c.key, c.kind])).toEqual([
            [1, "both-changed"],
            [2, "they-deleted"],
        ]);
        resolveAllQuestionConflicts(SID, "mine");
        expect(held()).toEqual([]);
        await saveBoard();
        expect(labels(server.list)).toEqual(["1:mine", "2:mine", "3:theirs"]);
    });

    test("keeps how the card is shown here", async () => {
        snapshot([q(1)], 4);
        const server = fakeServer(4, [q(1)]);
        server.other([q(1, "theirs")]);
        await edit([q(1, "mine")]);
        // Folded meanwhile.
        await edit([q(1, "theirs", { collapsed: true })]);
        expect(held()).toHaveLength(1);
        resolveQuestionConflict(SID, 1, "mine");
        expect(questions.get()).toEqual([q(1, "mine", { collapsed: true })]);
    });
});

describe("a decision", () => {
    test("doesn't touch a later change of theirs to the same version", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        await edit([q(1, "mine"), q(2)]);
        resolveQuestionConflict(SID, 1, "mine");
        await saveBoard();
        expect(labels(server.list)).toEqual(["1:mine", "2:2"]);
        // Later they set it back to theirs while we edit another question.
        server.other([q(1, "theirs"), q(2)]);
        await edit([q(1, "mine"), q(2, "edited")]);
        expect(stored()).toEqual([]);
        expect(labels(server.list)).toEqual(["1:theirs", "2:edited"]);
        expect(labels(questions.get())).toEqual(["1:theirs", "2:edited"]);
    });
});

describe("conflicts that can't be stored", () => {
    test("save ours, as before", async () => {
        snapshot([q(1)], 4);
        const server = fakeServer(4, [q(1)]);
        server.other([q(1, "theirs")]);
        const setItem = localStorage.setItem.bind(localStorage);
        vi.spyOn(localStorage, "setItem").mockImplementation(
            (key: string, value: string) => {
                if (key.startsWith("taibled-conflicts-"))
                    throw new DOMException("full", "QuotaExceededError");
                setItem(key, value);
            },
        );
        await edit([q(1, "mine")]);
        expect(labels(server.list)).toEqual(["1:mine"]);
        expect(held()).toEqual([]);
    });
});

describe("a held conflict", () => {
    async function holdOne() {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1, "theirs"), q(2)]);
        await edit([q(1, "mine"), q(2)]);
        expect(held()).toHaveLength(1);
        return server;
    }

    test("goes once the server has ours", async () => {
        await holdOne();
        reconcileQuestionConflicts(SID, [q(1, "mine"), q(2)], 99);
        expect(held()).toEqual([]);
    });

    test("is updated when theirs changes again", async () => {
        await holdOne();
        await lookUpConflictAuthors(SID);
        expect(held()[0].author).not.toBeUndefined();
        reconcileQuestionConflicts(SID, [q(2), q(1, "newer")], 99);
        expect(held()[0]).toMatchObject({
            kind: "both-changed",
            theirs: q(1, "newer"),
            theirsSequence: 99,
            theirsAfterKey: 2,
            changedAgain: true,
        });
        expect(held()[0].author).toBeUndefined();
        reconcileQuestionConflicts(SID, [q(2)], 100);
        expect(held()[0]).toMatchObject({ kind: "they-deleted", theirs: null });
    });

    test("isn't touched by a list no newer than theirs", async () => {
        await holdOne();
        const before = held();
        reconcileQuestionConflicts(
            SID,
            [q(1, "mine"), q(2)],
            before[0].theirsSequence,
        );
        expect(held()).toEqual(before);
    });

    test("is decided by the player's edit of it, not by a fold", async () => {
        await holdOne();
        await edit([q(1, "theirs", { collapsed: true }), q(2)]);
        expect(held()).toHaveLength(1);
        await edit([q(1, "edited"), q(2)]);
        expect(held()).toEqual([]);
    });

    test("isn't decided by an edit of another question", async () => {
        await holdOne();
        await edit([q(1, "theirs"), q(2, "edited")]);
        expect(held()).toHaveLength(1);
    });

    test("belongs to the account and session it was held for", async () => {
        await holdOne();
        verifiedUserId.set("u2");
        expect(held()).toEqual([]);
        verifiedUserId.set("u1");
        expect(held()).toHaveLength(1);
        activeSessionId.set("another");
        expect(held()).toEqual([]);
        activeSessionId.set(SID);
        expect(held()).toHaveLength(1);
        // Loaded again, not new.
        const arrivals = questionConflictArrivals.get();
        verifiedUserId.set(null);
        verifiedUserId.set("u1");
        expect(questionConflictArrivals.get()).toBe(arrivals);
    });

    test("goes with the session's data", async () => {
        await holdOne();
        store.set(
            `taibled-conflicts-${SID}~u2`,
            store.get(`taibled-conflicts-${SID}~u1`)!,
        );
        discardSessionData(SID);
        expect(held()).toEqual([]);
        expect(store.has(`taibled-conflicts-${SID}~u2`)).toBe(true);
        discardSessionData(SID, { allAccounts: true });
        expect(
            [...store.keys()].filter((k) => k.startsWith("taibled-conflicts-")),
        ).toEqual([]);
    });
});

describe("a game revision without the question's kind", () => {
    const layer = (name: string) => ({
        name,
        enabledFor: ["matching", "measuring", "tentacle"],
        data: {
            type: "FeatureCollection",
            features: [10, 10.1].map((lng, i) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [lng, 50] },
                properties: { name: `${name} ${i}` },
            })),
        },
    });
    const game = (...layers: string[]) =>
        ({
            id: "conflicts",
            name: "Conflicts",
            serverId: "home-games",
            map: {
                center: [10, 50],
                playArea: { type: "FeatureCollection", features: [] },
            },
            hidingZones: {
                radius: 500,
                unit: "meters",
                features: { type: "FeatureCollection", features: [] },
            },
            radars: [500, 1000],
            features: layers.map(layer),
        }) as unknown as GameDefinition;
    const museum = (label: string) =>
        ({
            id: "matching",
            key: 5,
            data: { type: "matching-museum", label },
        }) as unknown as Q;

    afterEach(() => {
        gameDefinitionReady.set(false);
        setActiveGameDefinition(null);
    });

    test("doesn't ask about it, and keeps it for a revision that has it", async () => {
        snapshot([q(1), museum("base")], 4);
        const server = fakeServer(4, [q(1), museum("base")]);
        server.other([q(1, "theirs"), museum("theirs")]);
        await edit([q(1, "mine"), museum("mine")]);
        expect(held().map((c) => c.key)).toEqual([1, 5]);

        setActiveGameDefinition(game("Airport"));
        gameDefinitionReady.set(true);
        expect(held().map((c) => c.key)).toEqual([1]);
        // Deciding all decides only what's asked.
        resolveAllQuestionConflicts(SID, "mine");
        expect(held()).toEqual([]);
        expect(stored().map((c) => c.key)).toEqual([5]);

        setActiveGameDefinition(game("Airport", "Museum"));
        expect(held().map((c) => c.key)).toEqual([5]);
    });
});

// Two players editing the same session online, each save answered (or its
// answer held up, or lost). Nothing either does is lost or comes back, and
// nobody is asked anything: they never change the same question.
describe("two players editing online", () => {
    const keysOf = (list: readonly unknown[]) =>
        list.map((x) => (x as { key: number }).key).sort((a, b) => a - b);

    test("editing and adding different questions, saves answered", async () => {
        snapshot([q(1), q(2), q(3)], 4);
        const server = fakeServer(4, [q(1), q(2), q(3)]);
        let board = questions.get();
        for (let round = 0; round < 4; round++) {
            // They edit question 2 and add one; we edit question 1 and add one.
            server.other([
                ...server.list.map((x) =>
                    (x as unknown as { key: number }).key === 2
                        ? q(2, `theirs ${round}`)
                        : x,
                ),
                q(100 + round),
            ]);
            board = questions.get();
            await edit([
                ...board.map((x) =>
                    (x as unknown as { key: number }).key === 1
                        ? q(1, `mine ${round}`)
                        : x,
                ),
                q(10 + round),
            ]);
        }
        expect(stored()).toEqual([]);
        expect(keysOf(server.list)).toEqual([
            1, 2, 3, 10, 11, 12, 13, 100, 101, 102, 103,
        ]);
        expect(
            labels(
                server.list.filter((x) =>
                    [1, 2].includes((x as unknown as { key: number }).key),
                ),
            ),
        ).toEqual(["1:mine 3", "2:theirs 3"]);
        expect(keysOf(questions.get())).toEqual(keysOf(server.list));
    });

    test("removing different questions: they stay removed", async () => {
        snapshot([q(1), q(2), q(3), q(4)], 4);
        const server = fakeServer(4, [q(1), q(2), q(3), q(4)]);
        server.other([q(1), q(3, "theirs"), q(4)]);
        await edit([q(2), q(3), q(4)]);
        expect(keysOf(server.list)).toEqual([3, 4]);
        expect(stored()).toEqual([]);
    });

    test("editing while a merged save is on its way", async () => {
        // The case f097d6953 broke: their added question was removed.
        const A = q(1),
            Q1 = q(2),
            B2 = q(3),
            Q3 = q(4);
        snapshot([A], 4);
        const server = fakeServer(4, [A]);
        server.other([A, B2]);
        server.hold = true;
        questions.set([A, Q1]);
        const first = saveQuestionsToServer(SID, [A, Q1]);
        await vi.waitFor(() => expect(server.held).toHaveLength(1));
        // The board still shows [A, Q1]; we add Q3 and edit A.
        const second = edit([q(1, "mine"), Q1, Q3]);
        server.hold = false;
        server.held.forEach((release) => release());
        await Promise.all([first, second]);
        await flushPendingEvents(SID);
        expect(keysOf(server.list)).toEqual([1, 2, 3, 4]);
        expect(
            labels(
                server.list.filter(
                    (x) => (x as unknown as { key: number }).key === 1,
                ),
            ),
        ).toEqual(["1:mine"]);
        expect(stored()).toEqual([]);
    });

    for (const landed of [true, false]) {
        test(`editing the same question again after a merged save's answer was lost (it ${landed ? "landed" : "didn't land"})`, async () => {
            snapshot([q(1), q(2)], 4);
            const server = fakeServer(4, [q(1), q(2)]);
            server.other([q(1), q(2, "theirs"), q(3)]);
            if (landed) server.lose = true;
            else
                mockFetch
                    .mockImplementationOnce(async () =>
                        json(409, { code: "QUESTIONS_CHANGED" }),
                    )
                    .mockImplementationOnce(async () =>
                        json(200, {
                            questions: wire(server.list),
                            sequence: server.seq,
                        }),
                    )
                    .mockImplementationOnce(async () => {
                        throw new TypeError("Failed to fetch");
                    });
            await edit([q(1, "mine"), q(2)]);
            server.lose = false;
            // The board still shows ours as first made; we edit q(1) again.
            await edit([q(1, "mine again"), q(2)]);
            await flushPendingEvents(SID);
            expect(stored()).toEqual([]);
            expect(labels(server.list)).toEqual([
                "1:mine again",
                "2:theirs",
                "3:3",
            ]);
        });
    }

    test("editing the same question again after a reload, the merged save landed but its answer lost", async () => {
        snapshot([q(1), q(2)], 4);
        const server = fakeServer(4, [q(1), q(2)]);
        server.other([q(1), q(2, "theirs")]);
        server.lose = true;
        await edit([q(1, "mine"), q(2)]);
        server.lose = false;
        const cached = getCachedSession(SID)!;
        questions.set(
            suppressQuestionSave(applyUnsyncedEvents(SID, cached).questions),
        );
        setBoardBase(SID, queuedQuestionsBase(SID)!);
        trackBoardQuestions(SID, questions.get(), false);
        await edit([q(1, "mine again"), q(2, "theirs")]);
        await flushPendingEvents(SID);
        expect(stored()).toEqual([]);
        expect(labels(server.list)).toEqual(["1:mine again", "2:theirs"]);
    });
});
