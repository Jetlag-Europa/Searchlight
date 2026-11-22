import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
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
    addEventListener(..._args: unknown[]) {}
    removeEventListener(..._args: unknown[]) {}
    focus() {}
    blur() {}
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
    events = new EventTarget();
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
    addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
      this.events.addEventListener(...args);
    }
    removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
      this.events.removeEventListener(...args);
    }
    querySelector() {
      return null;
    }
  }

  const createStorage = () => {
    const data = new Map<string, string>();
    return {
      data,
      api: {
        getItem: vi.fn((k: string) => data.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => {
          data.set(k, String(v));
        }),
        removeItem: vi.fn((k: string) => {
          data.delete(k);
        }),
        clear: vi.fn(() => {
          data.clear();
        }),
        get length() {
          return data.size;
        },
        key: (i: number) => [...data.keys()][i] ?? null,
      },
    };
  };

  const document = new FakeDocument();
  const window = Object.assign(new EventTarget(), {
    document,
    HTMLIFrameElement: class {},
    location: {
      href: "http://localhost/local",
      origin: "http://localhost",
      pathname: "/local",
      search: "",
      hash: "",
    },
    history: {
      replaceState: vi.fn(),
    },
  });
  document.defaultView = window;

  const ls = createStorage();
  const ss = createStorage();

  Object.assign(globalThis, {
    window,
    document,
    localStorage: ls.api,
    sessionStorage: ss.api,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  return { document, window, ls, ss };
});

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("react-toastify", () => ({
  toast: toastMocks,
}));

const localStoreMocks = vi.hoisted(() => ({
  listLocalSessions: vi.fn(),
  listLocalGames: vi.fn(),
  isLocalStoragePersistent: vi.fn(),
  readLastLocalSessionId: vi.fn(),
  writeLastLocalSessionId: vi.fn(),
  clearLastLocalSessionId: vi.fn(),
  getLocalSession: vi.fn(),
  getLocalGameDefinition: vi.fn(),
  createLocalSession: vi.fn(),
  updateLocalSession: vi.fn(),
}));

vi.mock("@/lib/localStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/localStore")>()),
  listLocalSessions: localStoreMocks.listLocalSessions,
  listLocalGames: localStoreMocks.listLocalGames,
  isLocalStoragePersistent: localStoreMocks.isLocalStoragePersistent,
  readLastLocalSessionId: localStoreMocks.readLastLocalSessionId,
  writeLastLocalSessionId: localStoreMocks.writeLastLocalSessionId,
  clearLastLocalSessionId: localStoreMocks.clearLastLocalSessionId,
  getLocalSession: localStoreMocks.getLocalSession,
  getLocalGameDefinition: localStoreMocks.getLocalGameDefinition,
  createLocalSession: localStoreMocks.createLocalSession,
  updateLocalSession: localStoreMocks.updateLocalSession,
}));

vi.mock("@/lib/localTabLock", () => ({
  acquireLocalSessionLock: vi.fn(async () => {}),
  releaseLocalSessionLock: vi.fn(),
}));

vi.mock("@/lib/games", () => ({
  applyLocalGameDefinition: vi.fn(),
  clearLocalGame: vi.fn(),
}));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LocalSessionManager } from "@/components/LocalSessionManager";
import { activeSessionId, activeSessionRole } from "@/lib/activeSession";
import { activeLocalSession, boardMode } from "@/lib/boardMode";
import { disabledStations, hiderMode, planningModeEnabled, questions } from "@/lib/context";
import {
  type LocalGameMeta,
  type LocalSessionRecord,
  type LocalSessionSummary,
  LocalStorageFullError,
} from "@/lib/localStore";

const dummyDefinition = {
  id: "test-game",
  name: "Test Game",
  serverId: "local",
  map: {
    center: [10, 50],
    playArea: { type: "FeatureCollection", features: [] },
  },
  hidingZones: {
    radius: 400,
    unit: "meters",
    features: { type: "FeatureCollection", features: [] },
  },
} as unknown as GameDefinition;

const gameMeta: LocalGameMeta = {
  id: "game-1",
  gameKey: "test-game",
  name: "Test Game",
  size: "medium",
  zoneCount: 0,
  layerCount: 0,
  source: { kind: "file", label: "test.game.json" },
  addedAt: "2026-01-01T00:00:00.000Z",
};

const makeRecord = (id: string, name: string): LocalSessionRecord => ({
  id,
  name,
  gameId: "game-1",
  gameName: "Test Game",
  questions: [],
  strokes: [],
  disabledZones: [],
  hiderMode: false,
  planningMode: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeSummary = (id: string, name: string): LocalSessionSummary => ({
  id,
  name,
  gameId: "game-1",
  gameName: "Test Game",
  questionCount: 0,
  strokeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function getReactProps(node: unknown): Record<string, any> {
  if (!node || typeof node !== "object") return {};
  const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
  return key ? (node as Record<string, any>)[key] : {};
}

function findButtons() {
  return [...env.document.body.walk()].filter((n) => n.nodeName === "BUTTON");
}

function findForms() {
  return [...env.document.body.walk()].filter((n) => n.nodeName === "FORM");
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setImmediate(r));
    }
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let root: Root | null = null;
async function renderManager() {
  const container = env.document.createElement("div");
  env.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(createElement(LocalSessionManager));
  });
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  env.ls.data.clear();
  env.ss.data.clear();
  localStoreMocks.isLocalStoragePersistent.mockResolvedValue(true);
  localStoreMocks.listLocalGames.mockResolvedValue([gameMeta]);
  localStoreMocks.listLocalSessions.mockResolvedValue([
    makeSummary("session-a", "Session A"),
    makeSummary("session-b", "Session B"),
  ]);
  localStoreMocks.readLastLocalSessionId.mockReturnValue("session-a");
  localStoreMocks.getLocalGameDefinition.mockResolvedValue(dummyDefinition);
  localStoreMocks.getLocalSession.mockImplementation(async (id: string) => {
    if (id === "session-a") return makeRecord("session-a", "Session A");
    if (id === "session-b") return makeRecord("session-b", "Session B");
    return null;
  });
  localStoreMocks.updateLocalSession.mockImplementation(async (id: string) => makeRecord(id, id));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  env.document.body.textContent = "";
  boardMode.set("online");
  activeLocalSession.set(null);
  activeSessionId.set("");
  activeSessionRole.set(null);
  questions.set([]);
  disabledStations.set([]);
  hiderMode.set(false);
  planningModeEnabled.set(false);
  vi.restoreAllMocks();
});

describe("LocalSessionManager save flush and session switching", () => {
  it("blocks switching sessions when flushSave fails so unsaved edits are never dropped", async () => {
    await renderManager();
    expect(activeLocalSession.get()?.id).toBe("session-a");

    // Open picker while active session has no pending edits yet.
    const chipBtn = findButtons().find((b) => b.textContent.includes("Session A"));
    expect(chipBtn).toBeDefined();
    await act(async () => {
      getReactProps(chipBtn).onClick?.();
    });
    await settle();

    // Fail subsequent saves and create an unsaved edit on Session A.
    localStoreMocks.updateLocalSession.mockRejectedValue(new LocalStorageFullError());
    await act(async () => {
      planningModeEnabled.set(true);
    });

    // Attempt to switch to Session B.
    localStoreMocks.getLocalSession.mockClear();
    const sessionBBtn = findButtons().find((b) => b.textContent.includes("Session B"));
    expect(sessionBBtn).toBeDefined();
    await act(async () => {
      getReactProps(sessionBBtn).onClick?.();
    });
    await settle();

    expect(activeLocalSession.get()?.id).toBe("session-a");
    expect(localStoreMocks.getLocalSession).not.toHaveBeenCalledWith("session-b");
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Stayed here so your edits aren't lost"),
      expect.objectContaining({ toastId: "local-switch-blocked" }),
    );
  });

  it("waits for an already in-flight save before switching sessions", async () => {
    await renderManager();
    expect(activeLocalSession.get()?.id).toBe("session-a");

    // Open picker first.
    const chipBtn = findButtons().find((b) => b.textContent.includes("Session A"));
    await act(async () => {
      getReactProps(chipBtn).onClick?.();
    });
    await settle();

    // Hold the next updateLocalSession write in-flight.
    const inFlight = deferred<LocalSessionRecord | null>();
    localStoreMocks.updateLocalSession.mockImplementationOnce(() => inFlight.promise);

    await act(async () => {
      planningModeEnabled.set(true);
    });
    // Wait past the 200ms save debounce so updateLocalSession is in-flight.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(localStoreMocks.updateLocalSession).toHaveBeenCalledTimes(1);

    // Click Session B while the write for Session A is still in-flight.
    localStoreMocks.getLocalSession.mockClear();
    const sessionBBtn = findButtons().find((b) => b.textContent.includes("Session B"));
    await act(async () => {
      getReactProps(sessionBBtn).onClick?.();
    });
    await settle();

    // Must NOT switch before the in-flight write settles.
    expect(activeLocalSession.get()?.id).toBe("session-a");
    expect(localStoreMocks.getLocalSession).not.toHaveBeenCalledWith("session-b");

    // Once the in-flight write resolves, Session B opens.
    inFlight.resolve(makeRecord("session-a", "Session A"));
    await settle();

    expect(activeLocalSession.get()?.id).toBe("session-b");
  });

  it("aborts switching sessions if an already in-flight save rejects", async () => {
    await renderManager();
    expect(activeLocalSession.get()?.id).toBe("session-a");

    const chipBtn = findButtons().find((b) => b.textContent.includes("Session A"));
    await act(async () => {
      getReactProps(chipBtn).onClick?.();
    });
    await settle();

    const inFlight = deferred<LocalSessionRecord | null>();
    localStoreMocks.updateLocalSession.mockImplementationOnce(() => inFlight.promise);

    await act(async () => {
      planningModeEnabled.set(true);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(localStoreMocks.updateLocalSession).toHaveBeenCalledTimes(1);

    localStoreMocks.getLocalSession.mockClear();
    const sessionBBtn = findButtons().find((b) => b.textContent.includes("Session B"));
    await act(async () => {
      getReactProps(sessionBBtn).onClick?.();
    });
    await settle();

    // Reject the in-flight write: switch must be aborted.
    inFlight.reject(new Error("IndexedDB transaction failed"));
    await settle();

    expect(activeLocalSession.get()?.id).toBe("session-a");
    expect(localStoreMocks.getLocalSession).not.toHaveBeenCalledWith("session-b");
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("Stayed here so your edits aren't lost"),
      expect.objectContaining({ toastId: "local-switch-blocked" }),
    );
  });

  it("refuses to open a session that disappeared from storage instead of using a stale record", async () => {
    localStoreMocks.readLastLocalSessionId.mockReturnValue("");
    localStoreMocks.listLocalSessions.mockResolvedValue([]);
    const created = makeRecord("session-ghost", "Ghost");
    localStoreMocks.createLocalSession.mockResolvedValue(created);
    // Simulate concurrent deletion right before openSessionRecord reads it.
    localStoreMocks.getLocalSession.mockResolvedValue(null);

    await renderManager();

    const newSessionBtn = findButtons().find((b) => b.textContent.includes("New session"));
    expect(newSessionBtn).toBeDefined();
    await act(async () => {
      getReactProps(newSessionBtn).onClick?.();
    });
    await settle();

    const startForm = findForms().find((f) => f.textContent.includes("Start"));
    expect(startForm).toBeDefined();
    await act(async () => {
      getReactProps(startForm).onSubmit?.({ preventDefault() {} });
    });
    await settle();

    expect(activeLocalSession.get()).toBeNull();
    expect(toastMocks.error).toHaveBeenCalledWith("That local session no longer exists.");
  });

  it("refreshes the catalog when createLocalSession fails in handleStartFromSavedGame", async () => {
    localStoreMocks.readLastLocalSessionId.mockReturnValue("");
    localStoreMocks.listLocalSessions.mockResolvedValue([]);
    localStoreMocks.createLocalSession.mockRejectedValue(
      new Error("This saved game was removed from browser storage."),
    );

    await renderManager();
    localStoreMocks.listLocalGames.mockClear();
    localStoreMocks.listLocalGames.mockResolvedValue([]);

    const newSessionBtn = findButtons().find((b) => b.textContent.includes("New session"));
    await act(async () => {
      getReactProps(newSessionBtn).onClick?.();
    });
    await settle();

    const startForm = findForms().find((f) => f.textContent.includes("Start"));
    await act(async () => {
      getReactProps(startForm).onSubmit?.({ preventDefault() {} });
    });
    await settle();

    expect(localStoreMocks.listLocalGames).toHaveBeenCalledTimes(1);
    expect(env.document.body.textContent).toContain(
      "This saved game was removed from browser storage.",
    );
  });
});
