import { readFileSync } from "node:fs";

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
      href: "http://localhost/map",
      origin: "http://localhost",
      pathname: "/map",
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

const localStoreMocks = vi.hoisted(() => ({
  countLocalSessions: vi.fn(),
  listLocalSessions: vi.fn(),
  listLocalGames: vi.fn(),
  isLocalStoragePersistent: vi.fn(),
  readLastLocalSessionId: vi.fn(),
}));

vi.mock("@/lib/localStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/localStore")>()),
  countLocalSessions: localStoreMocks.countLocalSessions,
  listLocalSessions: localStoreMocks.listLocalSessions,
  listLocalGames: localStoreMocks.listLocalGames,
  isLocalStoragePersistent: localStoreMocks.isLocalStoragePersistent,
  readLastLocalSessionId: localStoreMocks.readLastLocalSessionId,
}));

const authCheckMocks = vi.hoisted(() => ({
  watchAuth: vi.fn(),
}));

vi.mock("@/lib/authCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authCheck")>()),
  watchAuth: authCheckMocks.watchAuth,
}));

vi.mock("@/lib/localTabLock", () => ({
  acquireLocalSessionLock: vi.fn(async () => {}),
  releaseLocalSessionLock: vi.fn(),
}));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuthGuard } from "@/components/AuthGuard";
import { LocalSessionManager } from "@/components/LocalSessionManager";
import { OfflinePickerNotice, SessionPickerOverlay } from "@/components/SessionManager";
import {
  activeSessionId,
  activeSessionRole,
  offlineUserId,
  STORED_USER_KEY,
} from "@/lib/activeSession";
import { activeLocalSession, boardMode } from "@/lib/boardMode";

const settle = () =>
  act(async () => {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setImmediate(r));
    }
  });

let root: Root | null = null;
async function render(el: ReactElement) {
  const container = env.document.createElement("div");
  env.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => {
    root!.render(el);
  });
  await settle();
}

function anchors() {
  return [...env.document.body.walk()].filter((n) => n.nodeName === "A");
}

function hasNestedButton(node: typeof env.document.body): boolean {
  return [...node.walk()].some((n) => n.nodeName === "BUTTON");
}

function hasButtonAncestor(node: typeof env.document.body): boolean {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.nodeName === "BUTTON") return true;
  }
  return false;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  env.ls.data.clear();
  env.ss.data.clear();
  env.window.location.pathname = "/map";
  env.window.location.search = "";
  localStoreMocks.countLocalSessions.mockResolvedValue(0);
  localStoreMocks.listLocalSessions.mockResolvedValue([]);
  localStoreMocks.listLocalGames.mockResolvedValue([]);
  localStoreMocks.isLocalStoragePersistent.mockResolvedValue(true);
  localStoreMocks.readLastLocalSessionId.mockReturnValue("");
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ servers: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  env.document.body.textContent = "";
  boardMode.set("online");
  activeLocalSession.set(null);
  activeSessionRole.set(null);
});

describe("online-to-local navigation", () => {
  it("SessionPickerOverlay links to /local and shows the saved local session count", async () => {
    localStoreMocks.countLocalSessions.mockResolvedValue(2);

    await render(
      createElement(SessionPickerOverlay, {
        onSessionSelected: vi.fn(),
      }),
    );

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent).toContain("Local sessions (2)");
    expect(hasNestedButton(localLink!)).toBe(false);
    expect(hasButtonAncestor(localLink!)).toBe(false);
  });

  it("SessionPickerOverlay shows 'Open local play' when there are no local sessions", async () => {
    localStoreMocks.countLocalSessions.mockResolvedValue(0);

    await render(
      createElement(SessionPickerOverlay, {
        onSessionSelected: vi.fn(),
      }),
    );

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent).toContain("Open local play");
  });

  it("SessionPickerOverlay still renders cleanly when countLocalSessions rejects", async () => {
    localStoreMocks.countLocalSessions.mockRejectedValue(new Error("IndexedDB blocked"));

    await render(
      createElement(SessionPickerOverlay, {
        onSessionSelected: vi.fn(),
      }),
    );

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent).toContain("Open local play");
    expect(env.document.body.textContent).toContain("Select a Session");
  });

  it("OfflinePickerNotice renders Back to board alongside a /local link with count", async () => {
    localStoreMocks.countLocalSessions.mockResolvedValue(3);

    await render(
      createElement(OfflinePickerNotice, {
        onClose: vi.fn(),
      }),
    );

    const buttons = [...env.document.body.walk()].filter((n) => n.nodeName === "BUTTON");
    expect(buttons.some((b) => b.textContent.trim() === "Back to board")).toBe(true);

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent).toContain("Local sessions (3)");
    expect(hasNestedButton(localLink!)).toBe(false);
    expect(hasButtonAncestor(localLink!)).toBe(false);
  });

  it("OfflinePickerNotice falls back to 'Play locally' when countLocalSessions rejects", async () => {
    localStoreMocks.countLocalSessions.mockRejectedValue(new Error("IndexedDB error"));

    await render(
      createElement(OfflinePickerNotice, {
        onClose: vi.fn(),
      }),
    );

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent).toContain("Play locally");
  });
});

describe("local-to-online navigation", () => {
  it("LocalSessionManager shows 'Sign in' linking to / when STORED_USER_KEY is absent, without writing localStorage", async () => {
    env.window.location.pathname = "/local";
    env.ls.api.setItem.mockClear();
    env.ls.api.removeItem.mockClear();
    env.ls.api.clear.mockClear();

    await render(createElement(LocalSessionManager));

    const dialog = [...env.document.body.walk()].find((n) => n.getAttribute("role") === "dialog");
    expect(dialog).toBeDefined();
    const headerLinks = [...dialog!.walk()].filter((n) => n.nodeName === "A");
    const signInLink = headerLinks.find((a) => a.textContent.trim() === "Sign in");
    expect(signInLink).toBeDefined();
    expect(signInLink!.getAttribute("href")).toBe("/");
    expect(hasNestedButton(signInLink!)).toBe(false);
    expect(hasButtonAncestor(signInLink!)).toBe(false);

    const allSignInLinks = anchors().filter((a) => a.textContent.trim() === "Sign in");
    expect(allSignInLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of allSignInLinks) {
      expect(link.getAttribute("href")).toBe("/");
    }

    expect(env.ls.api.setItem).not.toHaveBeenCalled();
    expect(env.ls.api.removeItem).not.toHaveBeenCalled();
    expect(env.ls.api.clear).not.toHaveBeenCalled();
  });

  it("LocalSessionManager shows 'Online sessions' linking to /map when STORED_USER_KEY is set, without modifying localStorage", async () => {
    env.window.location.pathname = "/local";
    env.ls.data.set(STORED_USER_KEY, "user-123");
    env.ls.api.setItem.mockClear();
    env.ls.api.removeItem.mockClear();
    env.ls.api.clear.mockClear();

    await render(createElement(LocalSessionManager));

    const dialog = [...env.document.body.walk()].find((n) => n.getAttribute("role") === "dialog");
    expect(dialog).toBeDefined();
    const headerLinks = [...dialog!.walk()].filter((n) => n.nodeName === "A");
    const onlineLink = headerLinks.find((a) => a.textContent.trim() === "Online sessions");
    expect(onlineLink).toBeDefined();
    expect(onlineLink!.getAttribute("href")).toBe("/map");
    expect(hasNestedButton(onlineLink!)).toBe(false);
    expect(hasButtonAncestor(onlineLink!)).toBe(false);

    const allOnlineLinks = anchors().filter((a) => a.textContent.trim() === "Online sessions");
    expect(allOnlineLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of allOnlineLinks) {
      expect(link.getAttribute("href")).toBe("/map");
    }

    expect(env.ls.api.setItem).not.toHaveBeenCalled();
    expect(env.ls.api.removeItem).not.toHaveBeenCalled();
    expect(env.ls.api.clear).not.toHaveBeenCalled();
    expect(env.ls.data.get(STORED_USER_KEY)).toBe("user-123");
  });
});

describe("LocalSessionManager game links", () => {
  it("resumes the latest local session of the same game instead of starting an empty one", async () => {
    const actual = await vi.importActual<typeof import("@/lib/localStore")>("@/lib/localStore");
    actual._resetLocalStoreForTests();
    localStoreMocks.listLocalSessions.mockImplementation(actual.listLocalSessions);
    const def = JSON.parse(
      readFileSync(
        new URL("./fixtures/games/south-limburg-2026.game.json", import.meta.url),
        "utf8",
      ),
    );
    const game = await actual.saveLocalGame(def, { kind: "game-link", label: def.name });
    const earlier = await actual.createLocalSession(game, "Earlier run");
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/game-links/tok/definition")
        ? new Response(JSON.stringify(def), { status: 200 })
        : new Response(JSON.stringify({ servers: [] }), { status: 200 }),
    );
    env.window.location.pathname = "/local";
    env.window.location.search = "?link=tok";

    await render(createElement(LocalSessionManager));

    expect(activeLocalSession.get()?.id).toBe(earlier.id);
    expect(await actual.listLocalSessions()).toHaveLength(1);
  });
});

describe("AuthGuard offline /local escape hatch", () => {
  it("renders a /local 'Local play' link pill below the unreachable status chip when there are 0 local sessions", async () => {
    localStoreMocks.countLocalSessions.mockResolvedValue(0);
    authCheckMocks.watchAuth.mockImplementation((_url, callbacks) => {
      callbacks.unreachable();
      return () => {};
    });

    await render(createElement(AuthGuard));

    expect(env.document.body.textContent).toContain("Can't reach the server, retrying…");
    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent.trim()).toBe("Local play");
    expect(hasNestedButton(localLink!)).toBe(false);
    expect(hasButtonAncestor(localLink!)).toBe(false);
  });

  it("renders 'Local sessions (N)' when saved local sessions exist in the unreachable state", async () => {
    localStoreMocks.countLocalSessions.mockResolvedValue(2);
    authCheckMocks.watchAuth.mockImplementation((_url, callbacks) => {
      callbacks.unreachable();
      return () => {};
    });

    await render(createElement(AuthGuard));

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent.trim()).toBe("Local sessions (2)");
  });

  it("hides the /local link while the stored account plays its /map session offline", async () => {
    offlineUserId.set("user-123");
    activeSessionId.set("session-1");
    authCheckMocks.watchAuth.mockImplementation((_url, callbacks) => {
      callbacks.unreachable();
      return () => {};
    });

    try {
      await render(createElement(AuthGuard));

      expect(env.document.body.textContent).toContain("Can't reach the server, retrying…");
      expect(anchors().find((a) => a.getAttribute("href") === "/local")).toBeUndefined();
    } finally {
      offlineUserId.set(null);
      activeSessionId.set("");
    }
  });

  it("falls back to 'Local play' when countLocalSessions rejects in the unreachable state", async () => {
    localStoreMocks.countLocalSessions.mockRejectedValue(new Error("IndexedDB unavailable"));
    authCheckMocks.watchAuth.mockImplementation((_url, callbacks) => {
      callbacks.unreachable();
      return () => {};
    });

    await render(createElement(AuthGuard));

    const localLink = anchors().find((a) => a.getAttribute("href") === "/local");
    expect(localLink).toBeDefined();
    expect(localLink!.textContent.trim()).toBe("Local play");
  });
});
