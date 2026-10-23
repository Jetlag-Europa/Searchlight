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
    getCachedSession,
    getPendingEvents,
    questionsBase,
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
        expect(getCachedSession(SID)?.serverQuestions).toEqual({
            sequence: 8,
            questions: [q(1), q(2)],
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

    test("follows a list that was saved as is with one based on it, without merging", async () => {
        snapshot("u1", [], 4);
        // Offline: two edits, the second replacing the first in the queue.
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
        await saveQuestionsToServer(SID, [q(1)]).catch(() => {});
        await saveQuestionsToServer(SID, [q(1), q(2)]).catch(() => {});
        const [queued] = getPendingEvents(SID);
        expect(
            (queued.payloadJson as { base: { sequence: number } }).base.sequence,
        ).toBe(4);

        mockFetch.mockReset();
        mockFetch.mockResolvedValueOnce(json(200, { sequence: 5 }));
        await flushPendingEvents(SID);
        expect(puts()).toHaveLength(1);
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
