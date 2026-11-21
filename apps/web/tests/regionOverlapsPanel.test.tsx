import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeNode {
  nodeType: number;
  tagName?: string;
  nodeValue?: string;
  children: FakeNode[];
  parentNode: FakeNode | null;
  textContent: string;
  [key: string]: unknown;
}

const env = vi.hoisted(() => {
  const makeNode = (
    nodeType: number,
    tagName?: string,
    nodeValue?: string,
    ownerDocument?: FakeNode,
  ): FakeNode => {
    let text = "";
    const detach = (c: FakeNode) => {
      if (!c.parentNode) return;
      c.parentNode.children = c.parentNode.children.filter((x) => x !== c);
      c.parentNode = null;
    };
    const node: FakeNode = {
      nodeType,
      tagName: tagName?.toUpperCase(),
      nodeValue,
      children: [],
      parentNode: null,
      style: {},
      ownerDocument,
      scrollTo() {},
      appendChild(c: FakeNode) {
        detach(c);
        c.parentNode = node;
        node.children.push(c);
        return c;
      },
      insertBefore(c: FakeNode, before: FakeNode | null) {
        detach(c);
        c.parentNode = node;
        const i = before ? node.children.indexOf(before) : -1;
        if (i >= 0) node.children.splice(i, 0, c);
        else node.children.push(c);
        return c;
      },
      removeChild(c: FakeNode) {
        detach(c);
        return c;
      },
      setAttribute() {},
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      textContent: "",
    };
    Object.defineProperty(node, "textContent", {
      get: () =>
        node.nodeType === 3
          ? (node.nodeValue ?? "")
          : node.children.length
            ? node.children.map((c) => c.textContent).join("")
            : text,
      set(v: unknown) {
        if (node.nodeType === 3) node.nodeValue = String(v ?? "");
        else {
          node.children = [];
          text = String(v ?? "");
        }
      },
    });
    return node;
  };
  const document = makeNode(9);
  document.createElement = (tag: string) => makeNode(1, tag, undefined, document);
  document.createTextNode = (t: string) => makeNode(3, undefined, t, document);
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
    createContainer: () => makeNode(1, "div", undefined, document),
    requestGeometry: vi.fn(),
    importPanel: null as {
      definition: GameDefinition;
      busy: boolean;
      blocked: string | null;
    } | null,
  };
});

vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("leaflet", () => ({ circleMarker: vi.fn() }));
vi.mock("react-leaflet", () => ({
  GeoJSON: () => null,
  MapContainer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Rectangle: () => null,
  ScaleControl: () => null,
  TileLayer: () => null,
  useMap: () => ({ fitBounds: vi.fn() }),
}));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: () => null }));
vi.mock("@/components/ImportPanel", () => ({
  ImportPanel: (props: NonNullable<typeof env.importPanel>) => {
    env.importPanel = props;
    return null;
  },
}));
vi.mock("@/game-definition/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/game-definition/inspect")>()),
  checkGameQuality: vi.fn(async () => []),
}));
vi.mock("@/maps/geo-utils/geometryClient", () => ({
  requestGeometry: (...args: unknown[]) => env.requestGeometry(...args),
}));

import { GameImporter } from "@/components/GameImporter";
import { findRegionOverlaps, removeRegionOverlaps } from "@/maps/geo-utils/regionOverlaps";

const box = (west: number, east: number, name: string): Feature<Polygon> =>
  turf.bboxPolygon([west, 50, east, 51], { properties: { name }, id: name });

const makeDef = (id: string, regions: Feature<Polygon>[], noOverlaps = false) =>
  ({
    id,
    name: id,
    serverId: "home-games",
    map: {
      center: [1, 50.5],
      bounds: [-0.1, 49.9, 2.1, 51.1],
      playArea: turf.featureCollection([box(0, 2, "area")]),
    },
    hidingZones: {
      radius: 400,
      features: turf.featureCollection([turf.point([0.5, 50.5], { name: "Z1" }, { id: "z1" })]),
    },
    radars: [400],
    thermometer: true,
    features: [
      {
        name: "Districts",
        enabledFor: ["matching", "measuring"],
        ...(noOverlaps ? { noOverlaps: true } : {}),
        data: turf.featureCollection(regions),
      },
    ],
  }) as unknown as GameDefinition;

const asFile = (def: GameDefinition): File => {
  const text = JSON.stringify(def);
  return {
    name: `${def.id}.game.json`,
    size: text.length,
    text: async () => text,
  } as unknown as File;
};

const findAll = (n: FakeNode, p: (x: FakeNode) => boolean): FakeNode[] => [
  ...(p(n) ? [n] : []),
  ...n.children.flatMap((c) => findAll(c, p)),
];
const propsOf = (n: FakeNode): Record<string, any> =>
  (n[Object.keys(n).find((k) => k.startsWith("__reactProps$")) ?? ""] as any) ?? {};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("GameImporter & RegionOverlapsPanel", () => {
  let container: FakeNode;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    container = env.createContainer();
    root = createRoot(container as unknown as Element);
    env.importPanel = null;
    env.requestGeometry
      .mockReset()
      .mockImplementation(async (req: any) =>
        req.kind === "regionOverlaps" ? findRegionOverlaps(req) : removeRegionOverlaps(req),
      );
    await act(async () => root.render(<GameImporter />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  const pickFile = async (file: File) => {
    const input = findAll(container, (n) => n.tagName === "INPUT")[0];
    await act(async () => {
      propsOf(input).onChange({ target: { files: [file], value: "" } });
      await flush();
    });
  };
  const button = (label: string) =>
    findAll(container, (n) => n.tagName === "BUTTON" && n.textContent.includes(label))[0];

  it("discards a stale fix from file A after loading file B", async () => {
    let resolveFix!: (regions: ReturnType<typeof removeRegionOverlaps>) => void;
    env.requestGeometry.mockImplementation(async (req: any) =>
      req.kind === "regionOverlaps"
        ? findRegionOverlaps(req)
        : new Promise((r) => (resolveFix = r)),
    );
    const fileA = makeDef("game-a", [box(0, 1.01, "a"), box(1, 2, "b")]);
    const fileB = makeDef("game-b", [box(0, 1, "c"), box(1, 2, "d")]);

    await pickFile(asFile(fileA));
    let fixing!: Promise<void>;
    await act(async () => {
      fixing = propsOf(button("Fix overlaps")).onClick();
      await flush();
    });

    await pickFile(asFile(fileB));
    expect(env.importPanel?.definition.id).toBe("game-b");

    await act(async () => {
      resolveFix(
        removeRegionOverlaps({ regions: fileA.features![0].data.features as Feature<Polygon>[] }),
      );
      await fixing;
      await flush();
    });
    expect(env.importPanel?.definition.id).toBe("game-b");
    expect(env.importPanel?.busy).toBe(false);
    expect(container.textContent).not.toContain("The file was changed");
  });

  it("blocks a marked layer on check error (including empty message) and unblocks via Remove mark", async () => {
    env.requestGeometry.mockRejectedValueOnce(new Error(""));
    await pickFile(asFile(makeDef("marked-err", [box(0, 1, "a"), box(1, 2, "b")], true)));

    expect(env.importPanel?.busy).toBe(false);
    expect(env.importPanel?.blocked).toContain("Districts");
    const remove = button("Remove mark");
    expect(remove).toBeDefined();

    // Removing the mark unblocks import even when the unmarked check also fails.
    env.requestGeometry.mockRejectedValueOnce(new Error("worker down"));
    await act(async () => {
      await propsOf(remove).onClick();
      await flush();
    });
    expect(env.importPanel?.busy).toBe(false);
    expect(env.importPanel?.blocked).toBeNull();
    expect(button("Remove mark")).toBeUndefined();
  });

  it("blocks identical regions on a marked layer and offers Remove mark", async () => {
    await pickFile(asFile(makeDef("identical", [box(0, 1, "a"), box(0, 1, "b")], true)));

    expect(env.importPanel?.busy).toBe(false);
    expect(env.importPanel?.blocked).toContain("Districts");
    expect(container.textContent).toContain("Can't fix:");
    const remove = button("Remove mark");
    expect(remove).toBeDefined();

    await act(async () => {
      await propsOf(remove).onClick();
      await flush();
    });
    expect(env.importPanel?.busy).toBe(false);
    expect(env.importPanel?.blocked).toBeNull();
  });

  it("reports an unreadable file without crashing", async () => {
    await pickFile({
      name: "broken.game.json",
      size: 10,
      text: () => Promise.reject(new Error("permission denied")),
    } as unknown as File);
    expect(container.textContent).toContain("Couldn't read file: permission denied");
  });
});
