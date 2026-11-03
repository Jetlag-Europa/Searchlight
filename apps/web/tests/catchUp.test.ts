// A save of ours answered at a sequence the stream has gone past: the board
// catches up by reading the server's list (see runCatchUp in sseManager).
// From the 2026-11-03 release audit (SYNC-02, SYNC-06).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const SID = "catch-up-session";
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
    get length() {
        return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
});
class MockEventSource {
    static CLOSED = 2;
    onopen: unknown;
    onmessage: unknown;
    onerror: unknown;
    readyState = 1;
    close() {}
}
vi.stubGlobal("EventSource", MockEventSource);
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { activeSessionId } from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { enqueueEvent, getCachedSession, setCachedSession } from "@/lib/eventQueue";
import { startSSE, stopSSE } from "@/lib/sseManager";
import { sendPendingEvent } from "@/lib/syncManager";
import type { Questions } from "@/maps/schema";

const q = (key: number) => ({ id: "radius", key, data: { radius: key } });
const wire = (list: unknown[]) =>
    list.map((payloadJson, ordinal) => ({ clientUuid: `q-${ordinal}`, ordinal, payloadJson }));

// Our list [Q1] landed at 1, its answer lost; another player's [Q1, Q2] at 2.
// A reload started the stream from 2, with ours still queued.
function lostAnswer() {
    setCachedSession({
        sessionId: SID,
        strokes: [],
        questions: [q(1)] as unknown as Questions,
        serverQuestions: { sequence: 0, questions: [] },
        lastSyncedAt: 0,
        lastSequence: 2,
    });
    questions.set([q(1)] as unknown as Questions);
    return enqueueEvent({
        sessionId: SID,
        type: "questions.replace",
        clientUuid: "questions-replace-lost",
        clientCreatedAt: 0,
        payloadJson: {
            replacementId: "lost",
            base: { sequence: 0, questions: [] },
            questions: wire([q(1)]),
        },
    });
}
// The retry is answered as the duplicate it is.
const duplicate = () => Response.json({ sequence: 1, duplicate: true });
const serverList = () => Response.json({ sequence: 2, questions: wire([q(1), q(2)]) });
const tick = async () => {
    for (let n = 0; n < 50; n++) await Promise.resolve();
};

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    activeSessionId.set(SID);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    stopSSE();
    activeSessionId.set("");
    vi.useRealTimers();
    vi.restoreAllMocks();
});

test("keeps the board it shows with its base, for a reload before the next event", async () => {
    const event = lostAnswer();
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === "PUT" ? duplicate() : serverList(),
    );
    startSSE(SID);
    await sendPendingEvent(event);
    await tick();
    expect(questions.get()).toEqual([q(1), q(2)]);
    const kept = getCachedSession(SID)!;
    expect(kept.serverQuestions).toEqual({ sequence: 2, questions: [q(1), q(2)] });
    expect(kept.questions).toEqual([q(1), q(2)]);
});

test("gives up on a read that never answers, and reads again", async () => {
    vi.useFakeTimers();
    const event = lostAnswer();
    let reads = 0;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") return Promise.resolve(duplicate());
        if (++reads > 1) return Promise.resolve(serverList());
        return new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
        );
    });
    startSSE(SID);
    await sendPendingEvent(event);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(reads).toBe(1);
    expect(questions.get()).toEqual([q(1)]);
    // Aborted at 45 seconds; read again 3 seconds later.
    await vi.advanceTimersByTimeAsync(3_001);
    expect(reads).toBe(2);
    expect(questions.get()).toEqual([q(1), q(2)]);
});

test("reads again after a proxy's 403", async () => {
    vi.useFakeTimers();
    const event = lostAnswer();
    let reads = 0;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") return duplicate();
        if (++reads > 1) return serverList();
        return new Response("<html>Access denied</html>", {
            status: 403,
            headers: { "content-type": "text/html" },
        });
    });
    startSSE(SID);
    await sendPendingEvent(event);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reads).toBe(2);
    expect(questions.get()).toEqual([q(1), q(2)]);
});
