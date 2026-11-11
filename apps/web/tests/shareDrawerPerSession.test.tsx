// The "Share a copy" drawer keeps its links per session: switching to another
// session starts it afresh, so the previous session's links never show, or
// get copied or revoked, under the new one (even when the new list can't
// load), and a link the old session creates late isn't copied.
// Rendered with React into a minimal stand-in for the DOM (there is no DOM
// library here); the server is a fake fetch, and the clipboard a spy.
import type { GameSessionSummary } from "@searchlight/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const env = vi.hoisted(() => {
    // Just enough of the DOM for react-dom to render the drawer.
    class FakeNode {
        parentNode: FakeNode | null = null;
        childNodes: FakeNode[] = [];
        attributes = new Map<string, string>();
        style: Record<string, unknown> = {};
        nodeValue: string | null = null;
        constructor(
            public nodeType: number,
            public nodeName: string,
            public ownerDocument: FakeNode | null,
        ) {}
        get tagName() {
            return this.nodeName;
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
        setAttribute(name: string, value: unknown) {
            this.attributes.set(name, String(value));
        }
        removeAttribute(name: string) {
            this.attributes.delete(name);
        }
        addEventListener() {}
        removeEventListener() {}
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
        body: FakeNode;
        activeElement: FakeNode;
        defaultView: unknown = null;
        constructor() {
            super(9, "#document", null);
            this.documentElement = this.createElement("html");
            this.body = this.createElement("body");
            this.appendChild(this.documentElement);
            this.documentElement.appendChild(this.body);
            this.activeElement = this.body;
        }
        createElement(tag: string) {
            return new FakeNode(1, tag.toUpperCase(), this);
        }
        createTextNode(text: string) {
            const node = new FakeNode(3, "#text", this);
            node.nodeValue = text;
            return node;
        }
    }
    const document = new FakeDocument();
    const window = {
        document,
        HTMLIFrameElement: class {},
        location: { origin: "http://localhost" },
    };
    document.defaultView = window;
    Object.assign(globalThis, {
        document,
        window,
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    const writeText = vi.fn(async (_url: string) => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
        value: { writeText },
        configurable: true,
    });
    // The open drawer's onOpenChange, as a tap on its trigger calls it.
    const drawer = { openChange: null as ((open: boolean) => void) | null };
    return { document, writeText, drawer };
});

// vaul's drawer renders nothing while closed, so render its contents inline.
vi.mock("@/components/ui/drawer", () => {
    const Inline = ({ children }: { children?: ReactNode }) => <>{children}</>;
    return {
        Drawer: ({
            children,
            onOpenChange,
        }: {
            children?: ReactNode;
            onOpenChange: (open: boolean) => void;
        }) => {
            env.drawer.openChange = onOpenChange;
            return <>{children}</>;
        },
        DrawerContent: Inline,
        DrawerHeader: Inline,
        DrawerTitle: Inline,
        DrawerTrigger: Inline,
    };
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ShareDrawer } from "@/components/ShareDrawer";
import { activeSessionData } from "@/lib/activeSession";

function session(id: string, role: GameSessionSummary["role"] = "creator") {
    return { id, name: `Session ${id}`, role } as GameSessionSummary;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });

const buttons = (text: string) =>
    [...env.document.body.walk()].filter(
        (n) => n.nodeName === "BUTTON" && n.textContent === text,
    );

// Calls a rendered button's click handler, as a tap would.
function click(text: string): Promise<void> {
    const [node] = buttons(text);
    if (!node) throw new Error(`no ${text} button`);
    const propsKey = Object.keys(node).find((k) =>
        k.startsWith("__reactProps$"),
    )!;
    const props = (
        node as unknown as Record<string, { onClick: () => unknown }>
    )[propsKey];
    let done: unknown;
    act(() => {
        done = props.onClick();
    });
    return Promise.resolve(done).then(() => {});
}

const settle = () => act(async () => {});

let root: Root;
const fetchMock =
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(ShareDrawer)));
});

afterEach(async () => {
    await act(async () => root.unmount());
    env.document.body.childNodes = [];
    activeSessionData.set(null);
    fetchMock.mockReset();
    env.writeText.mockClear();
    env.drawer.openChange = null;
    vi.unstubAllGlobals();
});

async function openDrawer() {
    await act(async () => env.drawer.openChange!(true));
    await settle();
}

describe("ShareDrawer", () => {
    test("a switch to another session drops the old session's links, even when the new list can't load", async () => {
        await act(async () => activeSessionData.set(session("a")));
        fetchMock.mockResolvedValueOnce(
            json({
                links: [
                    {
                        id: "link-a",
                        token: "token-a",
                        linkType: "fork",
                        createdAt: "2026-11-11T00:00:00Z",
                    },
                ],
            }),
        );
        await openDrawer();
        expect(buttons("Copy")).toHaveLength(1);
        expect(buttons("Revoke")).toHaveLength(1);

        await act(async () => activeSessionData.set(session("b")));
        fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
        await openDrawer();
        expect(fetchMock).toHaveBeenLastCalledWith(
            expect.stringContaining("/sessions/b/links"),
            expect.anything(),
        );
        expect(env.document.body.textContent).toContain(
            "Share a copy of Session b",
        );
        expect(buttons("Copy")).toHaveLength(0);
        expect(buttons("Revoke")).toHaveLength(0);
    });

    test("a link the old session creates after a switch isn't copied", async () => {
        await act(async () => activeSessionData.set(session("a")));
        let resolveCreate!: (res: Response) => void;
        fetchMock.mockImplementationOnce(
            () => new Promise<Response>((resolve) => (resolveCreate = resolve)),
        );
        const created = click("Create share link");

        await act(async () => activeSessionData.set(session("b")));
        await act(async () => {
            resolveCreate(json({ id: "link-a", token: "token-a" }, 201));
            await created;
        });

        expect(env.writeText).not.toHaveBeenCalled();
        expect(buttons("Copy")).toHaveLength(0);
    });

    test("a link created in the open session is listed and copied", async () => {
        await act(async () => activeSessionData.set(session("a")));
        fetchMock.mockResolvedValueOnce(
            json({ id: "link-a", token: "token-a" }, 201),
        );
        const created = click("Create share link");
        await act(async () => created);

        expect(env.writeText).toHaveBeenCalledWith(
            "http://localhost/join?token=token-a",
        );
        expect(buttons("Copied!")).toHaveLength(1);
    });

    test("shows nothing to anyone but the creator", async () => {
        for (const s of [
            session("a", "member"),
            session("a", "viewer"),
            null,
        ]) {
            await act(async () => activeSessionData.set(s));
            expect(buttons("Share a copy")).toHaveLength(0);
        }
        await act(async () => activeSessionData.set(session("a")));
        expect(buttons("Share a copy")).toHaveLength(1);
    });
});
