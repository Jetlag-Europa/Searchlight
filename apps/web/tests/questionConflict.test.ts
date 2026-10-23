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

import {
    activeSessionId,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    applyUnsyncedEvents,
    discardSessionData,
    getCachedSession,
    getPendingEvents,
    queuedQuestionsBase,
    questionsBase,
    setBoardBase,
    setCachedSession,
} from "@/lib/eventQueue";
import { saveQuestionsToServer } from "@/lib/sessionState";
import {
    flushPendingEvents,
    onQuestionsSaved,
    type QuestionsSaved,
    startSyncManager,
    stopSyncManager,
} from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const SID = "conflict-session";
const q = (key: number) =>
    ({ id: "radius", key, data: { label: String(key) } }) as unknown as Questions[number];
const wire = (questions: Questions) =>
    questions.map((payloadJson, ordinal) => ({
        clientUuid: `server-${ordinal}`,
        ordinal,
        payloadJson,
    }));

function snapshot(userId: string, questions: Questions, sequence: number) {
    setCachedSession({
        sessionId: SID,
        userId,
        strokes: [],
        questions,
        serverQuestions: { sequence, questions },
        lastSyncedAt: 1,
        lastSequence: sequence,
    });
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
const puts = () =>
    mockFetch.mock.calls
        .filter(([, init]) => init?.method === "PUT")
        .map(([, init]) => JSON.parse(init.body as string));

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    verifiedUserId.set("u1");
    offlineUserId.set(null);
    activeSessionId.set(SID);
    startSyncManager();
});

afterEach(() => {
    stopSyncManager();
    activeSessionId.set("");
    verifiedUserId.set(null);
    vi.restoreAllMocks();
});

describe("saving a question list made on an old base", () => {
    test("merges with what another device saved meanwhile, keeping both", async () => {
        // The snapshot had no questions at sequence 4; offline we add one.
        snapshot("u1", [], 4);
        const saved: QuestionsSaved[] = [];
        const stop = onQuestionsSaved((s) => saved.push(s));
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([q(2)]), sequence: 7 }))
            .mockResolvedValueOnce(json(200, { sequence: 8 }));

        await saveQuestionsToServer(SID, [q(1)]);
        stop();

        const [first, second] = puts();
        expect(first.baseSequence).toBe(4);
        expect(first.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(1)]);
        expect(second.baseSequence).toBe(7);
        expect(second.replacementId).toBe(first.replacementId);
        expect(second.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([
            q(1),
            q(2),
        ]);
        // Theirs keeps its id.
        expect(second.questions[1].clientUuid).toBe("server-0");
        expect(getPendingEvents(SID)).toEqual([]);
        // The board still shows only ours: its base is ours, as of the list
        // merged with, until the merged list is shown (SessionManager).
        expect(getCachedSession(SID)?.serverQuestions).toEqual({
            sequence: 7,
            questions: [q(1)],
        });
        expect(saved).toHaveLength(1);
        expect(saved[0].saved).toEqual([q(1), q(2)]);
        expect(saved[0].mergedWith?.sequence).toBe(7);
    });

    test("saves as before, over the server's list, when nothing changed there", async () => {
        snapshot("u1", [q(1)], 4);
        mockFetch.mockResolvedValueOnce(json(200, { sequence: 5 }));
        await saveQuestionsToServer(SID, [q(1), q(2)]);
        expect(puts()).toHaveLength(1);
        expect(questionsBase(SID)).toEqual({
            sequence: 5,
            questions: [q(1), q(2)],
        });
    });

    test("sends no base when this browser knows none, as builds from before did", async () => {
        mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await saveQuestionsToServer(SID, [q(1)]);
        expect(puts()[0]).not.toHaveProperty("baseSequence");
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("keeps the edit queued while the server keeps changing, to merge later", async () => {
        snapshot("u1", [], 4);
        mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
            init?.method === "PUT"
                ? json(409, { code: "QUESTIONS_CHANGED" })
                : json(200, { questions: [], sequence: 9 }),
        );
        await expect(saveQuestionsToServer(SID, [q(1)])).rejects.toThrow();
        expect(getPendingEvents(SID)).toHaveLength(1);
        expect(getPendingEvents(SID)[0].status).toBe("failed");
    });

    test("replays an earlier list whose send failed before the one replacing it", async () => {
        snapshot("u1", [], 4);
        // Two edits on a bad connection: the first send fails (it may have
        // reached the server), and the second replaces it in the queue.
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [q(1)]).catch(() => {});
        await saveQuestionsToServer(SID, [q(1), q(2)]).catch(() => {});
        const queued = getPendingEvents(SID);
        expect(queued).toHaveLength(1);
        const payload = queued[0].payloadJson as {
            base: { sequence: number };
            prior: Array<{ baseSequence: number }>;
        };
        expect(payload.base.sequence).toBe(4);
        expect(payload.prior.map((p) => p.baseSequence)).toEqual([4]);

        // The first had landed (at 5): the second follows on from it.
        mockFetch.mockReset();
        mockFetch
            .mockResolvedValueOnce(json(200, { sequence: 5, duplicate: true }))
            .mockResolvedValueOnce(json(200, { sequence: 6 }));
        await flushPendingEvents(SID);
        const [replay, last] = puts();
        expect(replay.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(1)]);
        expect(last.baseSequence).toBe(5);
        expect(last.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(1), q(2)]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

});

describe("an edit made while the last save is on its way", () => {
    test("follows on from that save, so nothing it removed comes back", async () => {
        snapshot("u1", [], 4);
        let answerFirst!: (res: Response) => void;
        mockFetch
            .mockReturnValueOnce(new Promise<Response>((resolve) => (answerFirst = resolve)))
            .mockResolvedValueOnce(json(200, { sequence: 6 }));

        const first = saveQuestionsToServer(SID, [q(1)]);
        // Added and then removed again before the first save is answered.
        const second = saveQuestionsToServer(SID, [q(2)]);
        answerFirst(json(200, { sequence: 5 }));
        await Promise.all([first, second]);

        const [, secondPut] = puts();
        expect(puts()).toHaveLength(2);
        expect(secondPut.baseSequence).toBe(5);
        expect(secondPut.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(2)]);
    });
});

describe("a merged save whose answer was lost", () => {
    test("is retried as merged, so the other side's questions stay", async () => {
        snapshot("u1", [], 4);
        const saved: QuestionsSaved[] = [];
        const stop = onQuestionsSaved((s) => saved.push(s));
        // Another device added q(2) at 7. Our save: 409, read, merged save
        // commits at 8 but its answer is lost.
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([q(2)]), sequence: 7 }))
            .mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [q(1)]).catch(() => {});

        const [queued] = getPendingEvents(SID);
        const payload = queued.payloadJson as {
            questions: Array<{ payloadJson: unknown }>;
            base: { sequence: number };
            merged: { local: unknown[]; base: { sequence: number } };
        };
        expect(payload.questions.map((x) => x.payloadJson)).toEqual([q(1), q(2)]);
        expect(payload.base.sequence).toBe(7);
        expect(payload.merged.local).toEqual([q(1)]);
        expect(payload.merged.base.sequence).toBe(4);

        // The retry: the server knows it, and answers its sequence.
        mockFetch.mockResolvedValueOnce(json(200, { sequence: 8, duplicate: true }));
        await flushPendingEvents(SID);
        const retry = puts().at(-1);
        expect(retry.replacementId).toBe(puts()[0].replacementId);
        expect(retry.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(1), q(2)]);
        // Still read as a merge, so the board shows q(2).
        expect(saved.at(-1)?.mergedWith?.sequence).toBe(7);
        expect(saved.at(-1)?.saved).toEqual([q(1), q(2)]);
        stop();

        // The board, now showing both, is saved with an edit: q(2) stays.
        setBoardBase(SID, { sequence: 8, questions: [q(1), q(2)] });
        mockFetch.mockResolvedValueOnce(json(200, { sequence: 9 }));
        await saveQuestionsToServer(SID, [q(1), q(2), q(3)]);
        const last = puts().at(-1);
        expect(last.baseSequence).toBe(8);
        expect(last.questions.map((x: { payloadJson: { key: number } }) => x.payloadJson.key)).toEqual([1, 2, 3]);
    });
});

describe("a board reopened offline after a merged save's answer was lost", () => {
    test("is based on the list it was merged with, so removals stay removed", async () => {
        const A = q(1), Q1 = q(2), B2 = q(3);
        snapshot("u1", [A], 4);
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([A, B2]), sequence: 7 }))
            .mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [A, Q1]).catch(() => {});

        // Reopened offline: the board shows the queued (merged) list, and
        // takes its base (SessionManager's paint does this).
        const board = applyUnsyncedEvents(SID, getCachedSession(SID)!).questions;
        expect(board).toEqual([A, Q1, B2]);
        setBoardBase(SID, queuedQuestionsBase(SID)!);
        expect(questionsBase(SID)?.sequence).toBe(7);

        // Offline we remove Q1.
        mockFetch.mockReset();
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [A, B2]).catch(() => {});

        // The merged save had committed at 8; then they removed B2 at 9. A
        // server knows a save it has by its replacementId.
        const merged = puts()[0].replacementId;
        mockFetch.mockReset();
        mockFetch.mockImplementation(async (_u: string, init?: RequestInit) => {
            if (init?.method !== "PUT") return json(200, { questions: wire([A, Q1]), sequence: 9 });
            const body = JSON.parse(init.body as string);
            if (body.replacementId === merged) return json(200, { sequence: 8, duplicate: true });
            return body.baseSequence < 9 ? json(409, { code: "QUESTIONS_CHANGED" }) : json(200, { sequence: 10 });
        });
        await flushPendingEvents(SID);
        expect(puts().at(-1).questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([A]);
    });

    test("keeps our offline edits if that merged save never landed", async () => {
        const A = q(1), Q1 = q(2), B2 = q(3);
        snapshot("u1", [A], 4);
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([A, B2]), sequence: 7 }))
            .mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [A, Q1]).catch(() => {});
        setBoardBase(SID, queuedQuestionsBase(SID)!);
        // Offline we change A and keep Q1.
        const A2 = { ...A, data: { label: "A edited" } } as unknown as Questions[number];
        mockFetch.mockReset();
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [A2, Q1, B2]).catch(() => {});

        // Nothing of ours landed; they removed B2 at 9.
        mockFetch.mockReset();
        mockFetch.mockImplementation(async (_u: string, init?: RequestInit) => {
            if (init?.method !== "PUT") return json(200, { questions: wire([A]), sequence: 9 });
            const body = JSON.parse(init.body as string);
            return body.baseSequence < 9 ? json(409, { code: "QUESTIONS_CHANGED" }) : json(200, { sequence: 10 });
        });
        await flushPendingEvents(SID);
        expect(puts().at(-1).questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([A2, Q1]);
    });
});

describe("a merged list that can't be queued for want of space", () => {
    test("is still sent", async () => {
        snapshot("u1", [], 4);
        const setItem = localStorage.setItem.bind(localStorage);
        vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
            if (key.startsWith("taibled-pending-") && value.includes('"merged"')) {
                throw new DOMException("full", "QuotaExceededError");
            }
            setItem(key, value);
        });
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([q(2)]), sequence: 7 }))
            .mockResolvedValueOnce(json(200, { sequence: 8 }));
        await saveQuestionsToServer(SID, [q(1)]);
        expect(puts().at(-1).questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([q(1), q(2)]);
        expect(getPendingEvents(SID)).toEqual([]);
    });
});

describe("the base of a list", () => {
    const edited = (key: number) =>
        ({ id: "radius", key, data: { label: `${key} edited` } }) as unknown as Questions[number];

    test("is what the board showed when it was made, so their later change to their question wins", async () => {
        snapshot("u1", [], 4);
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([q(2)]), sequence: 7 }))
            .mockResolvedValueOnce(json(200, { sequence: 8 }));
        await saveQuestionsToServer(SID, [q(1)]);
        // The merged list is shown (SessionManager does this).
        setBoardBase(SID, { sequence: 8, questions: [q(1), q(2)] });

        // We edit q(1); meanwhile the other device edited q(2).
        mockFetch
            .mockResolvedValueOnce(json(409, { code: "QUESTIONS_CHANGED" }))
            .mockResolvedValueOnce(json(200, { questions: wire([q(1), edited(2)]), sequence: 9 }))
            .mockResolvedValueOnce(json(200, { sequence: 10 }));
        await saveQuestionsToServer(SID, [edited(1), q(2)]);
        const last = puts().at(-1);
        expect(last.questions.map((x: { payloadJson: unknown }) => x.payloadJson)).toEqual([
            edited(1),
            edited(2),
        ]);
    });
});

describe("discarding a session", () => {
    test("takes every account's queue when the session is gone, only ours when we lost access", async () => {
        snapshot("u1", [], 4);
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [q(1)]).catch(() => {});
        verifiedUserId.set("u2");
        await saveQuestionsToServer(SID, [q(2)]).catch(() => {});

        discardSessionData(SID);
        expect(getPendingEvents(SID)).toEqual([]);
        verifiedUserId.set("u1");
        expect(getPendingEvents(SID)).toHaveLength(1);

        discardSessionData(SID, { allAccounts: true });
        expect([...store.keys()].filter((k) => k.startsWith("taibled-pending-"))).toEqual([]);
    });
});

describe("queued edits", () => {
    test("belong to the account that made them", async () => {
        snapshot("u1", [], 4);
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [q(1)]).catch(() => {});
        expect(getPendingEvents(SID)).toHaveLength(1);

        // Another account on this browser neither sees nor sends them.
        verifiedUserId.set("u2");
        expect(getPendingEvents(SID)).toEqual([]);
        expect(applyUnsyncedEvents(SID, { strokes: [], questions: [] }).questions).toEqual([]);
        mockFetch.mockReset();
        await flushPendingEvents(SID);
        expect(mockFetch).not.toHaveBeenCalled();

        // Played offline, the same account gets them back.
        verifiedUserId.set(null);
        offlineUserId.set("u1");
        expect(getPendingEvents(SID)).toHaveLength(1);
        offlineUserId.set(null);
    });

    test("wait for /me before they're sent, when played offline", async () => {
        snapshot("u1", [], 4);
        verifiedUserId.set(null);
        offlineUserId.set("u1");
        await expect(saveQuestionsToServer(SID, [q(1)])).rejects.toThrow("/me");
        expect(mockFetch).not.toHaveBeenCalled();
        expect(getPendingEvents(SID)).toHaveLength(1);

        // /me verifies u1: the same queue goes out.
        verifiedUserId.set("u1");
        offlineUserId.set(null);
        mockFetch.mockResolvedValueOnce(json(200, { sequence: 5 }));
        await flushPendingEvents(SID);
        expect(puts()).toHaveLength(1);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    test("queued by a build from before go to the snapshot's owner only", () => {
        snapshot("u1", [], 4);
        verifiedUserId.set(null);
        store.set(
            `taibled-pending-${SID}`,
            JSON.stringify([
                {
                    localId: "legacy",
                    sessionId: SID,
                    type: "hider.update",
                    payloadJson: { hiderLat: 1, hiderLng: 2 },
                    clientUuid: "hider-legacy",
                    clientCreatedAt: 0,
                    status: "pending",
                    createdAt: 0,
                },
            ]),
        );
        verifiedUserId.set("u2");
        expect(getPendingEvents(SID)).toEqual([]);
        verifiedUserId.set("u1");
        expect(getPendingEvents(SID).map((e) => e.localId)).toEqual(["legacy"]);
        expect(store.has(`taibled-pending-${SID}`)).toBe(false);
    });
});
