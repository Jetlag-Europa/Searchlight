// Two players editing one session's questions, each on their own device,
// against a fake server that behaves as the API does, with every request,
// answer, lost answer, stream message and debounce timer interleaved at
// random (fixed seeds). Each device is its own module graph (vi.resetModules
// + dynamic import); globals (localStorage, fetch, window, document,
// EventSource, setTimeout) are routed to the calling device through
// AsyncLocalStorage, which follows awaits and the app's own timers.
//
// "owned": each player edits and deletes only their own questions (anyone
// folds or locks any), as in ordinary play: nothing may be lost, come back
// or be asked about. "shared": both edit and delete everything and decide
// what they're asked; every conflict asked must be real, and decisions
// stand. The invariants are checked in checkStep and finalChecks. With
// restores on, players also put deleted questions back from the History, as
// its Restore does; with undo on, they undo their latest delete within the
// toast's seconds, as its Undo does.
import { AsyncLocalStorage } from "node:async_hooks";

import {
    diffQuestionLists,
    type QuestionHistoryEntry,
} from "@searchlight/shared";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { routeNotFoundBody, SESSION_NOT_FOUND_BODY } from "./apiResponses";

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

// ───────────────────────── per-client globals ─────────────────────────
type Any = any;
interface Req {
    id: number;
    url: string;
    method: string;
    body?: string;
    state: "sent" | "processed";
    result?: { status: number; body: unknown };
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
}
interface Timer {
    id: number;
    deadline: number;
    order: number;
    cb: () => void;
}
interface Client {
    idx: number;
    userId: string;
    store: Map<string, string>;
    win: EventTarget;
    doc: EventTarget & { visibilityState: string };
    g: Any;
    reqs: Req[];
    es: MockES | null;
    streamOpen: boolean;
    streamQueue: string[];
    timers: Timer[];
    now: number;
    // The latest delete, which only can be undone, and when (device clock).
    lastDelete: { pending: Any; at: number; step: number } | null;
}
const als = new AsyncLocalStorage<Client>();
const fallbackStore = new Map<string, string>();
const fallbackWin = new EventTarget();
const fallbackDoc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
});
const cur = () => als.getStore();
const storeOf = () => cur()?.store ?? fallbackStore;

vi.stubGlobal("localStorage", {
    getItem: (k: string) => storeOf().get(k) ?? null,
    setItem: (k: string, v: string) => void storeOf().set(k, String(v)),
    removeItem: (k: string) => void storeOf().delete(k),
    get length() {
        return storeOf().size;
    },
    key: (i: number) => [...storeOf().keys()][i] ?? null,
    clear: () => storeOf().clear(),
});
function routed(pick: () => object) {
    return new Proxy(
        {},
        {
            get(_t, prop) {
                const target = pick() as Any;
                const v = target[prop];
                return typeof v === "function" ? v.bind(target) : v;
            },
            set(_t, prop, value) {
                (pick() as Any)[prop] = value;
                return true;
            },
            has(_t, prop) {
                return prop in pick();
            },
        },
    );
}
vi.stubGlobal(
    "window",
    routed(() => cur()?.win ?? fallbackWin),
);
vi.stubGlobal(
    "document",
    routed(() => cur()?.doc ?? fallbackDoc),
);

class MockES {
    static CLOSED = 2;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 0;
    client: Client;
    constructor(public url: string) {
        const c = cur();
        if (!c) throw new Error("EventSource outside a client");
        this.client = c;
        c.es = this;
        c.streamOpen = false;
        c.streamQueue = [];
    }
    close() {
        this.readyState = 2;
        if (this.client.es === this) {
            this.client.streamOpen = false;
            this.client.streamQueue = [];
        }
    }
}
vi.stubGlobal("EventSource", MockES);
// Deletes go through deleteQuestionsWithUndo; its toast isn't drawn here.
vi.mock("react-toastify", () => ({
    toast: Object.assign(() => "toast", { dismiss: () => {} }),
}));
// A request waits here as long as the run makes it, while timers jump far
// ahead: its timeout (REQUEST_TIMEOUT_MS in syncManager) would cut off most
// requests. Timeouts are tested on their own (syncRetry, sseManager).
vi.mock("@/lib/loadDeadline", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/loadDeadline")>()),
    startLoadDeadline: () => ({
        signal: new AbortController().signal,
        race: <T,>(work: Promise<T>) => work,
        clear: () => {},
    }),
}));

let timerIds = 1000;
let timerOrder = 0;
const timerOwner = new Map<number, Client>();
vi.stubGlobal("setTimeout", ((
    cb: () => void,
    delay = 0,
    ...args: unknown[]
) => {
    const c = cur();
    // Only the app's own timers are the client's: the test runner's (module
    // loading, RPC) run for real. Which is which is told by who called: a
    // timer set from a file under apps/web/src/ is the app's. The routing
    // through AsyncLocalStorage alone can't tell, since vitest's own work
    // can run inside a client's context. (A moved source tree would make
    // every timer real again, and the runs would then stall: see quiesce.)
    if (!c || !/apps\/web\/src\//.test(new Error().stack ?? ""))
        return realSetTimeout(cb as Any, delay, ...args);
    const id = ++timerIds;
    c.timers.push({
        id,
        deadline: c.now + (Number(delay) || 0),
        order: ++timerOrder,
        cb: () => cb(...(args as [])),
    });
    timerOwner.set(id, c);
    return id;
}) as Any);
vi.stubGlobal("clearTimeout", ((id: unknown) => {
    if (typeof id === "number" && timerOwner.has(id)) {
        const c = timerOwner.get(id)!;
        c.timers = c.timers.filter((t) => t.id !== id);
        timerOwner.delete(id);
        return;
    }
    return realClearTimeout(id as Any);
}) as Any);

let reqIds = 0;
const fakeResponse = (status: number, body: unknown) => {
    const res = {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (body === undefined) throw new SyntaxError("no body");
            return JSON.parse(JSON.stringify(body));
        },
        clone: () => res,
    };
    return res;
};
vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    const c = cur();
    if (!c) return Promise.reject(new Error("fetch outside a client: " + url));
    return new Promise((resolve, reject) => {
        const req: Req = {
            id: ++reqIds,
            url: String(url),
            method: init?.method ?? "GET",
            body: typeof init?.body === "string" ? init.body : undefined,
            state: "sent",
            resolve,
            reject,
        };
        c.reqs.push(req);
        if (req.method === "PUT") run.puts++;
    });
});

// ───────────────────────── fake server ─────────────────────────
interface Server {
    sid: string;
    seq: number;
    list: Array<{ clientUuid: string; ordinal: number; payloadJson: Any }>;
    committed: Map<string, number>;
    events: Any[];
}
let server: Server;
let clients: Client[] = [];

function serve(c: Client, req: Req): { status: number; body: unknown } {
    const u = new URL(req.url);
    const parts = u.pathname.split("/").filter(Boolean); // sessions, sid, ...
    if (parts[0] !== "sessions" || parts[1] !== server.sid)
        return { status: 404, body: SESSION_NOT_FOUND_BODY };
    const rest = parts.slice(2).join("/");
    if (req.method === "GET" && rest === "questions") {
        return {
            status: 200,
            body: { questions: server.list, sequence: server.seq },
        };
    }
    if (req.method === "GET" && rest === "questions/changes") {
        // As the API answers.
        const after = Number(u.searchParams.get("after"));
        const until = u.searchParams.has("until")
            ? Number(u.searchParams.get("until"))
            : Infinity;
        const keys = (u.searchParams.get("keys") ?? "").split(",").map(Number);
        const rows = server.events.filter(
            (e) =>
                e.type === "questions.replace" &&
                e.sequence > after &&
                e.sequence <= until,
        );
        const page = rows.slice(0, 500);
        return {
            status: 200,
            body: {
                changes: page.map((e) => ({
                    sequence: e.sequence,
                    userId: e.userId,
                    displayName: e.userId,
                    questions: e.payloadJson.questions
                        .map((x: Any) => x.payloadJson)
                        .filter((q: Any) => keys.includes(q.key)),
                })),
                ...(rows.length > 500 ? { truncated: true } : {}),
            },
        };
    }
    if (req.method === "GET" && rest === "events/cursor") {
        return { status: 200, body: { sequence: server.seq } };
    }
    if (req.method === "GET" && rest === "events") {
        const after = Number(u.searchParams.get("after") ?? 0);
        const limit = Number(u.searchParams.get("limit") ?? 50);
        const rows = server.events.filter((e) => e.sequence > after);
        const page = rows.slice(0, limit);
        const nextAfter = rows.length > limit ? page.at(-1).sequence : null;
        return { status: 200, body: { events: page, nextAfter } };
    }
    if (req.method === "PUT" && rest === "questions") {
        const body = JSON.parse(req.body!);
        const { replacementId, questions: incoming, baseSequence } = body;
        if (server.committed.has(replacementId)) {
            return {
                status: 200,
                body: {
                    sequence: server.committed.get(replacementId),
                    duplicate: true,
                },
            };
        }
        if (baseSequence !== undefined) {
            // Only question replaces in this session: any later event is one.
            if (
                baseSequence > server.seq ||
                server.events.some(
                    (e) =>
                        e.sequence > baseSequence &&
                        e.type === "questions.replace",
                )
            ) {
                return { status: 409, body: { code: "QUESTIONS_CHANGED" } };
            }
        }
        server.seq += 1;
        server.list = JSON.parse(JSON.stringify(incoming));
        server.committed.set(replacementId, server.seq);
        const record = {
            id: `ev-${server.seq}`,
            sessionId: server.sid,
            userId: c.userId,
            sequence: server.seq,
            type: "questions.replace",
            payloadJson: {
                replacementId,
                questions: JSON.parse(JSON.stringify(incoming)),
            },
            clientUuid: `questions-replace-${replacementId}`,
            clientCreatedAt: "2026-01-01T00:00:00.000Z",
            serverReceivedAt: "2026-01-01T00:00:00.000Z",
        };
        server.events.push(record);
        run.commitStep.set(server.seq, run.step);
        run.log.push(
            `    server: seq ${server.seq} ← ${c.userId} [${labelsOf(server.list.map((x) => x.payloadJson))}]`,
        );
        for (const other of clients) {
            if (other.streamOpen)
                other.streamQueue.push(JSON.stringify(record));
        }
        if (baseSequence === undefined) return { status: 204, body: undefined };
        return { status: 200, body: { sequence: server.seq } };
    }
    return {
        status: 404,
        body: routeNotFoundBody(req.method, `${u.pathname}${u.search}`),
    };
}

// ───────────────────────── helpers ─────────────────────────
const flush = () => new Promise<void>((r) => realSetImmediate(r));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const keyOf = (q: Any) => q?.key as number;
const labelOf = (q: Any) => (q ? (q.data?.label as string) : null);
const labelsOf = (list: Any[]) =>
    list
        .map((q) => `${q.key}:${q.data.label}${q.data.drag ? "*" : ""}`)
        .join(" ");
const mkQ = (key: number, label: string) => ({
    id: "radius",
    key,
    data: { label },
});

function owner(key: number): number {
    if (key < 1000) return (key - 1) % 2;
    return Math.floor(key / 1000) - 1;
}

function mulberry32(a: number) {
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function loadGraph() {
    vi.resetModules();
    const g: Any = {};
    const names: Record<string, string> = {
        activeSession: "@/lib/activeSession",
        context: "@/lib/context",
        eventQueue: "@/lib/eventQueue",
        suppress: "@/lib/questionSaveSuppress",
        sessionState: "@/lib/sessionState",
        sse: "@/lib/sseManager",
        sync: "@/lib/syncManager",
        merge: "@/lib/questionMerge",
        store: "@/game-definition/store",
        history: "@/lib/questionHistory",
        questionUndo: "@/lib/questionUndo",
        undo: "@/lib/deleteQuestionsWithUndo",
        lines: "@/lib/historyLines",
    };
    for (const [name, path] of Object.entries(names))
        g[name] = await import(/* @vite-ignore */ path);
    try {
        const path = "@/lib/questionConflicts";
        g.conflicts = await import(/* @vite-ignore */ path);
    } catch {
        // The `pwa` branch: no conflicts module.
        g.conflicts = null;
    }
    return g;
}
const VARIANT = () => (clients[0]?.g.conflicts ? "branch" : "pwa");

// ───────────────────────── a run ─────────────────────────
type Mode = "owned" | "shared";
type Action =
    | {
          t: "user";
          c: number;
          kind:
              | "add"
              | "edit"
              | "drag"
              | "collapse"
              | "delete"
              | "resolve"
              | "restore"
              | "undo";
          pick: number;
          choice?: "mine" | "theirs";
      }
    | { t: "timer"; c: number }
    | { t: "arrive"; c: number; pick: number }
    | { t: "respond"; c: number; pick: number; lose: boolean }
    | { t: "fail"; c: number; pick: number }
    | { t: "sse"; c: number }
    | { t: "drop"; c: number }
    | { t: "open"; c: number }
    // Real time passing, in a trace only: lists and deletes are told apart
    // by when they were made (Date.now), which within a millisecond can't.
    | { t: "pause"; c: number; ms: number };

interface HistoryEntry {
    step: number;
    c: number;
    key: number;
    kind: "add" | "edit" | "delete" | "resolve" | "restore" | "undo";
    label: string | null;
    // An undo under the deleted key.
    sameKey?: true;
}

const run = {
    puts: 0,
    log: [] as string[],
    history: [] as HistoryEntry[],
    labelAuthor: new Map<string, number>(),
    // Who restored each question and the label it came back with, by its
    // new key: the label was written before, maybe by the other player.
    restoredBy: new Map<number, { c: number; label: string | null }>(),
    // The step at which each server sequence was saved.
    commitStep: new Map<number, number>(),
    // Undos put back under the deleted key: the delete never left the device.
    sameKeyUndos: [] as Array<{
        c: number;
        key: number;
        from: number;
        to: number;
    }>,
    // Conflicts as recorded: who, when, which.
    conflictLog: [] as Array<{
        step: number;
        c: number;
        key: number;
        kind: string;
    }>,
    addCount: [0, 0],
    labelCount: 0,
    step: 0,
    conflictsSeen: new Map<string, Any>(),
    conflictKeys: new Set<number>(),
    violations: [] as string[],
    losses: 0,
    publishes: 0,
    resolutions: [] as Array<{
        step: number;
        c: number;
        key: number;
        chosen: Any;
        choice: string;
        theirs?: Any;
    }>,
};
let sidCounter = 0;
const INITIAL = [1, 2, 3, 4];
// How long a delete's Undo is offered (its toast), on the device clock.
const UNDO_WINDOW_MS = 8000;

// Runs fn as the client; never waits on a promise it returns (a timer's
// async callback may wait on the network, which the driver controls).
async function inClient(c: Client, fn: () => unknown): Promise<void> {
    als.run(c, () => {
        const out = fn() as Any;
        if (out && typeof out.then === "function")
            out.then(undefined, () => {});
    });
    await flush();
}

async function setup() {
    const sid = `sim-${++sidCounter}`;
    const init = INITIAL.map((k) => mkQ(k, `init-${k}`));
    server = {
        sid,
        seq: 3,
        list: init.map((payloadJson, ordinal) => ({
            clientUuid: `s-${ordinal}`,
            ordinal,
            payloadJson: clone(payloadJson),
        })),
        committed: new Map(),
        events: [],
    };
    Object.assign(run, {
        puts: 0,
        log: [],
        history: [],
        labelAuthor: new Map(),
        restoredBy: new Map(),
        commitStep: new Map(),
        sameKeyUndos: [],
        conflictLog: [],
        addCount: [0, 0],
        labelCount: 0,
        step: 0,
        conflictsSeen: new Map(),
        conflictKeys: new Set(),
        violations: [],
        losses: 0,
        publishes: 0,
        resolutions: [],
    });
    for (const k of INITIAL) run.labelAuthor.set(`init-${k}`, -1);
    for (const c of clients) {
        // Tear the last run down.
        await inClient(c, () => {
            c.g.sse.stopSSE();
            c.g.sessionState.cancelPendingQuestionSave();
            c.g.activeSession.activeSessionId.set("");
        });
        for (const t of c.timers) timerOwner.delete(t.id);
        c.timers = [];
        c.lastDelete = null;
        c.reqs = [];
        c.es = null;
        c.streamOpen = false;
        c.streamQueue = [];
        c.store.clear();
        await inClient(c, () => {
            const {
                activeSession,
                context,
                eventQueue,
                conflicts,
                suppress,
                sse,
            } = c.g;
            activeSession.verifiedUserId.set(c.userId);
            activeSession.offlineUserId.set(null);
            activeSession.activeSessionId.set(sid);
            conflicts?.setQuestionDecisionsPossible(true);
            eventQueue.setCachedSession({
                sessionId: sid,
                userId: c.userId,
                strokes: [],
                questions: clone(init),
                serverQuestions: { sequence: 3, questions: clone(init) },
                lastSyncedAt: 1,
                lastSequence: 3,
            });
            context.questions.set(suppress.suppressQuestionSave(clone(init)));
            sse.startSSE(sid);
        });
    }
    return sid;
}

function conflictsStored(c: Client): Any[] {
    const raw = c.store.get(`taibled-conflicts-${server.sid}~${c.userId}`);
    return raw ? JSON.parse(raw) : [];
}
function unsynced(c: Client): Any[] {
    const raw = c.store.get(`taibled-pending-${server.sid}~${c.userId}`);
    return raw ? (JSON.parse(raw) as Any[]) : [];
}

function newLabel(c: number) {
    const label = `c${c}.${++run.labelCount}`;
    run.labelAuthor.set(label, c);
    return label;
}

function candidates(c: Client, mode: Mode, needOwn: boolean): Any[] {
    const board = c.g.context.questions.get() as Any[];
    return board.filter(
        (q) =>
            typeof q?.key === "number" &&
            (!needOwn || mode === "shared" || owner(q.key) === c.idx),
    );
}

// The server's history as the History route gives it (see
// question-history.ts in the API), newest first.
function historyEntries(): QuestionHistoryEntry[] {
    let prev: unknown[] = INITIAL.map((k) => mkQ(k, `init-${k}`));
    const entries: QuestionHistoryEntry[] = [];
    for (const e of server.events) {
        if (e.type !== "questions.replace") continue;
        const list = e.payloadJson.questions.map((x: Any) => x.payloadJson);
        const diff = diffQuestionLists(prev, list);
        prev = list;
        if (diff.changes.length === 0 && !diff.reordered) continue;
        entries.push({
            sequence: e.sequence,
            userId: e.userId,
            displayName: e.userId,
            at: e.serverReceivedAt,
            changes: diff.changes,
            ...(diff.reordered ? { reordered: true as const } : {}),
            ...(diff.prevOrder ? { order: diff.prevOrder } : {}),
        });
    }
    return entries.reverse();
}

interface RestoreCandidate {
    key: number;
    version: Any;
    order: number[];
    index: number;
    lines: Any[];
}

// What the device's History offers to restore, read from its lines as the
// UI does: deleted questions not back on its board, under their key, as what
// they were restored as, or as a teammate's restore the lines don't know yet
// (alreadyBackAs, as restorable() checks), not held for a decision
// (restoreBlocked), and in owned mode its own.
function restoreCandidates(c: Client, mode: Mode): RestoreCandidate[] {
    const board = c.g.context.questions.get() as Any[];
    const lines = c.g.lines.historyLines(historyEntries(), {}) as Any[];
    const out: RestoreCandidate[] = [];
    for (const line of lines) {
        for (const removed of line.removed ?? []) {
            if (
                c.g.questionUndo.alreadyBackAs(removed, board, lines) !==
                    undefined ||
                (mode === "owned" && owner(removed.key) !== c.idx) ||
                c.g.history.restoreBlocked(removed, { lines }) !== null
            )
                continue;
            out.push({
                key: removed.key,
                version: removed.question,
                order: line.order ?? [],
                index: removed.index,
                lines,
            });
        }
    }
    return out.sort((x, y) => x.key - y.key);
}

// Whether that side wrote a question's label: it's its own, or it restored
// the question (by its new key) with that label.
const wrote = (key: number, label: string | null, c: number) => {
    if (label === null) return false;
    if (run.labelAuthor.get(label) === c) return true;
    const restored = run.restoredBy.get(key);
    return restored?.c === c && restored.label === label;
};

async function applyUser(
    a: Extract<Action, { t: "user" }>,
    mode: Mode,
): Promise<string | null> {
    const c = clients[a.c];
    const { context, conflicts } = c.g;
    const sid = server.sid;
    if (a.kind === "add") {
        const key = 1000 * (a.c + 1) + ++run.addCount[a.c];
        const label = newLabel(a.c);
        await inClient(c, () => {
            const board = context.questions.get();
            board.push(mkQ(key, label));
            context.questions.set([...board]);
        });
        run.history.push({ step: run.step, c: a.c, key, kind: "add", label });
        run.publishes++;
        return `add ${key}:${label}`;
    }
    if (a.kind === "resolve") {
        if (!conflicts) return null;
        const held = [...(conflicts.questionConflicts.get() as Any[])].sort(
            (x, y) => x.key - y.key,
        );
        if (held.length === 0) return null;
        const conflict = held[Math.floor(a.pick * held.length)];
        const choice = a.choice ?? "mine";
        const chosen = conflict[choice];
        await inClient(c, () =>
            conflicts.resolveQuestionConflict(sid, conflict.key, choice),
        );
        run.history.push({
            step: run.step,
            c: a.c,
            key: conflict.key,
            kind: "resolve",
            label: labelOf(chosen),
        });
        run.resolutions.push({
            step: run.step,
            c: a.c,
            key: conflict.key,
            chosen,
            choice,
            theirs: conflict.theirs,
        });
        run.publishes++;
        return `resolve ${conflict.key} → ${choice} (${labelOf(chosen)})`;
    }
    if (a.kind === "undo") {
        const last = c.lastDelete;
        if (!last || c.now - last.at > UNDO_WINDOW_MS) return null;
        c.lastDelete = null;
        let undone: Any = null;
        await inClient(c, () => {
            undone = c.g.undo.undoQuestionDeletion(
                last.pending,
                () => 1000 * (a.c + 1) + ++run.addCount[a.c],
            );
        });
        if (!undone || undone.placed.length === 0) {
            return `undo (already back: ${undone?.alreadyBack ?? 0})`;
        }
        const said: string[] = [];
        for (const { from, key } of undone.placed as Any[]) {
            const deleted = last.pending.deletion.removed.find(
                (r: Any) => r.question.key === from,
            );
            const label = labelOf(deleted?.question);
            // Checked under the key it's back under, like a restore.
            run.history.push({
                step: run.step,
                c: a.c,
                key,
                kind: "undo",
                label,
                ...(key === from ? { sameKey: true as const } : {}),
            });
            run.restoredBy.set(key, { c: a.c, label });
            // Asked about while the delete was still here (a merge met it),
            // the Undo settles that: nothing left to decide.
            if (
                key === from &&
                conflictsStored(c).some(
                    (x: Any) => x.key === key && x.kind === "we-deleted",
                )
            )
                run.violations.push(
                    `U2 c${a.c} still asked about its undone delete of ${key}`,
                );
            if (key === from)
                run.sameKeyUndos.push({
                    c: a.c,
                    key,
                    from: last.step,
                    to: run.step,
                });
            said.push(key === from ? `${key}` : `${from} as ${key}`);
        }
        run.publishes++;
        return `undo ${said.join(", ")}`;
    }
    if (a.kind === "restore") {
        const options = restoreCandidates(c, mode);
        if (options.length === 0) return null;
        const { key, version, order, index, lines } =
            options[Math.floor(a.pick * options.length)];
        const label = labelOf(version);
        // As restoreFromHistory does, from the same pieces: it can't be
        // called itself, as its restorable() re-reads the deleted question
        // with the app's schema, which these bare test questions (a label,
        // no pin) don't pass; restoreCandidates makes the same checks
        // otherwise. A copy under a new key, here from the
        // restorer's range so owner() still tells whose it is. (Undo does
        // the same once the delete may have reached the server; before, it
        // puts the same key back: see the "undo" action.)
        const fresh = 1000 * (a.c + 1) + ++run.addCount[a.c];
        await inClient(c, () => {
            const next = c.g.questionUndo.placeRestored(
                context.questions.get(),
                order,
                [
                    {
                        from: key,
                        index,
                        question: c.g.questionUndo.asRestored(version, fresh),
                    },
                ],
                lines,
            );
            if (next) context.questions.set(next);
        });
        // Checked under its new key; the old key's delete stands.
        run.history.push({
            step: run.step,
            c: a.c,
            key: fresh,
            kind: "restore",
            label,
        });
        run.restoredBy.set(fresh, { c: a.c, label });
        run.publishes++;
        return `restore ${key} as ${fresh}:${label}`;
    }
    const own = a.kind === "edit" || a.kind === "delete";
    const list = candidates(c, mode, own);
    if (list.length === 0) return null;
    const target = list[Math.floor(a.pick * list.length)];
    const key = target.key as number;
    if (a.kind === "edit") {
        const label = newLabel(a.c);
        await inClient(c, () => {
            target.data.label = label;
            context.questions.set([...context.questions.get()]);
        });
        run.history.push({ step: run.step, c: a.c, key, kind: "edit", label });
        run.publishes++;
        return `edit ${key} → ${label}`;
    }
    if (a.kind === "drag") {
        await inClient(c, () => {
            target.data.drag = !target.data.drag;
            context.questions.set([...context.questions.get()]);
        });
        run.publishes++;
        return `drag ${key} → ${target.data.drag}`;
    }
    if (a.kind === "collapse") {
        // As the cards do: in place, not published.
        await inClient(c, () => {
            target.data.collapsed = !target.data.collapsed;
        });
        return `collapse ${key} (silent)`;
    }
    // delete, as the cards do: undoable for a few seconds.
    await inClient(c, () => {
        const pending = c.g.undo.deleteQuestionsWithUndo([key]);
        c.lastDelete = pending ? { pending, at: c.now, step: run.step } : null;
    });
    run.history.push({
        step: run.step,
        c: a.c,
        key,
        kind: "delete",
        label: null,
    });
    run.publishes++;
    return `delete ${key}`;
}

async function applyAction(a: Action, mode: Mode): Promise<string | null> {
    const c = clients[a.c];
    switch (a.t) {
        case "user":
            return applyUser(a, mode);
        case "timer": {
            if (c.timers.length === 0) return null;
            c.timers.sort(
                (x, y) => x.deadline - y.deadline || x.order - y.order,
            );
            const t = c.timers.shift()!;
            timerOwner.delete(t.id);
            c.now = Math.max(c.now, t.deadline);
            await inClient(c, t.cb);
            return `timer@${t.deadline}`;
        }
        case "arrive": {
            const sent = c.reqs.filter((r) => r.state === "sent");
            if (sent.length === 0) return null;
            const req = sent[Math.floor(a.pick * sent.length)];
            req.result = serve(c, req);
            req.state = "processed";
            const what =
                req.method === "PUT"
                    ? `PUT base=${JSON.parse(req.body!).baseSequence} rid=${JSON.parse(req.body!).replacementId.slice(0, 4)} [${labelsOf(JSON.parse(req.body!).questions.map((x: Any) => x.payloadJson))}]`
                    : `${req.method} ${new URL(req.url).pathname.split("/").slice(3).join("/")}${new URL(req.url).search}`;
            return `arrive ${what} → ${req.result.status}${(req.result.body as Any)?.duplicate ? " dup" : ""}`;
        }
        case "respond": {
            const done = c.reqs.filter((r) => r.state === "processed");
            if (done.length === 0) return null;
            const req = done[Math.floor(a.pick * done.length)];
            c.reqs = c.reqs.filter((r) => r !== req);
            if (a.lose) {
                run.losses++;
                await als.run(c, async () =>
                    req.reject(new TypeError("Failed to fetch")),
                );
            } else {
                await als.run(c, async () =>
                    req.resolve(
                        fakeResponse(req.result!.status, req.result!.body),
                    ),
                );
            }
            await flush();
            return `${a.lose ? "LOSE answer" : "answer"} ${req.method} ${req.result!.status}`;
        }
        case "fail": {
            const sent = c.reqs.filter((r) => r.state === "sent");
            if (sent.length === 0) return null;
            const req = sent[Math.floor(a.pick * sent.length)];
            c.reqs = c.reqs.filter((r) => r !== req);
            run.losses++;
            await als.run(c, async () =>
                req.reject(new TypeError("Failed to fetch")),
            );
            await flush();
            return `FAIL request ${req.method} ${new URL(req.url).pathname.split("/").slice(3).join("/")}`;
        }
        case "sse": {
            if (!c.streamOpen || c.streamQueue.length === 0 || !c.es)
                return null;
            const data = c.streamQueue.shift()!;
            const es = c.es;
            await inClient(c, () => es.onmessage?.({ data }));
            return `sse seq ${JSON.parse(data).sequence}`;
        }
        case "drop": {
            if (!c.es || !c.streamOpen) return null;
            const es = c.es;
            c.streamOpen = false;
            c.streamQueue = [];
            es.readyState = 2;
            await inClient(c, () => es.onerror?.({}));
            return `stream dropped`;
        }
        case "pause":
            await new Promise((r) => realSetTimeout(r, a.ms));
            return null;
        case "open": {
            if (!c.es || c.es.readyState !== 0) return null;
            const es = c.es;
            es.readyState = 1;
            c.streamOpen = true;
            c.streamQueue = [];
            await inClient(c, () => es.onopen?.({}));
            return `stream open`;
        }
    }
}

function enabled(
    mode: Mode,
    userBudget: boolean,
    rng: () => number,
    withRestores = false,
    withUndo = false,
): Action[] {
    const out: Array<[number, Action]> = [];
    for (const c of clients) {
        const i = c.idx;
        if (userBudget) {
            out.push([1.2, { t: "user", c: i, kind: "add", pick: rng() }]);
            out.push([2.5, { t: "user", c: i, kind: "edit", pick: rng() }]);
            out.push([1.2, { t: "user", c: i, kind: "drag", pick: rng() }]);
            out.push([0.4, { t: "user", c: i, kind: "collapse", pick: rng() }]);
            out.push([0.8, { t: "user", c: i, kind: "delete", pick: rng() }]);
            if (
                mode === "shared" &&
                c.g.conflicts &&
                (c.g.conflicts.questionConflicts.get() as Any[]).length > 0
            ) {
                out.push([
                    2,
                    {
                        t: "user",
                        c: i,
                        kind: "resolve",
                        pick: rng(),
                        choice: rng() < 0.5 ? "mine" : "theirs",
                    },
                ]);
            }
            // Only with restores on: another draw would change every
            // seeded run without them.
            if (
                withUndo &&
                c.lastDelete &&
                c.now - c.lastDelete.at <= UNDO_WINDOW_MS
            )
                out.push([1.5, { t: "user", c: i, kind: "undo", pick: 0 }]);
            if (withRestores && restoreCandidates(c, mode).length > 0)
                out.push([
                    2,
                    { t: "user", c: i, kind: "restore", pick: rng() },
                ]);
        }
        if (c.timers.length > 0) out.push([3, { t: "timer", c: i }]);
        if (c.reqs.some((r) => r.state === "sent")) {
            out.push([3, { t: "arrive", c: i, pick: rng() }]);
            out.push([0.15, { t: "fail", c: i, pick: rng() }]);
        }
        if (c.reqs.some((r) => r.state === "processed")) {
            out.push([3, { t: "respond", c: i, pick: rng(), lose: false }]);
            out.push([0.4, { t: "respond", c: i, pick: rng(), lose: true }]);
        }
        if (c.streamOpen && c.streamQueue.length > 0)
            out.push([3, { t: "sse", c: i }]);
        if (c.streamOpen) out.push([0.1, { t: "drop", c: i }]);
        if (c.es && c.es.readyState === 0) out.push([2, { t: "open", c: i }]);
    }
    const total = out.reduce((s, [w]) => s + w, 0);
    let r = rng() * total;
    for (const [w, a] of out) {
        r -= w;
        if (r <= 0) return [a];
    }
    return out.length ? [out.at(-1)![1]] : [];
}

async function quiesce(mode: Mode, maxSteps = 600): Promise<boolean> {
    for (let i = 0; i < maxSteps; i++) {
        let did: string | null = null;
        for (const c of clients) {
            for (const a of [
                { t: "arrive", c: c.idx, pick: 0 },
                { t: "respond", c: c.idx, pick: 0, lose: false },
                { t: "sse", c: c.idx },
                { t: "open", c: c.idx },
            ] as Action[]) {
                did = await applyAction(a, mode);
                if (did) {
                    run.log.push(`  q c${c.idx}: ${did}`);
                    break;
                }
            }
            if (did) break;
        }
        if (!did) {
            // Timers last: the earliest of any client.
            const withTimers = clients.filter((c) => c.timers.length > 0);
            if (withTimers.length === 0) return true;
            const c = withTimers.sort(
                (x, y) =>
                    Math.min(...x.timers.map((t) => t.deadline - x.now)) -
                    Math.min(...y.timers.map((t) => t.deadline - y.now)),
            )[0];
            did = await applyAction({ t: "timer", c: c.idx }, mode);
            run.log.push(`  q c${c.idx}: ${did}`);
        }
        await checkStep(mode);
    }
    return false;
}

function substanceKey(q: Any) {
    if (!q) return "∅";
    const data = { ...q.data };
    delete data.collapsed;
    delete data.drag;
    return JSON.stringify({ id: q.id, data });
}

async function checkStep(mode: Mode) {
    for (const c of clients) {
        for (const conflict of conflictsStored(c)) {
            const id = `${c.idx}|${conflict.key}|${substanceKey(conflict.mine)}|${substanceKey(conflict.theirs)}|${conflict.theirsSequence}`;
            if (run.conflictsSeen.has(id)) continue;
            run.conflictsSeen.set(id, conflict);
            run.conflictKeys.add(conflict.key);
            run.conflictLog.push({
                step: run.step,
                c: c.idx,
                key: conflict.key,
                kind: conflict.kind,
            });
            run.log.push(
                `    !! c${c.idx} holds ${conflict.kind} ${conflict.key}: mine=${labelOf(conflict.mine)} theirs=${labelOf(conflict.theirs)} base=${labelOf(conflict.base)}`,
            );
            if (mode === "owned") {
                run.violations.push(
                    `I4 conflict recorded in owned mode: c${c.idx} ${conflict.kind} key ${conflict.key} mine=${labelOf(conflict.mine)} theirs=${labelOf(conflict.theirs)} base=${labelOf(conflict.base)}`,
                );
                continue;
            }
            // J1: a real conflict.
            const problems: string[] = [];
            if (substanceKey(conflict.mine) === substanceKey(conflict.theirs))
                problems.push("mine == theirs");
            if (substanceKey(conflict.base) === substanceKey(conflict.mine))
                problems.push("base == mine");
            if (substanceKey(conflict.base) === substanceKey(conflict.theirs))
                problems.push("base == theirs");
            // Written by that side, or put back by it with a restore.
            const mineBy = conflict.mine
                ? run.labelAuthor.get(labelOf(conflict.mine)!)
                : undefined;
            const theirsBy = conflict.theirs
                ? run.labelAuthor.get(labelOf(conflict.theirs)!)
                : undefined;
            if (
                conflict.mine &&
                !wrote(conflict.key, labelOf(conflict.mine), c.idx)
            )
                problems.push(`mine authored by ${mineBy}`);
            if (
                conflict.theirs &&
                !wrote(conflict.key, labelOf(conflict.theirs), 1 - c.idx)
            )
                problems.push(`theirs authored by ${theirsBy}`);
            if (
                !conflict.theirs &&
                !run.history.some(
                    (h) =>
                        h.c === 1 - c.idx &&
                        h.key === conflict.key &&
                        (h.kind === "delete" ||
                            (h.kind === "resolve" && h.label === null)),
                )
            )
                problems.push("theirs deleted but other never deleted it");
            if (
                !conflict.mine &&
                !run.history.some(
                    (h) =>
                        h.c === c.idx &&
                        h.key === conflict.key &&
                        (h.kind === "delete" ||
                            (h.kind === "resolve" && h.label === null)),
                )
            )
                problems.push("mine deleted but we never deleted it");
            if (problems.length)
                run.violations.push(
                    `J1 false conflict c${c.idx} ${conflict.kind} key ${conflict.key} mine=${labelOf(conflict.mine)} theirs=${labelOf(conflict.theirs)} base=${labelOf(conflict.base)}: ${problems.join(", ")}`,
                );
        }
    }
}

function finalChecks(mode: Mode, quiet: boolean, quiescePuts: number) {
    const v = run.violations;
    if (!quiet) v.push(`I5 no quiescence (loop?) after ${run.puts} PUTs`);
    const serverQs = server.list.map((x) => x.payloadJson);
    const serverByKey = new Map(serverQs.map((q: Any) => [q.key, q]));
    if (serverByKey.size !== serverQs.length)
        v.push(`I0 duplicate keys on server: ${labelsOf(serverQs)}`);
    const putBound = 4 * (run.publishes + 1) + 4 * run.losses + 8;
    if (run.puts > putBound)
        v.push(`I5 too many PUTs: ${run.puts} > ${putBound}`);
    if (quiescePuts > 4 * (run.publishes + 1) + 4 * run.losses + 8)
        v.push(`I5 PUTs during quiescence ${quiescePuts}`);
    for (const c of clients) {
        const board = c.g.context.questions.get() as Any[];
        const left = unsynced(c);
        if (left.length)
            v.push(
                `Q c${c.idx} still has ${left.length} unsynced list(s) after quiescence`,
            );
        const bs = board.map((q) => `${q.key}=${substanceKey(q)}`).sort();
        const ss = serverQs
            .map((q: Any) => `${q.key}=${substanceKey(q)}`)
            .sort();
        if (JSON.stringify(bs) !== JSON.stringify(ss)) {
            v.push(
                `I1 c${c.idx} board != server: board [${labelsOf(board)}] server [${labelsOf(serverQs)}]`,
            );
        } else if (board.map(keyOf).join() !== serverQs.map(keyOf).join()) {
            v.push(
                `I1o c${c.idx} board order != server order: board [${labelsOf(board)}] server [${labelsOf(serverQs)}]`,
            );
        }
        const cached = JSON.parse(
            c.store.get(`taibled-cache-${server.sid}`) ?? "{}",
        );
        if (cached.lastSequence !== server.seq)
            v.push(
                `I7 c${c.idx} stream not caught up: ${cached.lastSequence} vs ${server.seq}`,
            );
        if (mode === "shared" && conflictsStored(c).length)
            v.push(
                `J2 c${c.idx} conflicts left after resolution rounds: ${conflictsStored(c).length}`,
            );
    }
    // An Undo under the deleted key: the delete never left the device, so
    // no list of its saved between the delete and the Undo lacks it, and it
    // left no "we deleted it" to decide.
    for (const u of run.sameKeyUndos) {
        const userId = clients[u.c].userId;
        // Until its next delete of the key, if any.
        const until =
            run.history.find(
                (h) =>
                    h.c === u.c &&
                    h.key === u.key &&
                    h.kind === "delete" &&
                    h.step > u.to,
            )?.step ?? Infinity;
        let had = INITIAL.includes(u.key);
        let leaked = false;
        for (const e of server.events) {
            const has = e.payloadJson.questions.some(
                (x: Any) => x.payloadJson.key === u.key,
            );
            const at = run.commitStep.get(e.sequence) ?? 0;
            if (
                had &&
                !has &&
                e.userId === userId &&
                at >= u.from &&
                at < until
            )
                leaked = true;
            had = has;
        }
        if (leaked)
            v.push(
                `U1 c${u.c} undid ${u.key} under its key, but its delete reached the server`,
            );
        if (
            run.conflictLog.some(
                (x) =>
                    x.c === u.c &&
                    x.key === u.key &&
                    x.kind === "we-deleted" &&
                    x.step > u.to &&
                    x.step < until,
            )
        )
            v.push(`U2 c${u.c}'s undone delete of ${u.key} was asked about`);
    }
    // Per key, what each player did.
    const keys = new Set<number>([
        ...INITIAL,
        ...run.history.map((h) => h.key),
    ]);
    for (const key of keys) {
        const hs = run.history.filter((h) => h.key === key);
        const now = serverByKey.get(key);
        if (mode === "owned") {
            const own = hs.filter((h) => h.c === owner(key));
            // A restore brings it back; a later delete takes it away again.
            const deleted =
                [...own]
                    .reverse()
                    .find(
                        (h) =>
                            h.kind === "add" ||
                            h.kind === "delete" ||
                            h.kind === "restore" ||
                            h.kind === "undo",
                    )?.kind === "delete";
            const last = [...own]
                .reverse()
                .find(
                    (h) =>
                        h.kind === "edit" ||
                        h.kind === "add" ||
                        h.kind === "restore" ||
                        h.kind === "undo",
                );
            const expected = last?.label ?? `init-${key}`;
            if (deleted && now)
                v.push(`I3 deleted ${key} came back: ${labelOf(now)}`);
            if (!deleted && !now)
                v.push(
                    `I2 ${key} (${expected}) lost; its owner c${owner(key)} didn't delete it last`,
                );
            if (!deleted && now && labelOf(now) !== expected)
                v.push(
                    `I6 ${key} on server is ${labelOf(now)}, owner's last edit was ${expected}`,
                );
        } else {
            const removedBySomeone = hs.some(
                (h) =>
                    h.kind === "delete" ||
                    (h.kind === "resolve" && h.label === null),
            );
            if (!now && !removedBySomeone)
                v.push(`I2 ${key} lost; nobody deleted it`);
            if (!run.conflictKeys.has(key) && hs.length > 0) {
                let last = hs.at(-1)!;
                // Undone under its key, the delete never happened: the
                // question is back as it was, so the other player's edit or
                // delete of it merges in as over any question. Only one
                // the player's version doesn't already include: made after
                // the player's own last change of it before the delete (an
                // earlier Undo under its key changed nothing).
                if (last.kind === "undo" && last.sameKey) {
                    const undone = last;
                    const deletedAt =
                        run.sameKeyUndos.find(
                            (u) =>
                                u.c === undone.c &&
                                u.key === key &&
                                u.to === undone.step,
                        )?.from ?? undone.step;
                    const ownBefore =
                        hs
                            .filter(
                                (h) =>
                                    h.c === undone.c &&
                                    h.step < deletedAt &&
                                    h.kind !== "delete" &&
                                    !h.sameKey,
                            )
                            .at(-1)?.step ?? -Infinity;
                    const theirs = hs
                        .filter(
                            (h) =>
                                h.c !== undone.c &&
                                h.step > ownBefore &&
                                (h.kind === "edit" || h.kind === "delete"),
                        )
                        .at(-1);
                    if (
                        theirs &&
                        (theirs.kind === "delete"
                            ? !now
                            : labelOf(now) === theirs.label)
                    )
                        last = theirs;
                }
                if (last.kind === "delete" && now)
                    v.push(
                        `I3 ${key}: last op delete by c${last.c}, no conflict, but on server: ${labelOf(now)}`,
                    );
                if (last.kind !== "delete" && last.label !== null && !now)
                    v.push(
                        `I2 ${key}: last op ${last.kind} ${last.label} by c${last.c}, no conflict, but gone`,
                    );
                if (
                    last.kind !== "delete" &&
                    now &&
                    labelOf(now) !== last.label
                )
                    v.push(
                        `I6 ${key}: last op ${last.kind} ${last.label} by c${last.c}, no conflict, server has ${labelOf(now)}`,
                    );
            }
            // J2: the last resolution of a key stands unless edited after it.
            const res = run.resolutions.filter((r) => r.key === key).at(-1);
            if (res) {
                const after = hs.filter(
                    (h) =>
                        h.step > res.step ||
                        (h.step === res.step && h.kind !== "resolve"),
                );
                const editedAfter = run.history.some(
                    (h) => h.key === key && h.step > res.step,
                );
                // The other player's version newer than the `theirs` decided
                // on (edited before the decision, saved after) may stand.
                const counter = (label: string | null) =>
                    label ? Number(label.split(".")[1] ?? -1) : -1;
                const nowBy = now
                    ? run.labelAuthor.get(labelOf(now)!)
                    : undefined;
                const newerTheirs =
                    now &&
                    nowBy === 1 - res.c &&
                    counter(labelOf(now)) >
                        counter(labelOf((res as Any).theirs));
                const deletedSince =
                    !now &&
                    run.history.some(
                        (h) =>
                            h.key === key &&
                            h.c === 1 - res.c &&
                            h.kind === "delete",
                    );
                if (
                    !editedAfter &&
                    !newerTheirs &&
                    !deletedSince &&
                    substanceKey(now ?? null) !== substanceKey(res.chosen)
                ) {
                    v.push(
                        `J2 ${key}: c${res.c} chose ${res.choice} (${labelOf(res.chosen)}) last; server has ${labelOf(now)}`,
                    );
                }
                void after;
            }
        }
    }
}

// One seed: play `length` random actions, let everything settle, decide
// what's left to decide (shared), check.
async function runSeed(
    seed: number,
    mode: Mode,
    length: number,
    withRestores = false,
    withUndo = false,
): Promise<string[]> {
    await setup();
    const rng = mulberry32(seed);
    for (let i = 0; i < length; i++) {
        const [a] = enabled(
            mode,
            i < length * 0.85,
            rng,
            withRestores,
            withUndo,
        );
        if (!a) break;
        run.step++;
        const did = await applyAction(a, mode);
        if (did)
            run.log.push(`${String(run.step).padStart(3)} c${a.c}: ${did}`);
        await checkStep(mode);
    }
    return settleAndCheck(mode, mulberry32(seed ^ 0x9e3779b9));
}

async function settleAndCheck(
    mode: Mode,
    rng: () => number,
): Promise<string[]> {
    const putsBefore = run.puts;
    let quiet = await quiesce(mode);
    if (mode === "shared") {
        for (let round = 0; quiet && round < 8; round++) {
            let any = false;
            for (const c of clients) {
                const sorted = () =>
                    [...(c.g.conflicts.questionConflicts.get() as Any[])].sort(
                        (x: Any, y: Any) => x.key - y.key,
                    );
                for (const conflict of sorted()) {
                    const list = sorted();
                    const at = list.findIndex(
                        (x: Any) => x.key === conflict.key,
                    );
                    if (at === -1) continue;
                    run.step++;
                    const choice = rng() < 0.5 ? "mine" : "theirs";
                    const did = await applyAction(
                        {
                            t: "user",
                            c: c.idx,
                            kind: "resolve",
                            pick: (at + 0.5) / list.length,
                            choice,
                        },
                        mode,
                    );
                    if (did)
                        run.log.push(
                            `${String(run.step).padStart(3)} c${c.idx}: (final) ${did}`,
                        );
                    any = true;
                }
                quiet = (await quiesce(mode)) && quiet;
            }
            if (!any) break;
        }
    }
    finalChecks(mode, quiet, run.puts - putsBefore);
    return [...run.violations];
}

async function makeClients() {
    for (let i = 0; i < 2; i++) {
        const c: Client = {
            idx: i,
            userId: `u${i + 1}`,
            store: new Map(),
            win: new EventTarget(),
            doc: Object.assign(new EventTarget(), {
                visibilityState: "visible",
            }),
            g: null,
            reqs: [],
            es: null,
            streamOpen: false,
            streamQueue: [],
            timers: [],
            now: 0,
            lastDelete: null,
        };
        c.g = await loadGraph();
        await inClient(c, () => {
            const {
                activeSession,
                context,
                conflicts,
                suppress,
                sessionState,
                sync,
            } = c.g;
            sync.startSyncManager();
            // SessionManager's save effect. React runs it once the board has
            // redrawn: after whatever set the questions has returned, and
            // once for the board as it is by then, however often it was set.
            // A microtask comes after the handler, and before the next tap.
            let effectQueued = false;
            let drawn: Any[] | null = null;
            context.questions.listen(() => {
                if (effectQueued) return;
                effectQueued = true;
                queueMicrotask(() => {
                    effectQueued = false;
                    const list = context.questions.get() as Any[];
                    // Its dependency unchanged: React doesn't run it.
                    if (list === drawn) return;
                    drawn = list;
                    const sid = activeSession.activeSessionId.get();
                    if (!sid) return;
                    const edited = !suppress.isQuestionSaveSuppressed(list);
                    conflicts.trackBoardQuestions(sid, list, edited);
                    if (edited) sessionState.saveQuestionsDebounced(sid, list);
                });
            });
            // SessionManager's onQuestionsSaved listener.
            sync.onQuestionsSaved((saved: Any) => {
                if (
                    !saved.mergedWith ||
                    saved.sessionId !== activeSession.activeSessionId.get()
                )
                    return;
                conflicts.showMergedSave(saved, {
                    saveScheduled: sessionState.hasScheduledQuestionSave(
                        saved.sessionId,
                    ),
                });
            });
        });
        clients.push(c);
    }
}

const failing = async (
    mode: Mode,
    length: number,
    first: number,
    count: number,
    withRestores = false,
    withUndo = false,
) => {
    const out: string[] = [];
    for (let seed = first; seed < first + count; seed++) {
        const vs = await runSeed(seed, mode, length, withRestores, withUndo);
        if (vs.length) out.push(`seed ${seed}: ${vs.join(" | ")}`);
    }
    return out;
};

// The server's keys in order, each once, and labels (or their start).
function expectServer(keys: number[], labels: Record<number, string>) {
    const now = server.list.map((x) => x.payloadJson);
    expect(now.map(keyOf), run.log.join("\n")).toEqual(keys);
    for (const [key, label] of Object.entries(labels)) {
        const found = labelOf(now.find((q: Any) => q.key === Number(key)));
        expect(found?.startsWith(label), `${key}: ${found}`).toBe(true);
    }
}

// The question with that key is on the server once, with that label (or
// its start).
function expectOnServer(key: number, label: string) {
    const found = server.list
        .map((x) => x.payloadJson)
        .filter((q: Any) => q.key === key);
    expect(found, run.log.join("\n")).toHaveLength(1);
    expect(labelOf(found[0])?.startsWith(label), labelOf(found[0])!).toBe(true);
}

// Shrunk traces of failures found this way, one or more per cause.
const TRACES: Array<{
    name: string;
    mode: Mode;
    seed: number;
    actions: Action[];
    // More to check once it has settled.
    check?: () => void;
}> = [
    {
        name: "owned: a question deleted after its save's answer was lost stays deleted",
        mode: "owned",
        seed: 42,
        actions: [
            { t: "user", c: 0, kind: "add", pick: 0.8820588334929198 },
            { t: "open", c: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.009526386857032776 },
            { t: "respond", c: 0, pick: 0.2208954244852066, lose: true },
            { t: "arrive", c: 0, pick: 0.8116995377931744 },
            { t: "respond", c: 0, pick: 0.4409842127934098, lose: true },
            { t: "user", c: 0, kind: "delete", pick: 0.9089464477729052 },
        ],
    },
    {
        name: "owned: a question deleted while a merged save is on its way stays deleted, nothing asked",
        mode: "owned",
        seed: 107,
        actions: [
            { t: "user", c: 1, kind: "edit", pick: 0.7929709069430828 },
            { t: "timer", c: 1 },
            { t: "open", c: 1 },
            { t: "arrive", c: 1, pick: 0.5737941297702491 },
            { t: "user", c: 1, kind: "add", pick: 0.7953668558038771 },
            { t: "respond", c: 1, pick: 0.1666027964092791, lose: false },
            { t: "arrive", c: 1, pick: 0.6858850938733667 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "edit", pick: 0.48992946092039347 },
            { t: "respond", c: 1, pick: 0.8825868375133723, lose: true },
            { t: "arrive", c: 1, pick: 0.6080950726754963 },
            { t: "respond", c: 1, pick: 0.5781292284373194, lose: false },
            { t: "arrive", c: 1, pick: 0.6294447628315538 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "delete", pick: 0.3655396858230233 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.10961393429897726, lose: false },
            { t: "arrive", c: 1, pick: 0.4282612691167742 },
            { t: "respond", c: 1, pick: 0.09720670408569276, lose: false },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "owned: our own earlier save isn't read as another's change to a question we then delete",
        mode: "owned",
        seed: 89,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.012219131458550692 },
            { t: "user", c: 1, kind: "add", pick: 0.7817840641364455 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.5706240644212812 },
            { t: "user", c: 0, kind: "add", pick: 0.5508768826257437 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "respond", c: 0, pick: 0.24393830355256796, lose: false },
            { t: "arrive", c: 1, pick: 0.030805539805442095 },
            { t: "arrive", c: 0, pick: 0.9660943222697824 },
            { t: "respond", c: 1, pick: 0.8817073665559292, lose: false },
            { t: "user", c: 0, kind: "delete", pick: 0.20848388667218387 },
            { t: "arrive", c: 1, pick: 0.5517188259400427 },
            { t: "respond", c: 1, pick: 0.8885685233399272, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.011058167787268758 },
            { t: "arrive", c: 1, pick: 0.6853058629203588 },
            { t: "timer", c: 1 },
            { t: "user", c: 0, kind: "delete", pick: 0.10977076017297804 },
            { t: "user", c: 0, kind: "delete", pick: 0.22055203304626048 },
            { t: "timer", c: 0 },
        ],
    },
    {
        name: "owned: the other side's change shown from an earlier answer isn't read as our edit",
        mode: "owned",
        seed: 3,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.598865546984598 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.37710838206112385 },
            { t: "user", c: 1, kind: "add", pick: 0.19334594788961112 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.1617409591563046 },
            { t: "user", c: 0, kind: "add", pick: 0.38310075155459344 },
            { t: "user", c: 0, kind: "edit", pick: 0.48229211824946105 },
            { t: "user", c: 1, kind: "edit", pick: 0.4225918164011091 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.40430479077622294, lose: false },
            { t: "arrive", c: 1, pick: 0.9855346034746617 },
            { t: "respond", c: 1, pick: 0.5001204945147038, lose: false },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.47678473498672247 },
        ],
    },
    {
        name: "owned: a list queued while an earlier one is on its way doesn't meet our own save as another's",
        mode: "owned",
        seed: 79,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.12376041617244482 },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "add", pick: 0.7621709641534835 },
            { t: "user", c: 0, kind: "delete", pick: 0.4258163380436599 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.7380127422511578 },
            { t: "arrive", c: 1, pick: 0.3727359480690211 },
            { t: "respond", c: 1, pick: 0.6975189773365855, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.45666839089244604 },
            { t: "arrive", c: 1, pick: 0.7184094963595271 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.8054163474589586, lose: false },
            { t: "arrive", c: 1, pick: 0.5312081591691822 },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "owned: an edit of our own added question isn't asked about against our earlier version",
        mode: "owned",
        seed: 138,
        actions: [
            { t: "user", c: 0, kind: "add", pick: 0.12662858562543988 },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "drag", pick: 0.9084559991024435 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.5559199322015047 },
            { t: "user", c: 0, kind: "delete", pick: 0.14897581725381315 },
            { t: "user", c: 0, kind: "add", pick: 0.5756941759027541 },
            { t: "arrive", c: 0, pick: 0.7111818133853376 },
            { t: "respond", c: 0, pick: 0.4166908848565072, lose: false },
            { t: "arrive", c: 0, pick: 0.6286614411510527 },
            { t: "respond", c: 0, pick: 0.018967251060530543, lose: false },
            { t: "arrive", c: 0, pick: 0.8491790320258588 },
            { t: "user", c: 0, kind: "edit", pick: 0.6597915343008935 },
            { t: "timer", c: 0 },
            { t: "user", c: 0, kind: "edit", pick: 0.46222899458371103 },
            { t: "respond", c: 0, pick: 0.9209688673727214, lose: false },
            { t: "timer", c: 0 },
        ],
    },
    {
        name: "owned: our last edit of a question we added stands",
        mode: "owned",
        seed: 65,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.3820509684737772 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.8946100242901593 },
            { t: "user", c: 0, kind: "delete", pick: 0.6842033572029322 },
            { t: "user", c: 1, kind: "drag", pick: 0.5897518037818372 },
            { t: "user", c: 0, kind: "delete", pick: 0.5005467170849442 },
            { t: "user", c: 0, kind: "add", pick: 0.6848346933256835 },
            { t: "timer", c: 1 },
            { t: "timer", c: 0 },
            { t: "respond", c: 0, pick: 0.8073954726569355, lose: false },
            { t: "user", c: 0, kind: "edit", pick: 0.16611739178188145 },
            { t: "arrive", c: 1, pick: 0.6198641273658723 },
            { t: "arrive", c: 0, pick: 0.2924944080878049 },
            { t: "respond", c: 1, pick: 0.017787240212783217, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.41272478946484625 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.3702676536049694 },
            { t: "respond", c: 1, pick: 0.5683718190994114, lose: false },
            { t: "timer", c: 0 },
            { t: "arrive", c: 1, pick: 0.13151883543469012 },
        ],
    },
    {
        name: "owned: our last edit stands after a lost answer",
        mode: "owned",
        seed: 79,
        actions: [
            { t: "user", c: 0, kind: "add", pick: 0.4789731693454087 },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "add", pick: 0.7621709641534835 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.7380127422511578 },
            { t: "arrive", c: 1, pick: 0.3727359480690211 },
            { t: "respond", c: 1, pick: 0.6975189773365855, lose: false },
            { t: "arrive", c: 1, pick: 0.7184094963595271 },
            { t: "user", c: 1, kind: "edit", pick: 0.3762297674547881 },
            { t: "user", c: 0, kind: "edit", pick: 0.9443272699136287 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.8054163474589586, lose: false },
            { t: "arrive", c: 1, pick: 0.5312081591691822 },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "owned: a late echo of a save of ours doesn't take the board back",
        mode: "owned",
        seed: 451,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.9301920812577009 },
            { t: "open", c: 0 },
            { t: "timer", c: 0 },
            { t: "user", c: 0, kind: "delete", pick: 0.17892308090813458 },
            { t: "arrive", c: 0, pick: 0.41821241076104343 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.28460599458776414 },
            { t: "respond", c: 0, pick: 0.41116504347883165, lose: false },
            { t: "respond", c: 0, pick: 0.601586407283321, lose: false },
            { t: "arrive", c: 0, pick: 0.046500123804435134 },
            { t: "respond", c: 0, pick: 0.031084258807823062, lose: false },
            { t: "sse", c: 0 },
            { t: "user", c: 0, kind: "edit", pick: 0.1253180482890457 },
        ],
    },
    {
        name: "owned: nothing lost when lists overlap a merged save",
        mode: "owned",
        seed: 987,
        actions: [
            { t: "user", c: 1, kind: "edit", pick: 0.9843499276321381 },
            { t: "user", c: 0, kind: "edit", pick: 0.7739404959138483 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.946606436278671 },
            { t: "user", c: 1, kind: "edit", pick: 0.25869044475257397 },
            { t: "timer", c: 1 },
            { t: "user", c: 0, kind: "edit", pick: 0.9528554636053741 },
            { t: "arrive", c: 1, pick: 0.05393353383988142 },
            { t: "respond", c: 1, pick: 0.7148421311285347, lose: false },
            { t: "arrive", c: 1, pick: 0.8087193637620658 },
            { t: "respond", c: 1, pick: 0.8594769986812025, lose: false },
            { t: "timer", c: 0 },
            { t: "arrive", c: 1, pick: 0.46979287010617554 },
        ],
    },
    {
        name: "owned: a later list holding our own earlier version isn't asked about",
        mode: "owned",
        seed: 10,
        actions: [
            { t: "user", c: 1, kind: "add", pick: 0.0665576143655926 },
            { t: "user", c: 0, kind: "delete", pick: 0.42688076314516366 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.06317825010046363 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.2543636744376272 },
            { t: "respond", c: 0, pick: 0.11492872820235789, lose: false },
            { t: "user", c: 0, kind: "edit", pick: 0.500353081850335 },
            { t: "arrive", c: 0, pick: 0.7918948368169367 },
            { t: "timer", c: 0 },
            { t: "respond", c: 0, pick: 0.9746526284143329, lose: false },
            { t: "user", c: 0, kind: "edit", pick: 0.1631632223725319 },
            { t: "arrive", c: 0, pick: 0.6561544670257717 },
            { t: "respond", c: 0, pick: 0.861632770858705, lose: false },
            { t: "timer", c: 0 },
            { t: "user", c: 0, kind: "delete", pick: 0.0432816359680146 },
        ],
    },
    {
        name: "owned: an edit queued behind a merged save isn't asked about",
        mode: "owned",
        seed: 114,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.7408635725732893 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.17347292136400938 },
            { t: "user", c: 1, kind: "edit", pick: 0.1453393460251391 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "edit", pick: 0.31506373290903866 },
            { t: "arrive", c: 1, pick: 0.9680214135441929 },
            { t: "respond", c: 1, pick: 0.07968511385843158, lose: false },
            { t: "arrive", c: 1, pick: 0.05210785078816116 },
            { t: "respond", c: 1, pick: 0.26000496675260365, lose: false },
            { t: "arrive", c: 1, pick: 0.7864894785452634 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "edit", pick: 0.0985251774545759 },
            { t: "respond", c: 1, pick: 0.4509232856798917, lose: false },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "edit", pick: 0.002991944784298539 },
        ],
    },
    {
        name: "shared: what we're asked to keep as ours is our own edit (seed 229)",
        mode: "shared",
        seed: 229,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.6403309875167906 },
            { t: "user", c: 1, kind: "edit", pick: 0.6201297647785395 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.042547235963866115 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.9907073122449219 },
            { t: "respond", c: 0, pick: 0.0006650001741945744, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.6647105745505542 },
            { t: "respond", c: 1, pick: 0.6663323575630784, lose: false },
            { t: "arrive", c: 0, pick: 0.688256778055802 },
            { t: "respond", c: 0, pick: 0.8693746235221624, lose: false },
            {
                t: "user",
                c: 0,
                kind: "resolve",
                pick: 0.3088902186136693,
                choice: "theirs",
            },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.974744024919346 },
        ],
    },
    {
        name: "shared: keeping our removal stands",
        mode: "shared",
        seed: 694,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.72602742863819 },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "delete", pick: 0.9399409878533334 },
            { t: "arrive", c: 0, pick: 0.3557686284184456 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.9905521310865879 },
            { t: "respond", c: 1, pick: 0.3273656778037548, lose: false },
            { t: "arrive", c: 1, pick: 0.6059237332083285 },
            { t: "respond", c: 1, pick: 0.9347739424556494, lose: false },
            { t: "user", c: 1, kind: "delete", pick: 0.862114361487329 },
            { t: "arrive", c: 1, pick: 0.9303740719333291 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.6162479822523892, lose: false },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.29323155363090336,
                choice: "mine",
            },
            { t: "user", c: 1, kind: "add", pick: 0.7906028258148581 },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: keeping our removal stands while a save is on its way",
        mode: "shared",
        seed: 80,
        actions: [
            { t: "user", c: 1, kind: "edit", pick: 0.6418647596146911 },
            { t: "timer", c: 1 },
            { t: "user", c: 0, kind: "edit", pick: 0.6607530289329588 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.8037523289676756 },
            { t: "arrive", c: 1, pick: 0.4057772399391979 },
            { t: "user", c: 1, kind: "delete", pick: 0.6551831471733749 },
            { t: "respond", c: 1, pick: 0.8567072097212076, lose: false },
            { t: "arrive", c: 1, pick: 0.29506786609999835 },
            { t: "respond", c: 1, pick: 0.9442260472569615, lose: false },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.6104835646692663,
                choice: "mine",
            },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: the last edit stands when no conflict was asked",
        mode: "shared",
        seed: 3,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0.9526147185824811 },
            { t: "user", c: 0, kind: "add", pick: 0.6755182791966945 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.5412889977451414 },
            { t: "user", c: 0, kind: "delete", pick: 0.38255645893514156 },
            { t: "user", c: 1, kind: "delete", pick: 0.5810752504039556 },
            { t: "user", c: 0, kind: "add", pick: 0.24660002207383513 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.4265890282113105 },
            { t: "user", c: 1, kind: "add", pick: 0.19334594788961112 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.7400958561338484, lose: false },
            { t: "arrive", c: 1, pick: 0.1617409591563046 },
            { t: "user", c: 0, kind: "add", pick: 0.38310075155459344 },
            { t: "user", c: 0, kind: "edit", pick: 0.48229211824946105 },
            { t: "respond", c: 1, pick: 0.40430479077622294, lose: false },
            { t: "timer", c: 0 },
            { t: "arrive", c: 1, pick: 0.07735156128183007 },
        ],
    },
    {
        name: "shared: the last removal stands when no conflict was asked",
        mode: "shared",
        seed: 12,
        actions: [
            { t: "user", c: 1, kind: "add", pick: 0.5196197067853063 },
            { t: "open", c: 1 },
            { t: "timer", c: 1 },
            { t: "user", c: 0, kind: "drag", pick: 0.4587694371584803 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 1, pick: 0.3421679788734764 },
            { t: "respond", c: 1, pick: 0.48128225887194276, lose: true },
            { t: "arrive", c: 0, pick: 0.28311347821727395 },
            { t: "arrive", c: 1, pick: 0.4430513319093734 },
            { t: "respond", c: 1, pick: 0.39183307345956564, lose: false },
            { t: "arrive", c: 1, pick: 0.7396203218959272 },
            { t: "respond", c: 1, pick: 0.2832642344292253, lose: false },
            { t: "arrive", c: 1, pick: 0.14596786256879568 },
            { t: "user", c: 1, kind: "add", pick: 0.8523917435668409 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "delete", pick: 0.8555211485363543 },
            { t: "respond", c: 1, pick: 0.7831752107013017, lose: false },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: only the other player's versions are asked about as theirs",
        mode: "shared",
        seed: 20,
        actions: [
            { t: "user", c: 0, kind: "add", pick: 0.5864549735561013 },
            { t: "user", c: 1, kind: "edit", pick: 0.48597282310947776 },
            { t: "timer", c: 1 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 1, pick: 0.5122565238270909 },
            { t: "arrive", c: 0, pick: 0.727243181085214 },
            { t: "user", c: 0, kind: "edit", pick: 0.03784771147184074 },
            { t: "respond", c: 0, pick: 0.2374553643167019, lose: false },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "edit", pick: 0.13219786901026964 },
            { t: "arrive", c: 0, pick: 0.5971130600664765 },
            { t: "user", c: 0, kind: "edit", pick: 0.017261276254430413 },
            { t: "respond", c: 0, pick: 0.4188470127992332, lose: false },
            { t: "arrive", c: 0, pick: 0.9285924094729125 },
            { t: "respond", c: 0, pick: 0.13051342871040106, lose: false },
            { t: "timer", c: 0 },
        ],
    },
    {
        name: "shared: their edit of a question we added, its answer lost, stands",
        mode: "shared",
        seed: 966,
        actions: [
            { t: "user", c: 1, kind: "drag", pick: 0.9538534523453563 },
            { t: "user", c: 0, kind: "add", pick: 0.42509488807991147 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.4568753489293158 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.25693174568004906 },
            { t: "respond", c: 1, pick: 0.04746910813264549, lose: false },
            { t: "arrive", c: 1, pick: 0.02690094243735075 },
            { t: "respond", c: 1, pick: 0.5304164243862033, lose: false },
            { t: "arrive", c: 1, pick: 0.46473636222071946 },
            { t: "respond", c: 1, pick: 0.7155135457869619, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.8705276281107217 },
            { t: "user", c: 0, kind: "drag", pick: 0.3761103458236903 },
            { t: "timer", c: 1 },
            { t: "timer", c: 0 },
            { t: "respond", c: 0, pick: 0.2820101783145219, lose: true },
            { t: "arrive", c: 1, pick: 0.9259955142624676 },
        ],
    },
    {
        name: "shared: their removal of a question we added, its answer lost, stands (the server's history tells)",
        mode: "shared",
        seed: 711,
        actions: [
            { t: "user", c: 1, kind: "add", pick: 0.601120886625722 },
            { t: "timer", c: 1 },
            { t: "open", c: 0 },
            { t: "arrive", c: 1, pick: 0.7951749414205551 },
            { t: "arrive", c: 0, pick: 0.6585886310786009 },
            { t: "respond", c: 0, pick: 0.1298726391978562, lose: false },
            { t: "user", c: 1, kind: "drag", pick: 0.8267316308338195 },
            { t: "user", c: 0, kind: "delete", pick: 0.9018684488255531 },
            { t: "timer", c: 1 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.5617486808914691, lose: true },
        ],
    },
    {
        name: "shared: their removal of a question we added in a list since replaced stands",
        mode: "shared",
        seed: 2998,
        actions: [
            { t: "user", c: 1, kind: "edit", pick: 0.27840773528441787 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.5642880578525364 },
            { t: "user", c: 0, kind: "add", pick: 0.11686095595359802 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.5023439270444214 },
            { t: "user", c: 1, kind: "add", pick: 0.1624947595410049 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.6639044261537492, lose: false },
            { t: "respond", c: 0, pick: 0.26070714741945267, lose: false },
            { t: "arrive", c: 1, pick: 0.3798379157669842 },
            { t: "user", c: 1, kind: "add", pick: 0.5374164916574955 },
            { t: "arrive", c: 0, pick: 0.05096851987764239 },
            { t: "respond", c: 0, pick: 0.9947893095668405, lose: false },
            { t: "arrive", c: 0, pick: 0.22098557092249393 },
            { t: "respond", c: 0, pick: 0.6336688199080527, lose: false },
            { t: "user", c: 0, kind: "delete", pick: 0.8941425960510969 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.8899402397219092, lose: true },
        ],
    },
    {
        name: "shared: keep mine stands while lists overlap (seed 981)",
        mode: "shared",
        seed: 981,
        actions: [
            { t: "user", c: 1, kind: "edit", pick: 0.5887577123939991 },
            { t: "user", c: 0, kind: "edit", pick: 0.8792201508767903 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.5637689658906311 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.1777973547577858 },
            { t: "user", c: 1, kind: "edit", pick: 0.8529653032310307 },
            { t: "respond", c: 1, pick: 0.2608573080506176, lose: false },
            { t: "arrive", c: 1, pick: 0.9977688989602029 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.6661478709429502, lose: false },
            { t: "arrive", c: 1, pick: 0.8236497945617884 },
            { t: "respond", c: 1, pick: 0.6310224181506783, lose: false },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.5953540490008891,
                choice: "mine",
            },
            { t: "user", c: 1, kind: "add", pick: 0.42895009997300804 },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: a list made before the board showed theirs doesn't ask about their version as ours (seed 185)",
        mode: "shared",
        seed: 185,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.5239507982041687 },
            { t: "timer", c: 0 },
            { t: "user", c: 1, kind: "edit", pick: 0.9029556955210865 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.12999839358963072 },
            { t: "user", c: 1, kind: "edit", pick: 0.6323673669248819 },
            { t: "user", c: 0, kind: "delete", pick: 0.03633315791375935 },
            { t: "timer", c: 1 },
            { t: "fail", c: 1, pick: 0.7552406117320061 },
            { t: "arrive", c: 1, pick: 0.7401651707477868 },
            { t: "respond", c: 1, pick: 0.6492937544826418, lose: false },
            { t: "user", c: 0, kind: "add", pick: 0.42439990281127393 },
            { t: "arrive", c: 1, pick: 0.5877778730355203 },
            { t: "user", c: 0, kind: "edit", pick: 0.3089006410446018 },
            { t: "respond", c: 1, pick: 0.5209254950750619, lose: false },
            { t: "timer", c: 0 },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.11119414563290775,
                choice: "theirs",
            },
            { t: "user", c: 0, kind: "add", pick: 0.8267046196851879 },
            { t: "user", c: 0, kind: "add", pick: 0.10688591655343771 },
            { t: "user", c: 0, kind: "delete", pick: 0.1786239619832486 },
        ],
    },
    {
        name: "shared: a decision shown on the board isn't applied again to later lists (seed 498)",
        mode: "shared",
        seed: 498,
        actions: [
            { t: "user", c: 1, kind: "add", pick: 0.2683426404837519 },
            { t: "user", c: 1, kind: "delete", pick: 0.68624381814152 },
            { t: "user", c: 0, kind: "add", pick: 0.9764247313141823 },
            { t: "user", c: 0, kind: "delete", pick: 0.8600559923797846 },
            { t: "user", c: 0, kind: "edit", pick: 0.7823539806995541 },
            { t: "user", c: 0, kind: "delete", pick: 0.7390578372869641 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.9283643099479377 },
            { t: "user", c: 0, kind: "edit", pick: 0.6668750583194196 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.8346137695480138 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.5923042029608041, lose: false },
            { t: "arrive", c: 1, pick: 0.9580713356845081 },
            { t: "respond", c: 1, pick: 0.466496255248785, lose: false },
            { t: "user", c: 0, kind: "edit", pick: 0.6824253702070564 },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.08761091018095613,
                choice: "theirs",
            },
        ],
    },
    {
        name: "shared: our own save isn't asked about as theirs after a decision (seed 2617)",
        mode: "shared",
        seed: 2617,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.15366195072419941 },
            { t: "user", c: 1, kind: "edit", pick: 0.23533796542324126 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.26879174914211035 },
            { t: "arrive", c: 1, pick: 0.6406499219592661 },
            { t: "user", c: 1, kind: "delete", pick: 0.44024141877889633 },
            { t: "respond", c: 1, pick: 0.9969491744413972, lose: false },
            { t: "arrive", c: 1, pick: 0.8384362983051687 },
            { t: "respond", c: 1, pick: 0.7094486218411475, lose: false },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.1330487672239542,
                choice: "mine",
            },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.5295792794786394 },
            { t: "respond", c: 1, pick: 0.3070554160512984, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.3018526351079345 },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: the board's answer to theirs is saved when its list's merge leaves it out (seed 8049)",
        mode: "shared",
        seed: 8049,
        actions: [
            { t: "user", c: 0, kind: "edit", pick: 0.004027310525998473 },
            { t: "user", c: 1, kind: "edit", pick: 0.22451748070307076 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.017843574285507202 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.19336569285951555 },
            { t: "respond", c: 1, pick: 0.7834894163534045, lose: false },
            { t: "arrive", c: 1, pick: 0.5375975230708718 },
            { t: "user", c: 0, kind: "drag", pick: 0.7326506655663252 },
            { t: "respond", c: 1, pick: 0.10430258954875171, lose: false },
            {
                t: "user",
                c: 1,
                kind: "resolve",
                pick: 0.8245260484982282,
                choice: "mine",
            },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "respond", c: 0, pick: 0.7669111371506006, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.17022112174890935 },
            { t: "arrive", c: 0, pick: 0.9539326168596745 },
            { t: "arrive", c: 1, pick: 0.632090802770108 },
            { t: "respond", c: 1, pick: 0.7540974169969559, lose: false },
            { t: "arrive", c: 1, pick: 0.9293794094119221 },
            { t: "respond", c: 1, pick: 0.20127554051578045, lose: false },
            { t: "arrive", c: 1, pick: 0.7933398056775331 },
            { t: "respond", c: 1, pick: 0.8981920292135328, lose: false },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: both editing a question we added, its answer lost, is asked about (seed 6728; a guard: right before too)",
        mode: "shared",
        seed: 6728,
        actions: [
            { t: "user", c: 1, kind: "delete", pick: 0.8562682957854122 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.3199330067727715 },
            { t: "user", c: 1, kind: "add", pick: 0.3725017770193517 },
            { t: "user", c: 0, kind: "edit", pick: 0.3574681989848614 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.6372901464346796 },
            { t: "respond", c: 0, pick: 0.5060060343239456, lose: false },
            { t: "respond", c: 1, pick: 0.3799635984469205, lose: false },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.6922010492999107 },
            { t: "arrive", c: 0, pick: 0.12391723319888115 },
            { t: "respond", c: 0, pick: 0.31599635048769414, lose: false },
            { t: "user", c: 1, kind: "add", pick: 0.563277630135417 },
            { t: "arrive", c: 0, pick: 0.37496715341694653 },
            { t: "respond", c: 0, pick: 0.4410112227778882, lose: false },
            { t: "user", c: 1, kind: "delete", pick: 0.28085717209614813 },
            { t: "user", c: 0, kind: "edit", pick: 0.8750405011232942 },
            { t: "user", c: 1, kind: "edit", pick: 0.5968467004131526 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.5387357692234218, lose: true },
            { t: "arrive", c: 1, pick: 0.8919173390604556 },
            { t: "respond", c: 1, pick: 0.253578535746783, lose: false },
            { t: "user", c: 1, kind: "edit", pick: 0.28215893916785717 },
            { t: "arrive", c: 1, pick: 0.7733136892784387 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.6737166126258671, lose: false },
            { t: "arrive", c: 1, pick: 0.00820006150752306 },
            { t: "fail", c: 1, pick: 0.06897614104673266 },
            { t: "timer", c: 0 },
        ],
    },
    {
        name: "shared: our edit of a question we added, removed there meanwhile, its answer lost, is asked about (seed 1148; a guard: right before too)",
        mode: "shared",
        seed: 1148,
        actions: [
            { t: "user", c: 1, kind: "delete", pick: 0.013753080973401666 },
            { t: "user", c: 1, kind: "add", pick: 0.8743141917511821 },
            { t: "timer", c: 1 },
            { t: "open", c: 0 },
            { t: "user", c: 1, kind: "add", pick: 0.7698493062052876 },
            { t: "arrive", c: 1, pick: 0.5926457569003105 },
            { t: "user", c: 1, kind: "add", pick: 0.9006359167397022 },
            { t: "arrive", c: 0, pick: 0.5352018969133496 },
            { t: "respond", c: 0, pick: 0.9695082330144942, lose: false },
            { t: "user", c: 0, kind: "delete", pick: 0.9337027498986572 },
            { t: "user", c: 1, kind: "add", pick: 0.2480492836330086 },
            { t: "user", c: 1, kind: "edit", pick: 0.43393441033549607 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.6041897782124579, lose: true },
            { t: "timer", c: 1 },
        ],
    },
    {
        name: "shared: our edit of a question we added, removed there meanwhile, is asked about (seed 2015; a guard: right before too)",
        mode: "shared",
        seed: 2015,
        actions: [
            { t: "user", c: 1, kind: "add", pick: 0.1632031484041363 },
            { t: "user", c: 0, kind: "delete", pick: 0.4295044243335724 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "add", pick: 0.4935923609882593 },
            { t: "arrive", c: 1, pick: 0.4154213967267424 },
            { t: "arrive", c: 0, pick: 0.8661324698477983 },
            { t: "respond", c: 1, pick: 0.24201752012595534, lose: true },
            { t: "respond", c: 0, pick: 0.8341696541756392, lose: false },
            { t: "arrive", c: 0, pick: 0.5034296521916986 },
            { t: "timer", c: 1 },
            { t: "respond", c: 0, pick: 0.873427880462259, lose: false },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0.9000080623663962 },
            { t: "user", c: 1, kind: "delete", pick: 0.17449352610856295 },
            { t: "respond", c: 0, pick: 0.7169497879222035, lose: false },
            { t: "arrive", c: 1, pick: 0.3956723087467253 },
            { t: "timer", c: 1 },
            { t: "respond", c: 1, pick: 0.7964460079092532, lose: true },
            { t: "user", c: 0, kind: "delete", pick: 0.8160222971346229 },
            { t: "arrive", c: 1, pick: 0.49840861186385155 },
            { t: "respond", c: 1, pick: 0.024293430848047137, lose: false },
            { t: "arrive", c: 1, pick: 0.9076712867245078 },
            { t: "user", c: 1, kind: "edit", pick: 0.6723260118160397 },
            { t: "timer", c: 1 },
            { t: "timer", c: 0 },
            { t: "respond", c: 1, pick: 0.8978476589545608, lose: false },
            { t: "arrive", c: 1, pick: 0.8353876068722457 },
            { t: "respond", c: 1, pick: 0.7597655416466296, lose: false },
            { t: "arrive", c: 1, pick: 0.3587113276589662 },
            { t: "respond", c: 1, pick: 0.8224441171623766, lose: true },
        ],
    },
    // Restores, as the History's Restore makes them (withRestores only).
    {
        name: "shared: a question restored with an unsent edit, after the server moved on, stays restored",
        mode: "shared",
        seed: 1,
        actions: [
            { t: "open", c: 0 },
            { t: "open", c: 1 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // B deletes question 1, and it's saved.
            { t: "user", c: 1, kind: "delete", pick: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A sees the delete, edits question 2 and, before that's
            // saved, restores question 1.
            { t: "sse", c: 0 },
            { t: "user", c: 0, kind: "edit", pick: 0 },
            { t: "user", c: 0, kind: "restore", pick: 0 },
            // B saves an edit of question 3 that A hasn't seen.
            { t: "user", c: 1, kind: "edit", pick: 0.4 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A's save is on an old base: 409, merged, saved again.
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/PUT base=4 .*→ 409/);
            expectServer([1001, 2, 3, 4], {
                1001: "init-1",
                2: "c0.",
                3: "c1.",
            });
        },
    },
    {
        name: "shared: a restore merged with the other player's save that went first stays",
        mode: "shared",
        seed: 2,
        actions: [
            { t: "open", c: 0 },
            { t: "open", c: 1 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "user", c: 1, kind: "delete", pick: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "sse", c: 0 },
            // A restores question 1 while B edits question 2; both save at
            // once, and B's gets there first.
            { t: "user", c: 0, kind: "restore", pick: 0 },
            { t: "user", c: 1, kind: "edit", pick: 0 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/PUT base=4 .*→ 409/);
            expectServer([1001, 2, 3, 4], { 1001: "init-1", 2: "c1." });
        },
    },
    {
        name: "owned: a question restored after its delete's answer was lost is on the server once",
        mode: "owned",
        seed: 3,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: true },
            // Sent again: the server knows it already.
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "user", c: 0, kind: "restore", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => expectServer([1001, 2, 3, 4], { 1001: "init-1" }),
    },
    {
        name: "shared: both restoring a question at once gives two, each once",
        mode: "shared",
        seed: 6,
        actions: [
            { t: "open", c: 0 },
            { t: "open", c: 1 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "sse", c: 1 },
            // Neither has seen the other's restore.
            { t: "user", c: 0, kind: "restore", pick: 0 },
            { t: "user", c: 1, kind: "restore", pick: 0 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "respond", c: 1, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/PUT base=4 .*→ 409/);
            const keys = server.list
                .map((x) => x.payloadJson.key)
                .sort((a, b) => a - b);
            expect(keys).toEqual([2, 3, 4, 1001, 2001]);
            expectOnServer(1001, "init-1");
            expectOnServer(2001, "init-1");
        },
    },
    // Undo, as the delete toast's (withUndo only).
    {
        name: "owned: Undo after the delete's answer was lost puts back a copy that stays",
        mode: "owned",
        seed: 7,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: true },
            { t: "user", c: 0, kind: "undo", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/undo 1 as 1001/);
            expectServer([1001, 2, 3, 4], { 1001: "init-1" });
        },
    },
    {
        name: "owned: Undo within 500 ms of the delete puts the same key back, and the server never hears of the delete",
        mode: "owned",
        seed: 8,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "user", c: 0, kind: "undo", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/undo 1$/m);
            expectServer([1, 2, 3, 4], { 1: "init-1" });
            for (const e of server.events)
                expect(
                    e.payloadJson.questions.map((x: Any) => x.payloadJson.key),
                ).toContain(1);
        },
    },
    {
        name: "owned: Undo while an earlier list is on its way and the delete's list waits behind it puts the same key back",
        mode: "owned",
        seed: 11,
        actions: [
            // A edits question 3, and that list goes out.
            { t: "user", c: 0, kind: "edit", pick: 0.9 },
            { t: "timer", c: 0 },
            { t: "pause", c: 0, ms: 2 },
            // A deletes question 1: its list is queued behind that one.
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "user", c: 0, kind: "undo", pick: 0 },
            // Only then is the first one answered.
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/undo 1$/m);
            expectServer([1, 2, 3, 4], { 1: "init-1", 3: "c0." });
            // The edit's list went first, and none since lacks question 1.
            const first = server.events[0].payloadJson.questions;
            expect(labelOf(first[2].payloadJson)).toMatch(/^c0\./);
            for (const e of server.events)
                expect(
                    e.payloadJson.questions.map((x: Any) => x.payloadJson.key),
                ).toContain(1);
        },
    },
    {
        name: "shared: Undo within 500 ms of the delete puts the same key back, and a teammate's edit it hadn't seen stays",
        mode: "shared",
        seed: 12,
        actions: [
            { t: "open", c: 0 },
            { t: "open", c: 1 },
            // B edits question 1, saved; A hasn't heard yet.
            { t: "user", c: 1, kind: "edit", pick: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A deletes it, and takes that back at once.
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "user", c: 0, kind: "undo", pick: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/undo 1$/m);
            expectOnServer(1, "c1.");
            for (const e of server.events)
                expect(
                    e.payloadJson.questions.map((x: Any) => x.payloadJson.key),
                ).toContain(1);
        },
    },
    {
        name: "shared: Undo after a teammate restored the question adds no second copy",
        mode: "shared",
        seed: 9,
        actions: [
            { t: "open", c: 0 },
            { t: "open", c: 1 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A deletes question 1, and it's saved.
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            // B sees it, restores it, and that's saved.
            { t: "sse", c: 1 },
            { t: "user", c: 1, kind: "restore", pick: 0 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A sees its own save and B's copy, then presses Undo.
            { t: "sse", c: 0 },
            { t: "sse", c: 0 },
            { t: "user", c: 0, kind: "undo", pick: 0 },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/undo \(already back: 1\)/);
            expectServer([2001, 2, 3, 4], { 2001: "init-1" });
        },
    },
    {
        name: "shared: Undo while the delete's save is being merged (409) puts back a copy that stays",
        mode: "shared",
        seed: 10,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            // B saves an edit first.
            { t: "user", c: 1, kind: "edit", pick: 0.3 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A's delete meets it: 409, and A presses Undo meanwhile.
            { t: "arrive", c: 0, pick: 0 },
            { t: "user", c: 0, kind: "undo", pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => {
            expect(run.log.join("\n")).toMatch(/PUT base=3 .*→ 409/);
            expect(run.log.join("\n")).toMatch(/undo 1 as 1001/);
            expectServer([1001, 2, 3, 4], { 1001: "init-1", 2: "c1." });
        },
    },
    // Restores that went wrong while Restore put the deleted key back, kept
    // as regression tests now that it restores under a new key.
    {
        name: "owned: a restore made while our own save deleting it hasn't been answered stays",
        mode: "owned",
        seed: 4,
        actions: [
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: true },
            { t: "user", c: 0, kind: "restore", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => expectServer([1001, 2, 3, 4], { 1001: "init-1" }),
    },
    {
        name: "shared: a restore doesn't turn a held 'they deleted it' into a false 'both changed'",
        mode: "shared",
        seed: 5,
        actions: [
            // A deletes question 1 while B edits it; A's save goes first.
            { t: "user", c: 0, kind: "delete", pick: 0 },
            { t: "user", c: 1, kind: "edit", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
            // B's save meets it: B is asked, and saves the rest.
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            { t: "arrive", c: 1, pick: 0 },
            { t: "respond", c: 1, pick: 0, lose: false },
            // A restores it, as a new question: B's decision is still
            // about the deleted one.
            { t: "user", c: 0, kind: "restore", pick: 0 },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0 },
            { t: "respond", c: 0, pick: 0, lose: false },
        ],
        check: () => expectOnServer(1001, "init-1"),
    },
    {
        name: "owned: the other player's list from before a delete leaves the restored question (seed 48)",
        mode: "owned",
        seed: 48,
        actions: [
            { t: "user", c: 1, kind: "delete", pick: 0.59562938218005 },
            { t: "user", c: 0, kind: "delete", pick: 0.1380593916401267 },
            { t: "timer", c: 0 },
            { t: "timer", c: 1 },
            { t: "user", c: 1, kind: "add", pick: 0.7656115107238293 },
            { t: "arrive", c: 0, pick: 0.6749952062964439 },
            { t: "timer", c: 1 },
            { t: "arrive", c: 1, pick: 0.3366285194642842 },
            { t: "respond", c: 1, pick: 0.49165692762471735, lose: false },
            { t: "arrive", c: 1, pick: 0.22654975997284055 },
            { t: "user", c: 0, kind: "restore", pick: 0.9179255010094494 },
            { t: "respond", c: 1, pick: 0.2312664717901498, lose: false },
            { t: "arrive", c: 1, pick: 0.08693231944926083 },
            { t: "timer", c: 0 },
        ],
        check: () => expectOnServer(1001, "init-1"),
    },
    {
        name: "shared: two restores of one question don't replace an edit made since (seed 193)",
        mode: "shared",
        seed: 193,
        actions: [
            { t: "user", c: 0, kind: "add", pick: 0.7350726046133786 },
            { t: "user", c: 0, kind: "add", pick: 0.9193546483293176 },
            { t: "timer", c: 0 },
            { t: "user", c: 0, kind: "delete", pick: 0.7627009155694395 },
            { t: "arrive", c: 0, pick: 0.6037480763625354 },
            { t: "respond", c: 0, pick: 0.666212287498638, lose: false },
            { t: "timer", c: 0 },
            { t: "arrive", c: 0, pick: 0.6513102566823363 },
            { t: "user", c: 0, kind: "restore", pick: 0.6054274472407997 },
            { t: "user", c: 1, kind: "restore", pick: 0.3038784780073911 },
            { t: "user", c: 0, kind: "delete", pick: 0.951697904849425 },
            { t: "user", c: 0, kind: "edit", pick: 0.9098931110929698 },
        ],
        check: () => {
            // c0's copy, edited since, and c1's copy as it was deleted.
            expectOnServer(1003, "c0.");
            expectOnServer(2001, "c0.1");
        },
    },
];

describe("two players editing questions, at random", () => {
    beforeAll(async () => {
        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        await makeClients();
    }, 60_000);
    afterAll(() => {
        vi.restoreAllMocks();
    });

    for (const trace of TRACES) {
        test(trace.name, async () => {
            await setup();
            for (const a of trace.actions) {
                run.step++;
                const did = await applyAction(a, trace.mode);
                if (did)
                    run.log.push(
                        `${String(run.step).padStart(3)} c${a.c}: ${did}`,
                    );
                await checkStep(trace.mode);
            }
            const vs = await settleAndCheck(
                trace.mode,
                mulberry32(trace.seed ^ 0x9e3779b9),
            );
            expect(vs, run.log.join("\n")).toEqual([]);
            trace.check?.();
        });
    }

    test("each editing their own questions: nothing lost, back or asked", async () => {
        expect(await failing("owned", 60, 1, 300)).toEqual([]);
        expect(await failing("owned", 120, 1001, 100)).toEqual([]);
    }, 60_000);

    test("both editing everything: only real conflicts asked, decisions stand", async () => {
        expect(await failing("shared", 60, 1, 300)).toEqual([]);
        expect(await failing("shared", 120, 1001, 100)).toEqual([]);
    }, 60_000);

    test("each editing their own questions, restoring deleted ones: nothing lost, back or asked", async () => {
        expect(await failing("owned", 60, 1, 300, true)).toEqual([]);
        expect(await failing("owned", 120, 1001, 100, true)).toEqual([]);
    }, 60_000);

    test("both editing everything, restoring deleted ones: only real conflicts asked, restores stand", async () => {
        expect(await failing("shared", 60, 1, 300, true)).toEqual([]);
        expect(await failing("shared", 120, 1001, 100, true)).toEqual([]);
    }, 60_000);

    test("each editing their own questions, undoing and restoring deletes: nothing lost, back or asked", async () => {
        expect(await failing("owned", 60, 1, 300, true, true)).toEqual([]);
        expect(await failing("owned", 120, 1001, 100, true, true)).toEqual([]);
    }, 60_000);

    test("both editing everything, undoing and restoring deletes: only real conflicts asked, undos stand", async () => {
        expect(await failing("shared", 60, 1, 300, true, true)).toEqual([]);
        expect(await failing("shared", 120, 1001, 100, true, true)).toEqual([]);
    }, 60_000);
});
