import {
  type AuditLogEntry,
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
    focus() {
      focused.node = this;
    }
    *walk(): Generator<Node> {
      for (const c of this.childNodes) {
        yield c;
        yield* c.walk();
      }
    }
  }
  const focused = { node: null as Node | null };
  const document = Object.assign(new Node(9, "#document", null), {
    body: null as unknown as Node,
    defaultView: null as unknown,
    createElement: (tag: string) => new Node(1, tag.toUpperCase(), document),
    createElementNS: (_ns: string, tag: string) => new Node(1, tag, document),
    createTextNode: (t: string) => Object.assign(new Node(3, "#text", document), { nodeValue: t }),
  });
  document.body = document.createElement("body");
  const window = { document, location: { search: "" }, HTMLIFrameElement: class {} };
  document.defaultView = window;
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  return { document, focused };
});

vi.mock("@/components/GameLinksDialog", () => ({ GameLinksDialog: () => null }));
vi.mock("@/components/GameSettingsDialog", () => ({ GameSettingsDialog: () => null }));
vi.mock("@/components/GameHistoryDialog", async () => {
  const { createElement } = await import("react");
  return {
    GameHistoryDialog: ({ game }: { game: Game }) =>
      createElement("button", null, `History of ${game.name}`),
  };
});
const saveCreatorOpenHandoffMock = vi.fn();
vi.mock("@/lib/creator/handoff", () => ({
  saveCreatorOpenHandoff: (...args: unknown[]) => saveCreatorOpenHandoffMock(...args),
}));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AuditLogPanel } from "@/components/AuditLogPanel";
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
  createdByName: "Alice",
  updatedAt: "2026-11-20T10:00:00.000Z",
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
  saveCreatorOpenHandoffMock.mockReset();
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
        ++dryRunCalls;
        return json({ status: "created", gameId: "g1", gameKey: "stockholm", revision: 1 });
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
      // No preview until the import has a server to go to.
      expect(dryRunCalls).toBe(0);
      await clickButton("Retry");
      expect([serverCalls, dryRunCalls]).toEqual([2, 1]);
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

  it("shows 'Edit in Creator' with replaceGameId for editors and 'Open in Creator' copy-only for non-editors", async () => {
    verifiedUserId.set("u1");
    saveCreatorOpenHandoffMock.mockResolvedValue("open-123");

    const editorServer: ServerWithPermissions = {
      ...srv,
      id: "srv-edit",
      name: "Editor Server",
      permissions: ["games.edit"],
    };
    const viewerServer: ServerWithPermissions = {
      ...srv,
      id: "srv-create",
      name: "Create-Only Server",
      permissions: ["games.create"],
    };

    // 1. Editor sees "Edit in Creator" and passes mode: "edit" + replaceGameId.
    fetchMock.mockImplementation(async (u: string | URL) => {
      const { pathname } = new URL(String(u));
      if (pathname === "/servers") return json({ servers: [editorServer] });
      if (pathname === "/games/g1/export") return json(def);
      return json({ games: [{ ...game, serverId: "srv-edit" }] });
    });
    await render(createElement(GameManager));
    expect(findButton("Edit in Creator")).toBeDefined();
    expect(findButton("Open in Creator")).toBeUndefined();
    await clickButton("Edit in Creator");
    expect(saveCreatorOpenHandoffMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "edit",
        replaceGameId: "g1",
        sourceGameName: "Stockholm",
      }),
    );

    // 2. Non-editor (games.create only on shared server) sees "Open in Creator" and NEVER gets replaceGameId.
    await act(async () => root?.unmount());
    root = null;
    env.document.body.textContent = "";
    saveCreatorOpenHandoffMock.mockClear();
    fetchMock.mockImplementation(async (u: string | URL) => {
      const { pathname } = new URL(String(u));
      if (pathname === "/servers") return json({ servers: [viewerServer] });
      if (pathname === "/games/g1/export") return json(def);
      return json({ games: [{ ...game, serverId: "srv-create" }] });
    });
    await render(createElement(GameManager));
    expect(findButton("Open in Creator")).toBeDefined();
    expect(findButton("Edit in Creator")).toBeUndefined();
    await clickButton("Open in Creator");
    expect(saveCreatorOpenHandoffMock).toHaveBeenCalledWith({
      mode: "copy",
      definition: def,
      sourceGameName: "Stockholm",
    });
    expect(saveCreatorOpenHandoffMock.mock.calls[0][0].replaceGameId).toBeUndefined();
  });
});

const nodes = (name: string) => [...env.document.body.walk()].filter((n) => n.nodeName === name);
const fire = async (node: unknown, handler: string, event: unknown = {}) => {
  const props = Object.entries(node as object).find(([k]) => k.startsWith("__reactProps$"))![1];
  await act(async () => (props as Record<string, (e: unknown) => void>)[handler](event));
  await settle();
};
const rowNames = () => nodes("H3").map((h) => h.childNodes[0].textContent);
const isOpen = (details: { attrs: Map<string, string> }) => details.attrs.has("open");
const casualSrv: ServerWithPermissions = {
  ...srv,
  id: CASUAL_SERVER_ID,
  name: "Casual Games",
  permissions: ["games.create"],
};
// Game 00 … Game NN, uploaded a day apart (Game NN last), alternately by Carla
// (u3) and Bob (u2).
const manyGames = (n: number): Game[] =>
  Array.from({ length: n }, (_, i) => ({
    ...game,
    id: `g${i}`,
    gameKey: `key-${i}`,
    name: `Game ${String(i).padStart(2, "0")}`,
    createdById: i % 2 ? "u2" : "u3",
    createdByName: i % 2 ? "Bob" : "Carla",
    updatedAt: new Date(Date.UTC(2026, 10, 1 + i)).toISOString(),
  }));
const serve = (servers: ServerWithPermissions[], games: Record<string, Game[]>) =>
  fetchMock.mockImplementation(async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u));
    if (url.pathname === "/servers") return json({ servers });
    if (url.pathname === "/games") return json({ games: games[url.searchParams.get("serverId")!] });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 404);
  });

describe("/games rows", () => {
  beforeEach(() => verifiedUserId.set("u1"));

  it("keeps short sections open and in name order, without search", async () => {
    serve([srv], {
      "srv-1": [
        game,
        {
          ...game,
          id: "g2",
          name: "Zurich",
          createdById: "u2",
          createdByName: null,
          currentRevisionId: null,
          updatedAt: null,
        },
      ],
    });
    await render(createElement(GameManager));
    expect(pageText()).toContain("JetLag Server · 2 games");
    expect(nodes("INPUT")).toHaveLength(0);
    expect(nodes("DETAILS").every(isOpen)).toBe(true);
    expect(rowNames()).toEqual(["Stockholm", "Zurich"]);
    const [own, unknown] = nodes("SUMMARY");
    expect(own.textContent).toMatch(/^Stockholmadded by you · updated /);
    // No uploader on record and no revision: no meta line.
    expect(unknown.textContent).toBe("Zurich");
    expect(findButton("History of Stockholm")).toBeDefined();
  });

  it("collapses long sections, newest first, 20 at a time", async () => {
    serve([srv], { "srv-1": manyGames(25) });
    await render(createElement(GameManager));
    expect(pageText()).toContain("JetLag Server · 25 games");
    expect(nodes("INPUT")[0].attrs.get("aria-label")).toBe("Search JetLag Server");
    expect(nodes("DETAILS").some(isOpen)).toBe(false);
    expect(rowNames().slice(0, 3)).toEqual(["Game 24", "Game 23", "Game 22"]);
    expect(rowNames()).toHaveLength(20);
    await clickButton("Show 5 more (5 left)");
    expect(rowNames()).toHaveLength(25);
    // On the first row it revealed, which Tab from the button would skip.
    expect(env.focused.node).toBe(nodes("SUMMARY")[20]);
    expect(pageText()).not.toContain("Show");
  });

  it("searches by game name, id and uploader name or id", async () => {
    serve([srv], { "srv-1": manyGames(25) });
    await render(createElement(GameManager));
    const search = (value: string) => fire(nodes("INPUT")[0], "onChange", { target: { value } });
    await search("carla");
    expect(rowNames()).toHaveLength(13);
    await search("KEY-7");
    expect(rowNames()).toEqual(["Game 07"]);
    await search("u2");
    expect(rowNames()).toHaveLength(12);
    await search("game 1");
    expect(rowNames()).toEqual([...Array(10)].map((_, i) => `Game ${19 - i}`));
    await search("zzz");
    expect(rowNames()).toHaveLength(0);
    expect(pageText()).toContain("No games match “zzz”.");
  });

  it("keeps a row the player opened open when another one is deleted, and moves focus on", async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    serve([{ ...srv, permissions: ["games.create", "games.delete"] }], {
      "srv-1": manyGames(12),
    });
    await render(createElement(GameManager));
    await fire(nodes("DETAILS")[0], "onToggle", { currentTarget: { open: true } });
    expect(isOpen(nodes("DETAILS")[0])).toBe(true);

    const second = nodes("DETAILS")[1];
    const deleteButton = [...second.walk()].find(
      (n) => n.nodeName === "BUTTON" && n.textContent === "Delete",
    );
    await fire(deleteButton, "onClick");
    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "Sessions already started keep working until their creators delete them.",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/games/g10"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(pageText()).toContain("JetLag Server · 11 games");
    expect(rowNames().slice(0, 2)).toEqual(["Game 11", "Game 09"]);
    expect(isOpen(nodes("DETAILS")[0])).toBe(true);
    expect(env.focused.node).toBe(nodes("SUMMARY")[1]);
  });

  it("lets a creator who left every server delete their Casual games, down to the empty page", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const own = { ...game, serverId: CASUAL_SERVER_ID, unlisted: true, name: "My Casual" };
    serve([{ ...casualSrv, permissions: [] }], { [CASUAL_SERVER_ID]: [own] });
    await render(createElement(GameManager));
    expect(pageText()).toContain("You have 1 of 20 Casual games.");
    expect(pageText()).not.toContain("Unlisted");
    expect(findButton("History of My Casual")).toBeDefined();
    expect(findButton("Edit in Creator")).toBeUndefined();
    await clickButton("Delete");
    expect(pageText()).toContain(
      "To upload Casual games, join one of the JetLag Discord servers that use Searchlight.",
    );
    expect(env.focused.node?.textContent).toMatch(/^To upload Casual games/);
  });

  it("moves focus to the page heading when a creator's Casual section goes", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const own = { ...game, id: "g9", serverId: CASUAL_SERVER_ID, name: "My Casual" };
    serve([srv, { ...casualSrv, permissions: [] }], {
      "srv-1": [game],
      [CASUAL_SERVER_ID]: [own],
    });
    await render(createElement(GameManager));
    await clickButton("Delete");
    expect(pageText()).not.toContain("My Casual");
    expect(env.focused.node?.textContent).toBe("Games & Maps");
  });

  it("lets a creator who left every server ask Discord again", async () => {
    const own = { ...game, serverId: CASUAL_SERVER_ID, name: "My Casual" };
    serve([{ ...casualSrv, permissions: [] }], { [CASUAL_SERVER_ID]: [own] });
    await render(createElement(GameManager));
    expect(pageText()).toContain(
      "Join one of the JetLag Discord servers to upload or change them.",
    );
    serve([casualSrv], { [CASUAL_SERVER_ID]: [own] });
    await clickButton("Check again");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContainEqual(
      expect.stringContaining("/servers?recheck=true"),
    );
    expect(pageText()).toContain("You have 1 of 20 Casual games.");
    expect(pageText()).not.toContain("Join one of");
  });

  it("goes straight to the empty page for someone with only Casual sessions", async () => {
    serve([{ ...casualSrv, permissions: [], hasSessions: true, hasOwnGames: false }], {});
    await render(createElement(GameManager));
    expect(pageText()).toContain("join one of the JetLag Discord servers");
    expect(fetchMock.mock.calls.map(([u]) => new URL(String(u)).pathname)).toEqual(["/servers"]);
  });

  it("offers no Delete or History on someone else's Casual game without games.delete", async () => {
    const other = { ...game, serverId: CASUAL_SERVER_ID, name: "Not Mine", createdById: "u2" };
    serve([casualSrv], { [CASUAL_SERVER_ID]: [other] });
    await render(createElement(GameManager));
    expect(findButton("Delete")).toBeUndefined();
    expect(findButton("History of Not Mine")).toBeUndefined();
  });

  it("shows no game quota to global admins", async () => {
    serve([{ ...casualSrv, permissions: ["games.create", "games.delete", "server.admin"] }], {
      [CASUAL_SERVER_ID]: [{ ...game, serverId: CASUAL_SERVER_ID, createdById: "u2" }],
    });
    await render(createElement(GameManager));
    expect(pageText()).toContain("Casual Games · 1 game");
    expect(pageText()).not.toContain("You have");
    expect(findButton("Delete")).toBeDefined();
  });

  it.each([
    [[srv, casualSrv], true],
    [[casualSrv], false],
  ])("links down to Casual games only below other sections (%#)", async (servers, shown) => {
    serve(servers, { "srv-1": [game], [CASUAL_SERVER_ID]: [] });
    await render(createElement(GameManager));
    const jump = nodes("A").find((a) => a.textContent === "Jump to Casual games");
    expect(jump?.attrs.get("href")).toBe(shown ? "#casual-games" : undefined);
  });

  it("asks Discord again from the empty page", async () => {
    serve([], {});
    await render(createElement(GameManager));
    expect(pageText()).toContain("join one of the JetLag Discord servers");
    // Focus doesn't drop to the page while it checks.
    await clickButton("Check again");
    expect(env.focused.node?.textContent).toMatch(/^To upload Casual games/);
    serve([casualSrv], { [CASUAL_SERVER_ID]: [] });
    await clickButton("Check again");
    expect(String(fetchMock.mock.calls.at(-2)?.[0])).toContain("/servers?recheck=true");
    expect(pageText()).toContain("Casual Games · 0 games");
    expect(env.focused.node?.textContent).toBe("Games & Maps");
  });

  it("ImportPanel asks Discord again when there is no server to import to", async () => {
    serve([], {});
    await render(
      createElement(ImportPanel, {
        definition: def,
        noServer: true,
        busy: false,
        blocked: null,
        replaceGameId: null,
      }),
    );
    expect(pageText()).toContain(
      "To upload games, join one of the JetLag Discord servers that use Searchlight.",
    );
    await clickButton("Check again");
    expect(env.focused.node).toBe(findButton("Check again"));
    serve([srv], {});
    await clickButton("Check again");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContainEqual(
      expect.stringContaining("/servers?recheck=true"),
    );
    expect(pageText()).toContain("JetLag Server (srv-1)");
    expect(env.focused.node?.nodeName).toBe("SELECT");
  });

  it("ImportPanel checks the game cap again, keeping focus", async () => {
    const answers = [
      json({ message: "You already have 20 Casual games.", code: "CASUAL_GAME_LIMIT" }, 409),
      json({ message: "You already have 20 Casual games.", code: "CASUAL_GAME_LIMIT" }, 409),
      json({ status: "created", gameId: "g2", gameKey: "stockholm", revision: 1 }, 201),
    ];
    fetchMock.mockImplementation(async (u: string | URL) =>
      new URL(String(u)).pathname === "/servers" ? json({ servers: [casualSrv] }) : answers.shift(),
    );
    await render(
      createElement(ImportPanel, {
        definition: { ...def, serverId: CASUAL_SERVER_ID },
        noServer: false,
        busy: false,
        blocked: null,
        replaceGameId: null,
      }),
    );
    expect(pageText()).toContain("You already have 20 Casual games.");
    expect(findButton("Import game")?.disabled).toBe(true);
    await clickButton("Check again");
    expect(env.focused.node).toBe(findButton("Check again"));
    await clickButton("Check again");
    expect(answers).toHaveLength(0);
    expect(findButton("Check again")).toBeUndefined();
    expect(findButton("Import game")?.disabled).toBe(false);
    expect(env.focused.node?.nodeName).toBe("SELECT");
  });
});

describe("a game's history", () => {
  beforeEach(() => verifiedUserId.set("u1"));
  const entry = (action: AuditLogEntry["action"], details: Record<string, unknown>) =>
    ({
      id: action,
      createdAt: "2026-11-24T10:02:00.000Z",
      serverId: "srv-1",
      serverName: "JetLag Server",
      actorId: "u1",
      actorName: "Alice",
      action,
      targetId: "g1",
      targetName: "Stockholm",
      details,
    }) satisfies AuditLogEntry;
  const panel = () => createElement(AuditLogPanel, { serverId: "srv-1", gameId: "g1" });

  it("asks for that game's entries only, leaves out ids and upload channels, says listing in words", async () => {
    fetchMock.mockResolvedValue(
      json({
        entries: [
          entry("link.create", { linkId: "cl_secret" }),
          entry("game.revision", { revision: 3, source: "web", name: { from: "A", to: "B" } }),
          { ...entry("game.listing", { unlisted: true }), id: "l1" },
          { ...entry("game.listing", { unlisted: false }), id: "l2" },
        ],
        nextCursor: null,
      }),
    );
    await render(panel());
    const urls = fetchMock.mock.calls.map(([u]) => new URL(String(u)));
    expect(urls.map((u) => u.pathname)).toEqual(["/audit-log"]);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ serverId: "srv-1", targetId: "g1" });
    expect(pageText()).toContain("Created link");
    expect(pageText()).toContain("revision: 3, name: A → B");
    expect(pageText()).not.toContain("cl_secret");
    expect(pageText()).not.toContain("source");
    expect(pageText()).toContain("Alice · made unlisted");
    expect(pageText()).toContain("Alice · made listed");
    expect(pageText()).not.toContain("unlisted:");
  });

  it("says it is loading, and when it was refused", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    await render(panel());
    expect(pageText()).toBe("Loading…");

    await act(async () => root?.unmount());
    env.document.body.textContent = "";
    fetchMock.mockResolvedValue(json({ message: "Forbidden" }, 403));
    await render(panel());
    expect(pageText()).toBe("Couldn't load the history.");
  });
});
