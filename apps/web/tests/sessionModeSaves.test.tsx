// SessionManager saves the hider and planning mode a player sets, but never
// the values a session load just showed. Rendered with React into a minimal
// stand-in for the DOM (there is no DOM library here); the server is a fake
// fetch, and the saves are spies.
import type { GameSessionSummary } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
    // Just enough of the DOM for react-dom to render SessionManager.
    class FakeNode {
        parentNode: FakeNode | null = null;
        childNodes: FakeNode[] = [];
        attributes = new Map<string, string>();
        style: Record<string, unknown> = {
            setProperty() {},
            removeProperty() {},
        };
        nodeValue: string | null = null;
        constructor(
            public nodeType: number,
            public nodeName: string,
            public ownerDocument: FakeNode | null,
            public namespaceURI = "http://www.w3.org/1999/xhtml",
        ) {}
        get tagName() {
            return this.nodeName;
        }
        get firstChild() {
            return this.childNodes[0] ?? null;
        }
        get lastChild() {
            return this.childNodes[this.childNodes.length - 1] ?? null;
        }
        get nextSibling() {
            const siblings = this.parentNode?.childNodes ?? [];
            return siblings[siblings.indexOf(this) + 1] ?? null;
        }
        get parentElement() {
            return this.parentNode;
        }
        get options() {
            return this.childNodes.filter((n) => n.nodeName === "OPTION");
        }
        get textContent(): string {
            if (this.nodeType === 3) return this.nodeValue ?? "";
            return this.childNodes.map((n) => n.textContent).join("");
        }
        set textContent(value: string) {
            for (const child of this.childNodes) child.parentNode = null;
            this.childNodes = [];
            if (value) {
                const text = new FakeNode(3, "#text", this.ownerDocument);
                text.nodeValue = value;
                this.appendChild(text);
            }
        }
        appendChild(child: FakeNode) {
            child.parentNode?.removeChild(child);
            this.childNodes.push(child);
            child.parentNode = this;
            return child;
        }
        insertBefore(child: FakeNode, before: FakeNode | null) {
            if (!before) return this.appendChild(child);
            child.parentNode?.removeChild(child);
            this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
            child.parentNode = this;
            return child;
        }
        removeChild(child: FakeNode) {
            this.childNodes = this.childNodes.filter((n) => n !== child);
            child.parentNode = null;
            return child;
        }
        contains(node: FakeNode | null): boolean {
            for (let n = node; n; n = n.parentNode) if (n === this) return true;
            return false;
        }
        getRootNode() {
            return this.ownerDocument ?? this;
        }
        setAttribute(name: string, value: unknown) {
            this.attributes.set(name, String(value));
        }
        setAttributeNS(_ns: string, name: string, value: unknown) {
            this.setAttribute(name, value);
        }
        getAttribute(name: string) {
            return this.attributes.get(name) ?? null;
        }
        hasAttribute(name: string) {
            return this.attributes.has(name);
        }
        removeAttribute(name: string) {
            this.attributes.delete(name);
        }
        removeAttributeNS(_ns: string, name: string) {
            this.removeAttribute(name);
        }
        addEventListener() {}
        removeEventListener() {}
        focus() {}
        blur() {}
        // Every element below, in document order.
        *walk(): Generator<FakeNode> {
            for (const child of this.childNodes) {
                yield child;
                yield* child.walk();
            }
        }
    }
    class FakeDocument extends FakeNode {
        documentElement: FakeNode;
        head: FakeNode;
        body: FakeNode;
        activeElement: FakeNode | null = null;
        defaultView: unknown = null;
        visibilityState = "visible";
        constructor() {
            super(9, "#document", null);
            this.documentElement = this.createElement("html");
            this.head = this.createElement("head");
            this.body = this.createElement("body");
            this.appendChild(this.documentElement);
            this.documentElement.appendChild(this.head);
            this.documentElement.appendChild(this.body);
            this.activeElement = this.body;
        }
        createElement(tag: string) {
            return new FakeNode(1, tag.toUpperCase(), this);
        }
        createElementNS(ns: string, tag: string) {
            return new FakeNode(1, tag, this, ns);
        }
        createTextNode(text: string) {
            const node = new FakeNode(3, "#text", this);
            node.nodeValue = text;
            return node;
        }
        getElementById() {
            return null;
        }
        // The picker's dialogs look for the map's modal container.
        querySelector() {
            return null;
        }
    }
    const document = new FakeDocument();
    const window = Object.assign(new EventTarget(), {
        document,
        HTMLIFrameElement: class {},
        location: { href: "http://localhost/map", origin: "http://localhost" },
    });
    document.defaultView = window;
    const store = new Map<string, string>();
    const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        get length() {
            return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
    };
    // A stream that only delivers what a test sends on it.
    class FakeEventSource {
        static CLOSED = 2;
        static last: FakeEventSource | null = null;
        onopen: ((e: unknown) => void) | null = null;
        onmessage: ((e: { data: string }) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        readyState = 0;
        constructor(public url: string) {
            FakeEventSource.last = this;
        }
        close() {
            this.readyState = 2;
        }
    }
    Object.assign(globalThis, {
        window,
        document,
        localStorage: storage,
        sessionStorage: storage,
        EventSource: FakeEventSource,
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    return { document, store, FakeEventSource };
});

vi.mock("@/lib/games", async (importOriginal) => {
    const { gameDefinitionReady } = await import("@/lib/context");
    return {
        ...(await importOriginal<typeof import("@/lib/games")>()),
        fetchGameCatalog: vi.fn(async () => []),
        leaveGame: vi.fn(() => gameDefinitionReady.set(false)),
        switchToGame: vi.fn(async () => {
            gameDefinitionReady.set(true);
            return true;
        }),
    };
});
vi.mock("@/lib/syncManager", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/syncManager")>()),
    flushPendingEvents: vi.fn(async () => {}),
    startSyncManager: vi.fn(),
}));
vi.mock("@/lib/sessionState", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/sessionState")>()),
    loadSessionContent: vi.fn(),
    saveHiderModeToServer: vi.fn(),
    savePlanningModeToServer: vi.fn(),
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SessionManager } from "@/components/SessionManager";
import {
    activeSessionData,
    activeSessionId,
    clearActiveSession,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import { hiderMode, planningModeEnabled } from "@/lib/context";
import { setCachedSession } from "@/lib/eventQueue";
import {
    loadSessionContent,
    saveHiderModeToServer,
    savePlanningModeToServer,
} from "@/lib/sessionState";

const USER = "user-1";
const session = (
    id: string,
    overrides: Partial<GameSessionSummary> = {},
): GameSessionSummary => ({
    id,
    gameId: "game-1",
    gameName: "Game",
    serverId: "server-1",
    name: `Session ${id}`,
    visibility: "private",
    role: "creator",
    createdAt: "2026-01-01T00:00:00.000Z",
    hiderLat: null,
    hiderLng: null,
    planningModeEnabled: false,
    gameRevisionId: "rev-1",
    ...overrides,
});

// What the fake server has for each session.
let server: Record<string, GameSessionSummary> = {};
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/servers") {
        return json({
            servers: [
                {
                    id: "server-1",
                    name: "Server",
                    isMember: true,
                    permissions: [],
                },
            ],
        });
    }
    if (url.pathname === "/sessions") {
        return json({ sessions: Object.values(server) });
    }
    const match = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (match && server[match[1]]) return json(server[match[1]]);
    return json({ error: "not found" }, 404);
});

// Lets every pending request, timer-free promise chain and React update run.
const settle = () =>
    act(async () => {
        for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    });

// What this browser kept of a session for this account.
const keep = (kept: GameSessionSummary) =>
    setCachedSession({
        sessionId: kept.id,
        userId: USER,
        role: kept.role,
        session: kept,
        strokes: [],
        questions: [],
        lastSyncedAt: 0,
        lastSequence: 0,
    });

let root: Root | null = null;
// Opens the map page with `id` as the session it last showed. Offline, /me
// can't be reached and the board is painted from what this browser kept.
const reload = async (id: string, { offline = false } = {}) => {
    activeSessionId.set(id);
    (offline ? offlineUserId : verifiedUserId).set(USER);
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(createElement(SessionManager)));
    await settle();
};

// The player changes a mode, as the map and the Options drawer do.
const play = async (change: () => void) => {
    await act(async () => change());
    await settle();
};

// Calls a rendered element's click handler, as a tap would.
const click = async (matches: (text: string) => boolean) => {
    const container = env.document.body;
    const node = [...container.walk()].find(
        (n) => n.nodeName === "BUTTON" && matches(n.textContent),
    );
    if (!node) throw new Error("no such button");
    const propsKey = Object.keys(node).find((k) =>
        k.startsWith("__reactProps$"),
    )!;
    const props = (
        node as unknown as Record<
            string,
            { onClick: (event: { currentTarget: unknown }) => void }
        >
    )[propsKey];
    await act(async () => props.onClick({ currentTarget: node }));
    await settle();
};

// A live event on the session's stream, as the server sends it.
let sequence = 0;
const serverSends = async (
    sessionId: string,
    type: string,
    payloadJson: unknown,
) => {
    const source = env.FakeEventSource.last!;
    await act(async () =>
        source.onmessage!({
            data: JSON.stringify({
                id: `event-${++sequence}`,
                sessionId,
                userId: "user-2",
                type,
                payloadJson,
                sequence,
            }),
        }),
    );
    await settle();
};

beforeEach(() => {
    env.store.clear();
    server = {};
    sequence = 0;
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(loadSessionContent).mockImplementation(async (id) => ({
        strokes: [],
        questions: [],
        session: server[id],
        cursor: 0,
    }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    env.document.body.textContent = "";
    clearActiveSession();
    activeSessionData.set(null);
    verifiedUserId.set(null);
    offlineUserId.set(null);
    hiderMode.set(false);
    planningModeEnabled.set(false);
    vi.clearAllMocks();
    vi.restoreAllMocks();
});

describe("planning mode and hider saves after a session load", () => {
    it("saves the first planning toggle after a reload", async () => {
        server = { a: session("a") };
        await reload("a");

        await play(() => planningModeEnabled.set(true));

        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", true);
    });

    it("saves the first hider placed after a reload", async () => {
        server = { a: session("a") };
        await reload("a");

        const hider = { latitude: 51.92, longitude: 4.48 };
        await play(() => hiderMode.set(hider));

        expect(saveHiderModeToServer).toHaveBeenCalledWith("a", hider);
    });

    it("saves the first change on a board restored offline", async () => {
        keep(session("a"));
        await reload("a", { offline: true });
        expect(activeSessionData.get()?.id).toBe("a");

        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", true);
        const hider = { latitude: 1, longitude: 2 };
        await play(() => hiderMode.set(hider));
        expect(saveHiderModeToServer).toHaveBeenCalledWith("a", hider);
    });

    it("saves the first change after a reload painted from what was kept", async () => {
        server = { a: session("a") };
        keep(session("a"));
        await reload("a");

        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", true);
    });

    it("saves the first change after a reload whose content failed to load", async () => {
        server = { a: session("a") };
        keep(session("a"));
        vi.mocked(loadSessionContent).mockRejectedValue(new Error("offline"));
        await reload("a");

        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", true);
    });

    it("saves a toggle and the toggle back after a reload", async () => {
        server = { a: session("a") };
        await reload("a");

        await play(() => planningModeEnabled.set(true));
        await play(() => planningModeEnabled.set(false));

        expect(vi.mocked(savePlanningModeToServer).mock.calls).toEqual([
            ["a", true],
            ["a", false],
        ]);
    });

    it("saves the first change once a failed load shows the board again", async () => {
        server = { a: session("a"), b: session("b") };
        await reload("a");

        // b doesn't load and nothing of it was kept: the board shows nothing
        // of it, and nothing is saved.
        vi.mocked(loadSessionContent).mockRejectedValue(new Error("offline"));
        await click((text) => text === "change");
        await click((text) => text.includes("Session b"));
        expect(activeSessionId.get()).toBe("b");
        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).not.toHaveBeenCalled();

        // Loading it again fails too, but shows what was kept by now.
        keep(session("b"));
        await click((text) => text === "change");
        await click((text) => text.includes("Session b"));

        await play(() => planningModeEnabled.set(false));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("b", false);
    });

    it("saves nothing a spectator changes", async () => {
        server = { a: session("a", { role: "viewer" }) };
        await reload("a");

        await play(() => planningModeEnabled.set(true));
        await play(() => hiderMode.set({ latitude: 1, longitude: 2 }));

        expect(savePlanningModeToServer).not.toHaveBeenCalled();
        expect(saveHiderModeToServer).not.toHaveBeenCalled();
        // A spectator's board never shows the hider.
        expect(hiderMode.get()).toBe(false);
    });

    it("doesn't save back the modes a reload loaded, but saves the next change", async () => {
        server = {
            a: session("a", {
                hiderLat: 51.92,
                hiderLng: 4.48,
                planningModeEnabled: true,
            }),
        };
        await reload("a");
        expect(planningModeEnabled.get()).toBe(true);
        expect(hiderMode.get()).toEqual({ latitude: 51.92, longitude: 4.48 });
        expect(savePlanningModeToServer).not.toHaveBeenCalled();
        expect(saveHiderModeToServer).not.toHaveBeenCalled();

        await play(() => planningModeEnabled.set(false));
        await play(() => hiderMode.set(false));

        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", false);
        expect(saveHiderModeToServer).toHaveBeenCalledWith("a", false);
    });

    it("after switching sessions, saves the first change but not what loaded", async () => {
        server = {
            a: session("a", { planningModeEnabled: true }),
            b: session("b"),
            c: session("c", {
                hiderLat: 1,
                hiderLng: 2,
                planningModeEnabled: true,
            }),
        };
        await reload("a");

        // To b, whose modes are the defaults.
        await click((text) => text === "change");
        await click((text) => text.includes("Session b"));
        expect(activeSessionId.get()).toBe("b");
        expect(planningModeEnabled.get()).toBe(false);
        expect(savePlanningModeToServer).not.toHaveBeenCalled();
        expect(saveHiderModeToServer).not.toHaveBeenCalled();

        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("b", true);
        await play(() => hiderMode.set({ latitude: 3, longitude: 4 }));
        expect(saveHiderModeToServer).toHaveBeenCalledWith("b", {
            latitude: 3,
            longitude: 4,
        });

        // To c, whose modes are set: they aren't saved back.
        vi.mocked(savePlanningModeToServer).mockClear();
        vi.mocked(saveHiderModeToServer).mockClear();
        await click((text) => text === "change");
        await click((text) => text.includes("Session c"));
        expect(activeSessionId.get()).toBe("c");
        expect(hiderMode.get()).toEqual({ latitude: 1, longitude: 2 });
        expect(savePlanningModeToServer).not.toHaveBeenCalled();
        expect(saveHiderModeToServer).not.toHaveBeenCalled();

        await play(() => planningModeEnabled.set(false));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("c", false);
    });

    it("after re-selecting the same session, saves the first change", async () => {
        server = { a: session("a") };
        await reload("a");

        await click((text) => text === "change");
        await click((text) => text.includes("Session a"));
        expect(savePlanningModeToServer).not.toHaveBeenCalled();

        await play(() => planningModeEnabled.set(true));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", true);
    });

    it("doesn't save what the stream sets right after a load, but saves the player's next change", async () => {
        server = { a: session("a") };
        await reload("a");

        await serverSends("a", "planning.toggle", {
            planningModeEnabled: true,
        });
        await serverSends("a", "hider.update", { hiderLat: 5, hiderLng: 6 });
        expect(planningModeEnabled.get()).toBe(true);
        expect(hiderMode.get()).toEqual({ latitude: 5, longitude: 6 });
        expect(savePlanningModeToServer).not.toHaveBeenCalled();
        expect(saveHiderModeToServer).not.toHaveBeenCalled();

        await play(() => planningModeEnabled.set(false));
        expect(savePlanningModeToServer).toHaveBeenCalledWith("a", false);
        await play(() => hiderMode.set(false));
        expect(saveHiderModeToServer).toHaveBeenCalledWith("a", false);
    });
});
