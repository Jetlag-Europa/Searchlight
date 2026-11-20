import {
    CASUAL_SERVER_ID,
    type Game,
    type GameDefinition,
    type ServerWithPermissions,
} from "@searchlight/shared";
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
        value = "";
        checked = false;
        selected = false;
        defaultSelected = false;
        get disabled() {
            return this.attributes.has("disabled");
        }
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
        addEventListener() {}
        removeEventListener() {}
        querySelector() {
            return null;
        }
    }

    const document = new FakeDocument();
    const location = {
        href: "http://localhost/games",
        origin: "http://localhost",
        pathname: "/games",
        search: "",
        hash: "",
    };
    const window = Object.assign(new EventTarget(), {
        document,
        HTMLIFrameElement: class {},
        location,
    });
    document.defaultView = window;

    Object.assign(globalThis, {
        window,
        document,
        IS_REACT_ACT_ENVIRONMENT: true,
    });

    return { document, location };
});

vi.mock("@/components/GameLinksDialog", () => ({
    GameLinksDialog: () => null,
}));
vi.mock("@/components/GameSettingsDialog", () => ({
    GameSettingsDialog: () => null,
}));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GameManager } from "@/components/GameManager";
import { ImportPanel } from "@/components/ImportPanel";
import { verifiedUserId } from "@/lib/activeSession";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const makeGame = (overrides: Partial<Game> = {}): Game =>
    ({
        id: "game-1",
        gameKey: "stockholm",
        name: "Stockholm Hide & Seek",
        serverId: "srv-1",
        unlisted: false,
        createdById: "user-1",
        currentRevisionId: "rev-1",
        ...overrides,
    }) as Game;

const makeDefinition = (
    overrides: Partial<GameDefinition> = {},
): GameDefinition =>
    ({
        schemaVersion: 2,
        id: "stockholm",
        name: "Stockholm Hide & Seek",
        serverId: "srv-1",
        ...overrides,
    }) as GameDefinition;

const settle = () =>
    act(async () => {
        for (let i = 0; i < 20; i++) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    });

let root: Root | null = null;

const render = async (element: ReactElement) => {
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root!.render(element));
    await settle();
};

const pageText = () => env.document.body.textContent;

const findButton = (label: string) =>
    [...env.document.body.walk()].find(
        (n) => n.nodeName === "BUTTON" && n.textContent.trim() === label,
    );

const clickButton = async (label: string) => {
    const button = findButton(label);
    if (!button) throw new Error(`Button "${label}" not found`);
    if (button.disabled) throw new Error(`Button "${label}" is disabled`);
    const propsKey = Object.keys(button).find((k) =>
        k.startsWith("__reactProps$"),
    )!;
    const props = (
        button as unknown as Record<string, { onClick?: () => void }>
    )[propsKey];
    await act(async () => {
        props.onClick?.();
    });
    await settle();
};

const fetchMock = vi.fn();

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    env.location.search = "";
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    env.document.body.textContent = "";
    verifiedUserId.set(null);
    vi.unstubAllGlobals();
});

describe("GameManager ServerSection load errors", () => {
    const adminServer: ServerWithPermissions = {
        id: "srv-1",
        name: "JetLag Server",
        iconUrl: null,
        isMember: true,
        permissions: ["games.create"],
    };

    it("shows status error and Retry on non-OK GET /games instead of 'No games yet.', then recovers", async () => {
        verifiedUserId.set("user-1");
        let gamesCalls = 0;
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                return json({ servers: [adminServer] });
            }
            if (url.pathname === "/games") {
                gamesCalls += 1;
                if (gamesCalls === 1) {
                    return json({ error: "unavailable" }, 503);
                }
                return json({ games: [makeGame()] });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(createElement(GameManager));

        expect(pageText()).toContain("Couldn't load games (503)");
        expect(pageText()).not.toContain("No games yet.");
        expect(pageText()).toContain("Retry");

        await clickButton("Retry");

        expect(gamesCalls).toBe(2);
        expect(pageText()).toContain("Stockholm Hide & Seek");
        expect(pageText()).not.toContain("Couldn't load games");
    });

    it("shows network error and Retry on rejected GET /games instead of 'No games yet.', then recovers", async () => {
        verifiedUserId.set("user-1");
        let gamesCalls = 0;
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                return json({ servers: [adminServer] });
            }
            if (url.pathname === "/games") {
                gamesCalls += 1;
                if (gamesCalls === 1) {
                    throw new TypeError("Failed to fetch");
                }
                return json({ games: [makeGame()] });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(createElement(GameManager));

        expect(pageText()).toContain("Couldn't load games (network error)");
        expect(pageText()).not.toContain("No games yet.");

        await clickButton("Retry");

        expect(gamesCalls).toBe(2);
        expect(pageText()).toContain("Stockholm Hide & Seek");
        expect(pageText()).not.toContain("Couldn't load games");
    });

    it("keeps Casual section visible with Retry for a creator without games.create when GET /games fails", async () => {
        verifiedUserId.set("user-1");
        const casualServer: ServerWithPermissions = {
            id: CASUAL_SERVER_ID,
            name: "Casual Games",
            iconUrl: null,
            isMember: true,
            permissions: [],
        };
        let gamesCalls = 0;
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                return json({ servers: [casualServer] });
            }
            if (url.pathname === "/games") {
                gamesCalls += 1;
                if (gamesCalls === 1) {
                    return json({ error: "server error" }, 500);
                }
                return json({
                    games: [
                        makeGame({
                            id: "casual-1",
                            name: "My Casual Game",
                            serverId: CASUAL_SERVER_ID,
                            unlisted: true,
                        }),
                    ],
                });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(createElement(GameManager));

        expect(pageText()).toContain("Casual Games");
        expect(pageText()).toContain("Couldn't load games (500)");
        expect(pageText()).not.toContain(
            "You don’t have game management permissions in any server.",
        );

        await clickButton("Retry");

        expect(gamesCalls).toBe(2);
        expect(pageText()).toContain("My Casual Game");
        expect(pageText()).not.toContain("Couldn't load games");
    });

    it("hides Casual and shows no-permissions message once Retry genuinely returns 0 games", async () => {
        verifiedUserId.set("user-1");
        const casualServer: ServerWithPermissions = {
            id: CASUAL_SERVER_ID,
            name: "Casual Games",
            iconUrl: null,
            isMember: true,
            permissions: [],
        };
        let gamesCalls = 0;
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                return json({ servers: [casualServer] });
            }
            if (url.pathname === "/games") {
                gamesCalls += 1;
                if (gamesCalls === 1) {
                    return json({ error: "server error" }, 500);
                }
                return json({ games: [] });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(createElement(GameManager));

        expect(pageText()).toContain("Couldn't load games (500)");
        await clickButton("Retry");

        expect(gamesCalls).toBe(2);
        expect(pageText()).toContain(
            "You don’t have game management permissions in any server.",
        );
    });
});

describe("ImportPanel server load errors and auth gating", () => {
    const serverList = [
        {
            id: "srv-1",
            name: "JetLag Server",
            permissions: ["games.create"],
        },
    ];

    it.each([
        [
            "non-OK status",
            async () => json({ error: "down" }, 503),
            "Couldn't load your servers (503)",
        ],
        [
            "network error",
            async () => {
                throw new TypeError("Failed to fetch");
            },
            "Couldn't load your servers",
        ],
    ])(
        "shows error and Retry on /servers %s instead of permission denial, then recovers",
        async (_, failServers, expectedError) => {
            verifiedUserId.set("user-1");
            let serverCalls = 0;
            fetchMock.mockImplementation(async (input: string | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/servers") {
                    serverCalls += 1;
                    if (serverCalls === 1) return failServers();
                    return json({ servers: serverList });
                }
                if (url.pathname === "/games/import") {
                    return json({
                        status: "created",
                        gameId: "game-1",
                        gameKey: "stockholm",
                        revision: 1,
                    });
                }
                return json({ error: "unexpected" }, 404);
            });

            await render(
                createElement(ImportPanel, {
                    definition: makeDefinition({ serverId: "" }),
                    noServer: true,
                    busy: false,
                    blocked: null,
                    replaceGameId: null,
                }),
            );

            expect(pageText()).toContain(expectedError);
            expect(pageText()).not.toContain(
                "You can't import games to any server.",
            );
            expect(pageText()).toContain("Retry");

            await clickButton("Retry");

            expect(serverCalls).toBe(2);
            expect(pageText()).toContain("JetLag Server (srv-1)");
            expect(pageText()).not.toContain("Couldn't load your servers");
            expect(pageText()).toContain("New game");
        },
    );

    it("also retries a failed dry-run on Retry when the file already names a server", async () => {
        verifiedUserId.set("user-1");
        let serverCalls = 0;
        let dryRunCalls = 0;
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                serverCalls += 1;
                if (serverCalls === 1) return json({ error: "down" }, 503);
                return json({ servers: serverList });
            }
            if (url.pathname === "/games/import") {
                dryRunCalls += 1;
                if (dryRunCalls === 1) return json({ message: "Service unavailable" }, 503);
                return json({
                    status: "created",
                    gameId: "game-1",
                    gameKey: "stockholm",
                    revision: 1,
                });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(
            createElement(ImportPanel, {
                definition: makeDefinition(),
                noServer: false,
                busy: false,
                blocked: null,
                replaceGameId: null,
            }),
        );

        expect(pageText()).toContain("Couldn't load your servers (503)");
        expect(pageText()).toContain("Service unavailable");

        await clickButton("Retry");

        expect(serverCalls).toBe(2);
        expect(dryRunCalls).toBe(2);
        expect(pageText()).toContain("JetLag Server (srv-1)");
        expect(pageText()).toContain("New game");
        expect(pageText()).not.toContain("Service unavailable");
    });

    it("waits for verifiedUserId before firing dry-run and disables submit until verified", async () => {
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/servers") {
                return json({ servers: serverList });
            }
            if (url.pathname === "/games/import") {
                return json({
                    status: "created",
                    gameId: "game-1",
                    gameKey: "stockholm",
                    revision: 1,
                });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(
            createElement(ImportPanel, {
                definition: makeDefinition(),
                noServer: false,
                busy: false,
                blocked: null,
                replaceGameId: null,
            }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(findButton("Import game")?.disabled).toBe(true);

        await act(async () => {
            verifiedUserId.set("user-1");
        });
        await settle();

        const urls = fetchMock.mock.calls.map(([input]) =>
            new URL(String(input)).pathname,
        );
        expect(urls).toContain("/servers");
        expect(urls).toContain("/games/import");
        expect(pageText()).toContain("New game");
        expect(findButton("Import game")?.disabled).toBe(false);
    });

    it("waits for verifiedUserId before firing replace dry-run and hides Check again until verified", async () => {
        fetchMock.mockImplementation(async (input: string | URL) => {
            const url = new URL(String(input));
            if (url.pathname === "/games/game-1/import") {
                return json({
                    status: "updated",
                    gameId: "game-1",
                    gameKey: "stockholm",
                    revision: 2,
                    existing: {
                        name: "Stockholm Hide & Seek",
                        revision: 1,
                        currentRevisionId: "rev-1",
                        likelyMistake: false,
                        differences: [],
                        createdByYou: true,
                    },
                });
            }
            return json({ error: "unexpected" }, 404);
        });

        await render(
            createElement(ImportPanel, {
                definition: makeDefinition(),
                noServer: false,
                busy: false,
                blocked: null,
                replaceGameId: "game-1",
            }),
        );

        expect(fetchMock).not.toHaveBeenCalled();
        expect(findButton("Check again")).toBeUndefined();
        expect(findButton("Replace game")?.disabled).toBe(true);

        await act(async () => {
            verifiedUserId.set("user-1");
        });
        await settle();

        const urls = fetchMock.mock.calls.map(([input]) =>
            new URL(String(input)).pathname,
        );
        expect(urls).toEqual(["/games/game-1/import"]);
        expect(pageText()).toContain("Update (rev 2)");
        expect(findButton("Replace game")?.disabled).toBe(false);
    });
});
