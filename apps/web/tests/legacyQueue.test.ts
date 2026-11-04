// A queue from a build before queues were per account (prod's format), as
// it moves to its account's queue. From the 2026-11-04 release audit, round 3
// (SYNC3-GPT-1, SYNC3-GPT-2).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("react-toastify", () => ({
    toast: { error: vi.fn(), dismiss: vi.fn() },
}));

const SID = "legacy-session";
const LEGACY = `taibled-pending-${SID}`;

// localStorage with a quota (in UTF-16 chars, like browsers count it).
const store = new Map<string, string>();
let capacity = Infinity;
const used = () => {
    let n = 0;
    for (const [k, v] of store) n += k.length + v.length;
    return n;
};
const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        const before = store.get(k);
        const next =
            used() - (before ? k.length + before.length : 0) + k.length + v.length;
        if (next > capacity) throw new DOMException("quota", "QuotaExceededError");
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
        return store.size;
    },
};

const question = (key: number) => ({
    id: "radius",
    key,
    data: { radius: key, lat: 0, lng: 0 },
});
// A question list as queued: "old" by the build from before (no base),
// "new" by this one.
const list = (id: "old" | "new", keys: number[]) => ({
    sessionId: SID,
    localId: id,
    type: "questions.replace",
    clientUuid: `questions-replace-${id}`,
    clientCreatedAt: id === "old" ? 1 : 2,
    createdAt: id === "old" ? 1 : 2,
    status: "pending",
    payloadJson: {
        replacementId: id,
        questions: keys.map((key, ordinal) => ({
            clientUuid: `${id}-${key}`,
            ordinal,
            payloadJson: question(key),
        })),
        ...(id === "new" ? { base: { sequence: 0, questions: [] } } : {}),
    },
});
const stroke = (id: string) => ({
    sessionId: SID,
    localId: id,
    type: "stroke.create",
    clientUuid: id,
    clientCreatedAt: 1,
    createdAt: 1,
    status: "pending",
    payloadJson: {
        id,
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: [
                [0, 0],
                [1, 1],
            ],
        },
        properties: {},
    },
});

// A fresh page (as after a reload) signed in as `user`.
async function page(user: string) {
    vi.resetModules();
    const active = await import("@/lib/activeSession");
    active.verifiedUserId.set(user);
    active.activeSessionId.set("");
    return {
        queue: await import("@/lib/eventQueue"),
        state: await import("@/lib/sessionState"),
        sync: await import("@/lib/syncManager"),
    };
}

beforeEach(() => {
    store.clear();
    capacity = Infinity;
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", {
        getItem: () => null,
        setItem() {},
        removeItem() {},
    });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal(
        "document",
        Object.assign(new EventTarget(), { visibilityState: "visible" }),
    );
    vi.stubGlobal("window", new EventTarget());
    for (const method of ["info", "warn", "error"] as const)
        vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// Copied, the old list comes first and is replaced by the newer one; with
// no room to copy it, it mustn't be sent after the newer one instead.
test.each([false, true])(
    "an older list is never sent after this account's newer one (storage full: %s)",
    async (full) => {
        const me = await page("A");
        me.queue.setCachedSession({
            sessionId: SID,
            userId: "A",
            strokes: [],
            questions: [],
            serverQuestions: { sequence: 0, questions: [] },
            lastSyncedAt: 0,
            lastSequence: 0,
        });
        store.set(LEGACY, JSON.stringify([list("old", [1]), stroke("s1")]));
        store.set(`${LEGACY}~A`, JSON.stringify([list("new", [1, 2])]));
        if (full) capacity = used() + 10;
        let server: number[] = [];
        const sent: string[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                const body = JSON.parse(init!.body as string);
                if (url.includes("/strokes")) {
                    sent.push(`stroke ${body.clientUuid}`);
                    return Response.json({ sequence: 2 });
                }
                sent.push(body.replacementId);
                server = body.questions.map(
                    (q: { payloadJson: { key: number } }) => q.payloadJson.key,
                );
                return body.baseSequence === undefined
                    ? new Response(null, { status: 204 })
                    : Response.json({ sequence: 1 });
            }),
        );
        await me.sync.flushPendingEvents(SID);
        await me.sync.flushPendingEvents(SID);
        expect(sent.filter((s) => !s.startsWith("stroke"))).toEqual(["new"]);
        expect(server).toEqual([1, 2]);
        // The old queue's drawing still goes out.
        expect(sent.filter((s) => s.startsWith("stroke"))).toHaveLength(1);
        expect(me.queue.getPendingEvents(SID)).toEqual([]);
    },
    15_000,
);

// Another account's load makes the snapshot its own, so after a reload the
// queue must already be the snapshot's first owner's.
test("another account's queue stays that account's after this one loads the session and reloads", async () => {
    const b = await page("B");
    b.queue.setCachedSession({
        sessionId: SID,
        userId: "A",
        strokes: [],
        questions: [question(1)] as never,
        lastSyncedAt: 0,
        lastSequence: 0,
    });
    store.set(LEGACY, JSON.stringify([list("old", [1])]));
    expect(b.queue.getPendingEvents(SID)).toEqual([]);
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === "PUT") return Response.json({ sequence: 1 });
            if (url.endsWith("/cursor")) return Response.json({ sequence: 0 });
            if (url.endsWith("/strokes")) return Response.json({ strokes: [] });
            if (url.endsWith("/questions"))
                return Response.json({ questions: [], sequence: 0 });
            return Response.json({
                id: SID,
                name: "Same session",
                gameId: "g",
                gameRevisionId: "r",
                role: "member",
            });
        }),
    );
    await b.state.loadSessionContent(SID, "B");
    expect(b.queue.getCachedSession(SID)?.userId).toBe("B");

    const reloaded = await page("B");
    expect(reloaded.queue.getPendingEvents(SID)).toEqual([]);
    await reloaded.sync.flushPendingEvents(SID);
    expect(
        vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toEqual([]);

    // A's edits are A's when A opens the app.
    const a = await page("A");
    expect(a.queue.getPendingEvents(SID).map((e) => e.localId)).toEqual(["old"]);
}, 15_000);
