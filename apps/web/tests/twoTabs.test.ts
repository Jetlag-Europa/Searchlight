// Two tabs (or windows) of one account on one session. They share
// localStorage (the queue and the kept copy), fetch and the event streams,
// as tabs of one browser profile do; each has its own module graph. The fake
// server checks baseSequence like the API. Each scenario must end with both
// tabs' questions on the server, or with the tab that can't save showing
// that another tab edits the session (see tabLock) and nothing of its edit
// queued. From the 2026-11-03 release audit (SYNC-01, SYNC-03).
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Each tab imports its modules again, under a document with no DOM.
vi.mock("react-toastify", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));

const SID = "s1";
const store = new Map<string, string>();
const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, String(v));
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
    clear: () => store.clear(),
    get length() {
        return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
};

// Web Locks as the tabs of one browser share them: a request that steals
// takes the lock from its holder, whose request then rejects.
class FakeLocks {
    held = new Map<string, (err: unknown) => void>();
    request(
        name: string,
        options: { steal?: boolean },
        callback: () => Promise<unknown> | undefined,
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const holder = this.held.get(name);
            if (holder && !options.steal) throw new Error("only steal is faked");
            holder?.(new DOMException("The lock was stolen", "AbortError"));
            this.held.set(name, reject);
            void Promise.resolve(callback()).then((value) => {
                if (this.held.get(name) === reject) this.held.delete(name);
                resolve(value);
            });
        });
    }
}

let creatingTab = "?";
class MockEventSource {
    static CLOSED = 2;
    static all: MockEventSource[] = [];
    tab = creatingTab;
    onopen: any;
    onmessage: any;
    onerror: any;
    readyState = 1;
    paused = false;
    held: string[] = [];
    constructor(public url: string) {
        MockEventSource.all.push(this);
    }
    close() {
        this.readyState = 2;
    }
    push(data: string) {
        if (this.readyState === 2) return;
        if (this.paused) {
            this.held.push(data);
            return;
        }
        this.onmessage?.({ data });
    }
}
const tick = async () => {
    for (let n = 0; n < 100; n++) await Promise.resolve();
};
const q = (key: number) => ({ id: "radius", key, data: { radius: key, lat: 0, lng: 0 } });
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });

type Mode = "sse-first" | "ack-first";
const server = {
    seq: 0,
    questions: [] as any[],
    events: [] as any[],
    online: true,
    mode: "sse-first" as Mode,
    outbox: [] as Array<[MockEventSource, string]>,
    puts: [] as any[],
};
function broadcast(ev: any) {
    server.events.push(ev);
    const data = JSON.stringify(ev);
    // Streams in connection order, like the API's set of connections.
    for (const es of MockEventSource.all)
        if (es.readyState !== 2) server.outbox.push([es, data]);
}
function deliver() {
    for (const [es, data] of server.outbox.splice(0)) es.push(data);
}

async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
    if (!server.online) throw new TypeError("Failed to fetch");
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const p = u.pathname;
    if (p === `/sessions/${SID}/questions` && method === "PUT") {
        const body = JSON.parse(init!.body as string);
        server.puts.push({
            baseSequence: body.baseSequence,
            keys: body.questions.map((x: any) => x.payloadJson.key),
        });
        const dup = server.events.find(
            (e) => e.clientUuid === `questions-replace-${body.replacementId}`,
        );
        if (dup) return json({ sequence: dup.sequence, duplicate: true });
        if (
            body.baseSequence > server.seq ||
            server.events.some(
                (e) => e.type === "questions.replace" && e.sequence > body.baseSequence,
            )
        ) {
            return json(
                { error: "Conflict", message: "changed", code: "QUESTIONS_CHANGED" },
                409,
            );
        }
        server.questions = body.questions;
        server.seq++;
        broadcast({
            id: `e${server.seq}`,
            sessionId: SID,
            userId: "me",
            sequence: server.seq,
            type: "questions.replace",
            payloadJson: { replacementId: body.replacementId, questions: body.questions },
            clientUuid: `questions-replace-${body.replacementId}`,
            clientCreatedAt: new Date().toISOString(),
            serverReceivedAt: new Date().toISOString(),
        });
        if (server.mode === "sse-first") deliver();
        return json({ sequence: server.seq });
    }
    if (p === `/sessions/${SID}/questions`)
        return json({ questions: server.questions, sequence: server.seq });
    if (p === `/sessions/${SID}/strokes`) return json({ strokes: [] });
    if (p === `/sessions/${SID}/events`) {
        const after = Number(u.searchParams.get("after") ?? 0);
        return json({
            events: server.events.filter((e) => e.sequence > after),
            nextAfter: null,
        });
    }
    if (p === `/sessions/${SID}/events/cursor`) return json({ sequence: server.seq });
    if (p === `/sessions/${SID}`)
        return json({
            id: SID,
            gameId: "g",
            gameRevisionId: "r",
            name: "Session",
            role: "member",
            hiderLat: null,
            hiderLng: null,
            planningModeEnabled: false,
        });
    return json({ error: `not handled ${method} ${p}` }, 500);
}

const tabs: any[] = [];
// A tab opening the session, as SessionManager loads it: it takes the
// session over, sends what's queued, shows the server's state with the
// edits still queued on top (offline: the kept copy), then streams.
async function openTab(name: string) {
    vi.resetModules();
    const active = await import("@/lib/activeSession");
    const queue = await import("@/lib/eventQueue");
    const state = await import("@/lib/sessionState");
    const sync = await import("@/lib/syncManager");
    const sse = await import("@/lib/sseManager");
    const ctx = await import("@/lib/context");
    const tabLock = await import("@/lib/tabLock");
    active.verifiedUserId.set("me");
    active.activeSessionId.set(SID);
    const t: any = {
        name,
        active,
        queue,
        state,
        sync,
        sse,
        ctx,
        takenOver: false,
        board: () => (ctx.questions.get() as any[]).map((x) => x.key),
        // Shows that another tab edits the session, and saves nothing.
        readOnly: () => active.editingInOtherTab.get() && active.isSessionReadOnly(SID),
    };
    tabLock.editSessionHere(SID, () => {
        t.takenOver = true;
    });
    sync.startSyncManager();
    await sync.flushPendingEvents(SID).catch(() => {});
    let board: any[];
    try {
        const loaded = await state.loadSessionContent(SID, "me");
        board = queue.applyUnsyncedEvents(SID, loaded).questions;
    } catch {
        board = queue.applyUnsyncedEvents(SID, queue.getCachedSession(SID)!).questions;
        queue.boardPaintedFromSnapshot(SID);
    }
    ctx.questions.set(board);
    creatingTab = name;
    sse.startSSE(SID);
    t.es = MockEventSource.all[MockEventSource.all.length - 1];
    t.es.onopen();
    await tick();
    tabs.push(t);
    return t;
}
// The player changes the questions on this tab's board.
async function edit(t: any, list: any[]) {
    t.ctx.questions.set(list);
    await t.state.saveQuestionsToServer(SID, list).catch(() => {});
    await tick();
}
const serverKeys = () => server.questions.map((x: any) => x.payloadJson.key);
const queuedKeys = (t: any) =>
    t.queue
        .getPendingEvents(SID)
        .map((e: any) => e.payloadJson.questions.map((x: any) => x.payloadJson.key));

// Both edits on the server, or the tab that made one shows it can't save
// and queued none of it.
function expectNothingLost(a: any, b: any) {
    const keys = serverKeys();
    if (keys.includes(1) && keys.includes(2)) return;
    const lost = keys.includes(1) ? b : a;
    expect(lost.readOnly(), `${lost.name} saved nothing but isn't read-only`).toBe(true);
    expect(lost.takenOver).toBe(true);
    const mine = lost.name === "A" ? 1 : 2;
    expect(queuedKeys(lost).flat()).not.toContain(mine);
}

beforeEach(() => {
    store.clear();
    Object.assign(server, {
        seq: 0,
        questions: [],
        events: [],
        online: true,
        mode: "sse-first",
        outbox: [],
        puts: [],
    });
    MockEventSource.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", { ...storage, getItem: () => null, setItem() {} });
    vi.stubGlobal(
        "window",
        Object.assign(new EventTarget(), { location: { href: "http://localhost/" } }),
    );
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("navigator", { onLine: true, locks: new FakeLocks() });
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    for (const m of ["info", "warn", "error", "log", "debug"] as const)
        vi.spyOn(console, m).mockImplementation(() => {});
    store.set(
        `taibled-cache-${SID}`,
        JSON.stringify({
            sessionId: SID,
            userId: "me",
            strokes: [],
            questions: [],
            serverQuestions: { sequence: 0, questions: [] },
            lastSyncedAt: 0,
            lastSequence: 0,
        }),
    );
});
afterEach(() => {
    for (const t of tabs.splice(0)) {
        t.sse.stopSSE();
        t.sync.stopSyncManager();
        t.state.cancelPendingQuestionSave();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// The audit's scenarios, unchanged: both tabs open, then A adds Q1 and B adds
// Q2 on what its board shows.
for (const mode of ["sse-first", "ack-first"] as Mode[]) {
    for (const firstOpened of ["A", "B"]) {
        test(`online, ${mode}, ${firstOpened} opened first: A adds Q1, then B adds Q2`, async () => {
            server.mode = mode;
            const first = await openTab(firstOpened);
            const second = await openTab(firstOpened === "A" ? "B" : "A");
            const a = first.name === "A" ? first : second;
            const b = first.name === "B" ? first : second;
            await edit(a, [...a.ctx.questions.get(), q(1)]);
            if (mode === "ack-first") {
                deliver();
                await tick();
            }
            await edit(b, [...b.ctx.questions.get(), q(2)]);
            if (mode === "ack-first") {
                deliver();
                await tick();
            }
            await vi.advanceTimersByTimeAsync(60_000);
            deliver();
            await tick();
            expectNothingLost(a, b);
            // Only the tab opened last edits.
            expect(first.readOnly()).toBe(true);
            expect(second.readOnly()).toBe(false);
        });
    }
}

test("offline, both tabs open: A adds Q1, B adds Q2, then they reconnect", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    server.online = false;
    await edit(a, [...a.ctx.questions.get(), q(1)]);
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    server.online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expectNothingLost(a, b);
});

test("B's stream paused (backgrounded): A adds Q1, B edits before its stream delivers", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    b.es.paused = true;
    await edit(a, [...a.ctx.questions.get(), q(1)]);
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    b.es.paused = false;
    for (const d of b.es.held.splice(0)) b.es.push(d);
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expectNothingLost(a, b);
});

test("B's stream dropped (backgrounded): A adds Q1, B reconnects, replays, then edits", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    b.es.readyState = 2;
    await edit(a, [...a.ctx.questions.get(), q(1)]);
    creatingTab = "B";
    b.es.onerror?.({});
    await vi.advanceTimersByTimeAsync(31_000);
    await tick();
    const reopened = MockEventSource.all.filter((es) => es.tab === "B").at(-1)!;
    reopened.onopen?.();
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expectNothingLost(a, b);
});

// What players do: edit in one tab, then open the session in another.

test("A adds Q1, then B opens the session and adds Q2", async () => {
    const a = await openTab("A");
    await edit(a, [...a.ctx.questions.get(), q(1)]);
    const b = await openTab("B");
    expect(b.board()).toEqual([1]);
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expect(serverKeys()).toEqual([1, 2]);
    expect(a.readOnly()).toBe(true);
});

test("A's edit still in its debounce when B opens is queued, and B's board has it", async () => {
    const a = await openTab("A");
    a.ctx.questions.set([q(1)]);
    a.state.saveQuestionsDebounced(SID, [q(1)]);
    const b = await openTab("B");
    await vi.advanceTimersByTimeAsync(1000);
    deliver();
    await tick();
    // A sent it on being taken over; B shows it once it lands.
    expect(serverKeys()).toEqual([1]);
    expect(b.board()).toEqual([1]);
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expect(serverKeys()).toEqual([1, 2]);
});

test("offline: A queues Q1, then B opens the session from the kept copy and adds Q2", async () => {
    const a = await openTab("A");
    server.online = false;
    await edit(a, [...a.ctx.questions.get(), q(1)]);
    const b = await openTab("B");
    expect(b.board()).toEqual([1]);
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    expect(queuedKeys(b)).toEqual([[1, 2]]);
    server.online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expect(serverKeys()).toEqual([1, 2]);
});

test("Use here: a read-only tab opened again takes the session back", async () => {
    const a = await openTab("A");
    const b = await openTab("B");
    await edit(b, [...b.ctx.questions.get(), q(2)]);
    expect(a.readOnly()).toBe(true);
    // Use here reloads the page: a new module graph for A.
    a.sse.stopSSE();
    const again = await openTab("A");
    expect(again.board()).toEqual([2]);
    expect(b.readOnly()).toBe(true);
    await edit(again, [...again.ctx.questions.get(), q(1)]);
    await edit(b, [...b.ctx.questions.get(), q(3)]);
    await vi.advanceTimersByTimeAsync(60_000);
    deliver();
    await tick();
    expect(serverKeys()).toEqual([2, 1]);
    expect(queuedKeys(b)).toEqual([]);
});

test("without Web Locks (Safari before 15.4) both tabs stay editable, as before", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    const a = await openTab("A");
    const b = await openTab("B");
    expect(a.readOnly()).toBe(false);
    expect(b.readOnly()).toBe(false);
});
