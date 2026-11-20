// ImportPanel pins plain imports to the previewed currentRevisionId for both
// "updated" and "unchanged" previews, and omits it for "created" previews.
import type { GameDefinition, GameImportResponse } from "@searchlight/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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
    Object.assign(globalThis, {
        document,
        window: {
            document,
            location: { origin: "http://localhost", search: "" },
            HTMLIFrameElement: class {},
        },
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    return {
        container: {
            ...node(),
            nodeType: 1,
            tagName: "DIV",
            ownerDocument: document,
        },
        buttons: [] as {
            children: ReactNode;
            disabled?: boolean;
            onClick?: () => unknown;
        }[],
    };
});

const apiMocks = vi.hoisted(() => ({
    importGameDefinitionAPI: vi.fn(),
}));

vi.mock("@/game-definition/api", () => ({
    importGameDefinitionAPI: apiMocks.importGameDefinitionAPI,
}));

vi.mock("@/components/ui/button", () => ({
    Button: (props: (typeof ui.buttons)[number]) => {
        ui.buttons.push(props);
        return null;
    },
}));

import { ImportPanel } from "@/components/ImportPanel";
import { verifiedUserId } from "@/lib/activeSession";

const definition = {
    id: "london-2026",
    name: "London 2026",
    serverId: "server-1",
    map: { center: [0, 0] },
} as unknown as GameDefinition;

const existingComparison = (currentRevisionId: string | null) => ({
    name: "London 2026",
    revision: 1,
    currentRevisionId,
    createdByYou: true,
    likelyMistake: false,
    differences: [],
});

let root: Root | null = null;

const settle = () =>
    act(async () => {
        for (let i = 0; i < 10; i++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    });

const submitButton = () => ui.buttons[ui.buttons.length - 1]!;

beforeEach(() => {
    ui.buttons = [];
    apiMocks.importGameDefinitionAPI.mockReset();
    verifiedUserId.set(null);
    root = createRoot(ui.container as unknown as Element);
});

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
});

test("sends expectedCurrentRevisionId on confirm for an unchanged plain import preview", async () => {
    const preview: GameImportResponse = {
        status: "unchanged",
        gameId: "game-1",
        gameKey: "london-2026",
        revision: 1,
        checksum: "abc",
        errors: [],
        warnings: [],
        existing: existingComparison("rev-unchanged-1"),
    };
    apiMocks.importGameDefinitionAPI
        .mockResolvedValueOnce(preview)
        .mockResolvedValueOnce(preview);

    await act(async () =>
        root!.render(
            <ImportPanel
                definition={definition}
                noServer={false}
                busy={false}
                blocked={null}
                replaceGameId={null}
            />,
        ),
    );
    await settle();

    expect(submitButton().disabled).toBe(false);
    await act(async () => {
        await submitButton().onClick!();
    });
    await settle();

    expect(apiMocks.importGameDefinitionAPI).toHaveBeenLastCalledWith(
        { ...definition, serverId: "server-1" },
        false,
        false,
        false,
        "rev-unchanged-1",
        undefined,
    );
});

test("sends expectedCurrentRevisionId for updated previews and omits it for created previews", async () => {
    const updatedPreview: GameImportResponse = {
        status: "updated",
        gameId: "game-1",
        gameKey: "london-2026",
        revision: 2,
        checksum: "def",
        errors: [],
        warnings: [],
        existing: existingComparison("rev-updated-1"),
    };
    apiMocks.importGameDefinitionAPI
        .mockResolvedValueOnce(updatedPreview)
        .mockResolvedValueOnce(updatedPreview);

    await act(async () =>
        root!.render(
            <ImportPanel
                definition={definition}
                noServer={false}
                busy={false}
                blocked={null}
                replaceGameId={null}
            />,
        ),
    );
    await settle();

    await act(async () => {
        await submitButton().onClick!();
    });
    await settle();

    expect(apiMocks.importGameDefinitionAPI).toHaveBeenLastCalledWith(
        { ...definition, serverId: "server-1" },
        false,
        true,
        false,
        "rev-updated-1",
        undefined,
    );

    // Re-render with a new definition whose preview reports a brand-new game.
    const createdPreview: GameImportResponse = {
        status: "created",
        gameId: "dry-run",
        gameKey: "paris-2026",
        revision: 1,
        checksum: "ghi",
        errors: [],
        warnings: [],
    };
    apiMocks.importGameDefinitionAPI
        .mockResolvedValueOnce(createdPreview)
        .mockResolvedValueOnce({ ...createdPreview, gameId: "game-2" });

    const newDef = { ...definition, id: "paris-2026", name: "Paris 2026" };
    await act(async () =>
        root!.render(
            <ImportPanel
                definition={newDef}
                noServer={false}
                busy={false}
                blocked={null}
                replaceGameId={null}
            />,
        ),
    );
    await settle();

    await act(async () => {
        await submitButton().onClick!();
    });
    await settle();

    expect(apiMocks.importGameDefinitionAPI).toHaveBeenLastCalledWith(
        { ...newDef, serverId: "server-1" },
        false,
        false,
        false,
        undefined,
        undefined,
    );
});
