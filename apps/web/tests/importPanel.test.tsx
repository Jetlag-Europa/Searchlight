// ImportPanel's preview and import calls.
import type { GameDefinition, GameImportResponse } from "@searchlight/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const ui = vi.hoisted(() => {
  const node = (): Record<string, unknown> => ({
    style: {},
    options: [],
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

const renderPanel = (def: GameDefinition = definition) =>
  act(async () =>
    root!.render(
      <ImportPanel
        definition={def}
        noServer={false}
        busy={false}
        blocked={null}
        replaceGameId={null}
      />,
    ),
  );

beforeEach(() => {
  ui.buttons = [];
  apiMocks.importGameDefinitionAPI.mockReset();
  verifiedUserId.set("u1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ servers: [{ id: "server-1", name: "Server 1" }] }),
    })),
  );
  root = createRoot(ui.container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  verifiedUserId.set(null);
  vi.unstubAllGlobals();
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
  apiMocks.importGameDefinitionAPI.mockResolvedValueOnce(preview).mockResolvedValueOnce(preview);

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

test.each([
  ["CASUAL_GAME_LIMIT", true],
  ["CASUAL_STORAGE_LIMIT", false],
])("a preview refused with %s disables Import: %s", async (code, disabled) => {
  apiMocks.importGameDefinitionAPI.mockRejectedValueOnce(
    Object.assign(new Error("You already have 20 Casual games."), { code }),
  );

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

  expect(submitButton().disabled).toBe(disabled);
});

test("someone in no server gets the join message and no Import, also with a Casual file", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ servers: [] }) })),
  );
  apiMocks.importGameDefinitionAPI.mockRejectedValue(
    Object.assign(new Error("To upload games, join one of the JetLag Discord servers."), {
      code: "FORBIDDEN",
    }),
  );

  await act(async () =>
    root!.render(
      <ImportPanel
        definition={{ ...definition, serverId: "home-games" }}
        noServer={false}
        busy={false}
        blocked={null}
        replaceGameId={null}
      />,
    ),
  );
  await settle();

  expect(ui.buttons.some((b) => b.children === "Check again")).toBe(true);
  expect(submitButton().disabled).toBe(true);
});

test("a plain import previews once its servers are in, and again after Check again", async () => {
  let servers: unknown[] = [];
  let listed!: () => void;
  const serversIn = new Promise<void>((resolve) => (listed = resolve));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await serversIn;
      return { ok: true, json: async () => ({ servers }) };
    }),
  );
  apiMocks.importGameDefinitionAPI
    .mockRejectedValueOnce(
      Object.assign(new Error("To upload games, join one of the JetLag Discord servers."), {
        code: "FORBIDDEN",
      }),
    )
    .mockResolvedValueOnce({
      status: "created",
      gameId: "game-1",
      gameKey: "london-2026",
      revision: 1,
      checksum: "abc",
      errors: [],
      warnings: [],
    } satisfies GameImportResponse);

  await renderPanel({ ...definition, serverId: "home-games" });
  await settle();
  expect(apiMocks.importGameDefinitionAPI).not.toHaveBeenCalled();
  expect(submitButton().disabled).toBe(true);

  listed();
  await settle();
  expect(apiMocks.importGameDefinitionAPI).toHaveBeenCalledTimes(1);

  // The player joined a server: Casual is now theirs to upload to.
  servers = [{ id: "home-games", name: "Casual Games" }];
  const checkAgain = ui.buttons.findLast((b) => b.children === "Check again")!;
  await act(async () => {
    checkAgain.onClick!();
  });
  await settle();
  expect(apiMocks.importGameDefinitionAPI).toHaveBeenCalledTimes(2);
  expect(submitButton().children).toBe("Import game");
  expect(submitButton().disabled).toBe(false);
});

test("a new preview cancels the one it replaces", async () => {
  apiMocks.importGameDefinitionAPI.mockReturnValue(new Promise(() => {}));
  await renderPanel();
  await settle();
  await renderPanel({ ...definition, name: "London 2027" });
  await settle();

  const signals = apiMocks.importGameDefinitionAPI.mock.calls.map((c) => c[6] as AbortSignal);
  expect(signals.map((s) => s.aborted)).toEqual([true, false]);
});
