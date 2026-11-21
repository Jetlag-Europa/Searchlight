import {
  CASUAL_SERVER_ID,
  type Game,
  type GameDefinition,
  type ServerWithPermissions,
} from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  class Node {
    parentNode: Node | null = null;
    childNodes: Node[] = [];
    attrs = new Map<string, string>();
    style = {};
    nodeValue: string | null = null;
    value = "";
    constructor(
      public nodeType: number,
      public nodeName: string,
      public ownerDocument: Node | null,
    ) {}
    get tagName() {
      return this.nodeName;
    }
    get options() {
      return this.childNodes.filter((n) => n.nodeName === "OPTION");
    }
    get disabled() {
      return this.attrs.has("disabled");
    }
    get textContent(): string {
      return this.nodeType === 3
        ? (this.nodeValue ?? "")
        : this.childNodes.map((n) => n.textContent).join("");
    }
    set textContent(v: string) {
      this.childNodes.forEach((c) => {
        c.parentNode = null;
      });
      this.childNodes = [];
      if (v)
        this.appendChild(Object.assign(new Node(3, "#text", this.ownerDocument), { nodeValue: v }));
    }
    appendChild(c: Node) {
      return this.insertBefore(c, null);
    }
    insertBefore(c: Node, before: Node | null) {
      c.parentNode?.removeChild(c);
      const i = before ? this.childNodes.indexOf(before) : this.childNodes.length;
      this.childNodes.splice(i, 0, c);
      c.parentNode = this;
      return c;
    }
    removeChild(c: Node) {
      this.childNodes = this.childNodes.filter((n) => n !== c);
      c.parentNode = null;
      return c;
    }
    setAttribute(k: string, v: unknown) {
      this.attrs.set(k, String(v));
    }
    removeAttribute(k: string) {
      this.attrs.delete(k);
    }
    addEventListener() {}
    removeEventListener() {}
    *walk(): Generator<Node> {
      for (const c of this.childNodes) {
        yield c;
        yield* c.walk();
      }
    }
  }
  const document = Object.assign(new Node(9, "#document", null), {
    body: null as unknown as Node,
    defaultView: null as unknown,
    createElement: (tag: string) => new Node(1, tag.toUpperCase(), document),
    createTextNode: (t: string) => Object.assign(new Node(3, "#text", document), { nodeValue: t }),
  });
  document.body = document.createElement("body");
  const window = { document, location: { search: "" }, HTMLIFrameElement: class {} };
  document.defaultView = window;
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  return { document };
});

vi.mock("@/components/GameLinksDialog", () => ({ GameLinksDialog: () => null }));
vi.mock("@/components/GameSettingsDialog", () => ({ GameSettingsDialog: () => null }));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GameManager } from "@/components/GameManager";
import { ImportPanel } from "@/components/ImportPanel";
import { verifiedUserId } from "@/lib/activeSession";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const srv: ServerWithPermissions = {
  id: "srv-1",
  name: "JetLag Server",
  iconUrl: null,
  isMember: true,
  permissions: ["games.create"],
};
const game = {
  id: "g1",
  gameKey: "stockholm",
  name: "Stockholm",
  serverId: "srv-1",
  unlisted: false,
  createdById: "u1",
  currentRevisionId: "r1",
} as Game;
const def = {
  schemaVersion: 2,
  id: "stockholm",
  name: "Stockholm",
  serverId: "srv-1",
} as unknown as GameDefinition;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 15; i++) await new Promise((r) => setImmediate(r));
  });
let root: Root | null = null;
const render = async (el: ReactElement) => {
  const container = env.document.createElement("div");
  env.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(el));
  await settle();
};
const pageText = () => env.document.body.textContent;
const findButton = (label: string) =>
  [...env.document.body.walk()].find(
    (n) => n.nodeName === "BUTTON" && n.textContent.trim() === label,
  );
const clickButton = async (label: string) => {
  const btn = findButton(label);
  if (!btn || btn.disabled) throw new Error(`Button "${label}" unavailable`);
  const props = (btn as unknown as Record<string, { onClick?: () => void }>)[
    Object.keys(btn).find((k) => k.startsWith("__reactProps$"))!
  ];
  await act(async () => props.onClick?.());
  await settle();
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  env.document.body.textContent = "";
  verifiedUserId.set(null);
  vi.unstubAllGlobals();
});

describe("games and import load errors", () => {
  it.each([
    ["non-OK", () => Promise.resolve(json({}, 503)), "Couldn't load games (503)"],
    [
      "network",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Couldn't load games (network error)",
    ],
  ])(
    "GameManager shows error + Retry on /games %s error instead of 'No games yet.' and recovers",
    async (_, fail, expected) => {
      verifiedUserId.set("u1");
      let calls = 0;
      fetchMock.mockImplementation(async (u: string | URL) => {
        const { pathname } = new URL(String(u));
        return pathname === "/servers"
          ? json({ servers: [srv] })
          : ++calls === 1
            ? fail()
            : json({ games: [game] });
      });
      await render(createElement(GameManager));
      expect(pageText()).toContain(expected);
      expect(pageText()).not.toContain("No games yet.");
      await clickButton("Retry");
      expect(calls).toBe(2);
      expect(pageText()).toContain("Stockholm");
    },
  );

  it("Casual creator without games.create still sees Casual section on /games error and recovers on Retry", async () => {
    verifiedUserId.set("u1");
    const casual: ServerWithPermissions = {
      ...srv,
      id: CASUAL_SERVER_ID,
      name: "Casual Games",
      permissions: [],
    };
    let calls = 0;
    fetchMock.mockImplementation(async (u: string | URL) => {
      const { pathname } = new URL(String(u));
      return pathname === "/servers"
        ? json({ servers: [casual] })
        : ++calls === 1
          ? json({}, 500)
          : json({ games: [{ ...game, serverId: CASUAL_SERVER_ID, name: "My Casual" }] });
    });
    await render(createElement(GameManager));
    expect(pageText()).toContain("Casual Games");
    expect(pageText()).toContain("Couldn't load games (500)");
    expect(pageText()).not.toContain("You don’t have game management permissions");
    await clickButton("Retry");
    expect(pageText()).toContain("My Casual");
  });

  it.each([
    ["non-OK", () => Promise.resolve(json({}, 503)), "Couldn't load your servers (503)"],
    [
      "network",
      () => Promise.reject(new TypeError("Failed to fetch")),
      "Couldn't load your servers",
    ],
  ])(
    "ImportPanel shows error + Retry on /servers %s error instead of permission denial and recovers",
    async (_, fail, expected) => {
      verifiedUserId.set("u1");
      let serverCalls = 0,
        dryRunCalls = 0;
      fetchMock.mockImplementation(async (u: string | URL) => {
        const { pathname } = new URL(String(u));
        if (pathname === "/servers") return ++serverCalls === 1 ? fail() : json({ servers: [srv] });
        return ++dryRunCalls === 1
          ? json({ message: "Unavailable" }, 503)
          : json({ status: "created", gameId: "g1", gameKey: "stockholm", revision: 1 });
      });
      await render(
        createElement(ImportPanel, {
          definition: def,
          noServer: false,
          busy: false,
          blocked: null,
          replaceGameId: null,
        }),
      );
      expect(pageText()).toContain(expected);
      expect(pageText()).not.toContain("You can't import games to any server.");
      await clickButton("Retry");
      expect([serverCalls, dryRunCalls]).toEqual([2, 2]);
      expect(pageText()).toContain("JetLag Server (srv-1)");
      expect(pageText()).toContain("New game");
    },
  );

  it.each([
    [
      null,
      "/games/import",
      "Import game",
      { status: "created", gameId: "g1", gameKey: "stockholm", revision: 1 },
    ],
    [
      "g1",
      "/games/g1/import",
      "Replace game",
      {
        status: "updated",
        gameId: "g1",
        gameKey: "stockholm",
        revision: 2,
        existing: {
          name: "Stockholm",
          revision: 1,
          currentRevisionId: "r1",
          likelyMistake: false,
          differences: [],
          createdByYou: true,
        },
      },
    ],
  ])(
    "ImportPanel waits for verifiedUserId before firing dry-run (replaceGameId=%s)",
    async (replaceGameId, dryRunPath, submitLabel, dryRunBody) => {
      fetchMock.mockImplementation(async (u: string | URL) =>
        json(new URL(String(u)).pathname === "/servers" ? { servers: [srv] } : dryRunBody),
      );
      await render(
        createElement(ImportPanel, {
          definition: def,
          noServer: false,
          busy: false,
          blocked: null,
          replaceGameId,
        }),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(findButton(submitLabel)?.disabled).toBe(true);
      expect(findButton("Check again")).toBeUndefined();
      await act(async () => {
        verifiedUserId.set("u1");
      });
      await settle();
      expect(fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname)).toContain(dryRunPath);
      expect(findButton(submitLabel)?.disabled).toBe(false);
    },
  );
});
