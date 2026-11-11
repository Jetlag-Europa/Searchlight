// "Share a copy" is per session: switching session drops the old session's
// links, and a link the old session creates late isn't copied.
import type { GameSessionSummary } from "@searchlight/shared";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

// There is no DOM library here: react-dom renders into inert stand-ins, and
// the drawer's buttons are read from the Button mock instead.
const ui = vi.hoisted(() => {
    const node = (): Record<string, unknown> => ({
        style: {},
        appendChild: (c: unknown) => c,
        insertBefore: (c: unknown) => c,
        removeChild: (c: unknown) => c,
        setAttribute() {},
        removeAttribute() {},
        addEventListener() {},
        removeEventListener() {},
    });
    const document = {
        ...node(),
        nodeType: 9,
        createElement: node,
        createTextNode: node,
    };
    const writeText = vi.fn(async (_url: string) => {});
    Object.assign(globalThis, {
        document,
        window: {
            document,
            location: { origin: "http://localhost" },
            HTMLIFrameElement: class {},
        },
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText } });
    return {
        container: {
            ...node(),
            nodeType: 1,
            tagName: "DIV",
            ownerDocument: document,
        },
        writeText,
        buttons: [] as { children: ReactNode; onClick?: () => unknown }[],
        openChange: (_open: boolean) => {},
    };
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
            ui.buttons = [];
            ui.openChange = onOpenChange;
            return <>{children}</>;
        },
        DrawerContent: Inline,
        DrawerHeader: Inline,
        DrawerTitle: Inline,
        DrawerTrigger: Inline,
    };
});
vi.mock("@/components/ui/button", () => ({
    Button: (props: (typeof ui.buttons)[number]) => {
        ui.buttons.push(props);
        return null;
    },
}));

import { ShareDrawer } from "@/components/ShareDrawer";
import { activeSessionData } from "@/lib/activeSession";

const session = (id: string) =>
    ({ id, name: id, role: "creator" }) as GameSessionSummary;
const buttons = (label: string) =>
    ui.buttons.filter((b) => b.children === label);
const json = (body: unknown) => new Response(JSON.stringify(body));

const root = createRoot(ui.container as unknown as Element);
afterEach(() => vi.unstubAllGlobals());

test("switching session drops the old session's links", async () => {
    vi.stubGlobal("fetch", async () =>
        json({
            links: [
                {
                    id: "l1",
                    token: "t1",
                    linkType: "fork",
                    createdAt: "2026-11-11",
                },
            ],
        }),
    );
    activeSessionData.set(session("a"));
    await act(async () => root.render(<ShareDrawer />));
    await act(async () => ui.openChange(true));
    expect(buttons("Copy")).toHaveLength(1);

    await act(async () => activeSessionData.set(session("b")));
    expect(buttons("Copy")).toHaveLength(0);
});

test("a link the old session creates after a switch isn't copied", async () => {
    let respond!: (res: Response) => void;
    vi.stubGlobal("fetch", () => new Promise((resolve) => (respond = resolve)));
    activeSessionData.set(session("a"));
    await act(async () => root.render(<ShareDrawer />));
    let created: unknown;
    await act(async () => {
        created = buttons("Create share link")[0]!.onClick!();
    });

    await act(async () => activeSessionData.set(session("b")));
    await act(async () => {
        respond(json({ id: "l1", token: "t1" }));
        await created;
    });
    expect(ui.writeText).not.toHaveBeenCalled();
});
