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
    style: Record<string, unknown>;
    attributes: Record<string, string>;
    ownerDocument?: FakeDocument;
    scrollTo?: () => void;
    appendChild(child: FakeNode): FakeNode;
    insertBefore(child: FakeNode, before: FakeNode | null): FakeNode;
    removeChild(child: FakeNode): FakeNode;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(): void;
    removeEventListener(): void;
    [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
    createElement(tag: string): FakeNode;
    createTextNode(text: string): FakeNode;
}

const env = vi.hoisted(() => {
    const makeNode = (
        nodeType: number,
        tagName?: string,
        nodeValue?: string,
        ownerDocument?: FakeDocument,
    ): FakeNode => {
        const node: FakeNode = {
            nodeType,
            tagName: tagName?.toUpperCase(),
            nodeValue,
            children: [],
            parentNode: null,
            style: {},
            attributes: {},
            ownerDocument,
            scrollTo() {},
            appendChild(child: FakeNode) {
                if (child.parentNode) child.parentNode.removeChild(child);
                child.parentNode = node;
                node.children.push(child);
                return child;
            },
            insertBefore(child: FakeNode, before: FakeNode | null) {
                if (child.parentNode) child.parentNode.removeChild(child);
                child.parentNode = node;
                const idx = before ? node.children.indexOf(before) : -1;
                if (idx >= 0) node.children.splice(idx, 0, child);
                else node.children.push(child);
                return child;
            },
            removeChild(child: FakeNode) {
                const idx = node.children.indexOf(child);
                if (idx >= 0) node.children.splice(idx, 1);
                child.parentNode = null;
                return child;
            },
            setAttribute(name: string, value: string) {
                node.attributes[name] = value;
            },
            removeAttribute(name: string) {
                delete node.attributes[name];
            },
            addEventListener() {},
            removeEventListener() {},
        };
        let textContentVal: string | undefined;
        Object.defineProperty(node, "textContent", {
            get() {
                if (node.nodeType === 3) return node.nodeValue ?? "";
                if (node.children.length) {
                    return node.children
                        .map((c) => c.textContent as string)
                        .join("");
                }
                return textContentVal ?? "";
            },
            set(value: unknown) {
                if (node.nodeType === 3) {
                    node.nodeValue = String(value ?? "");
                } else {
                    node.children = [];
                    textContentVal = String(value ?? "");
                }
            },
            configurable: true,
        });
        return node;
    };

    const document = makeNode(9) as FakeDocument;
    document.createElement = (tag: string) =>
        makeNode(1, tag, undefined, document);
    document.createTextNode = (text: string) =>
        makeNode(3, undefined, text, document);

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
        document,
        createContainer: () => makeNode(1, "div", undefined, document),
        requestGeometry: vi.fn(),
        importPanelProps: null as {
            definition: GameDefinition;
            busy: boolean;
            blocked: string | null;
        } | null,
    };
});

vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("leaflet", () => ({
    circleMarker: vi.fn(),
}));
vi.mock("react-leaflet", () => {
    const Empty = ({ children }: { children?: ReactNode }) => <>{children}</>;
    return {
        GeoJSON: () => null,
        MapContainer: Empty,
        Rectangle: () => null,
        ScaleControl: () => null,
        TileLayer: () => null,
        useMap: () => ({ fitBounds: vi.fn() }),
    };
});
vi.mock("@/components/ui/checkbox", () => ({
    Checkbox: ({
        id,
        checked,
        disabled,
        onCheckedChange,
    }: {
        id?: string;
        checked?: boolean;
        disabled?: boolean;
        onCheckedChange?: (on: boolean) => void;
    }) => (
        <input
            id={id}
            type="checkbox"
            checked={!!checked}
            disabled={disabled}
            onChange={(e) => onCheckedChange?.(e.target.checked)}
        />
    ),
}));
vi.mock("@/components/ImportPanel", () => ({
    ImportPanel: (props: {
        definition: GameDefinition;
        busy: boolean;
        blocked: string | null;
    }) => {
        env.importPanelProps = props;
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
import { RegionOverlapsPanel } from "@/components/RegionOverlapsPanel";
import {
    findRegionOverlaps,
    removeRegionOverlaps,
} from "@/maps/geo-utils/regionOverlaps";

const box = (west: number, east: number, name: string): Feature<Polygon> =>
    turf.bboxPolygon([west, 50, east, 51], {
        properties: { name },
        id: name,
    });

function makeDefinition(opts: {
    id: string;
    name?: string;
    layerName?: string;
    noOverlaps?: boolean;
    regions: Feature<Polygon>[];
}): GameDefinition {
    return {
        id: opts.id,
        name: opts.name ?? opts.id,
        serverId: "home-games",
        map: {
            center: [1, 50.5],
            bounds: [-0.1, 49.9, 2.1, 51.1],
            playArea: turf.featureCollection([
                turf.bboxPolygon([0, 50, 2, 51], {
                    properties: { name: "Play Area" },
                    id: "area",
                }),
            ]),
        },
        hidingZones: {
            radius: 400,
            features: turf.featureCollection([
                turf.point([0.5, 50.5], { name: "Zone 1" }, { id: "z1" }),
                turf.point([1.5, 50.5], { name: "Zone 2" }, { id: "z2" }),
            ]),
        },
        radars: [400],
        thermometer: true,
        features: [
            {
                name: opts.layerName ?? "Districts",
                enabledFor: ["matching", "measuring"],
                ...(opts.noOverlaps ? { noOverlaps: true } : {}),
                data: turf.featureCollection(opts.regions),
            },
        ],
    } as unknown as GameDefinition;
}

function makeFile(definition: GameDefinition, fileName = `${definition.id}.game.json`): File {
    const json = JSON.stringify(definition);
    return {
        name: fileName,
        size: json.length,
        text: async () => json,
    } as unknown as File;
}

function textOf(node: FakeNode): string {
    return (node.textContent as string) ?? "";
}

function findAll(node: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    if (pred(node)) out.push(node);
    for (const child of node.children) out.push(...findAll(child, pred));
    return out;
}

function reactProps(node: FakeNode): Record<string, any> {
    const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
    return key ? (node[key] as Record<string, any>) : {};
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function flushMicrotasks() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RegionOverlapsPanel & GameImporter noOverlaps verification", () => {
    let container: FakeNode;
    let root: ReturnType<typeof createRoot>;

    beforeEach(() => {
        container = env.createContainer();
        root = createRoot(container as unknown as Element);
        env.importPanelProps = null;
        env.requestGeometry.mockReset();
        env.requestGeometry.mockImplementation(async (req: any) => {
            if (req.kind === "regionOverlaps") return findRegionOverlaps(req);
            if (req.kind === "removeRegionOverlaps")
                return removeRegionOverlaps(req);
            throw new Error(`Unexpected request: ${req.kind}`);
        });
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
    });

    async function pickFile(file: File) {
        const input = findAll(
            container,
            (n) => n.tagName === "INPUT" && reactProps(n).type === "file",
        )[0];
        expect(input).toBeDefined();
        await act(async () => {
            reactProps(input).onChange({ target: { files: [file], value: "" } });
            await flushMicrotasks();
        });
    }

    function buttonsWithText(label: string) {
        return findAll(
            container,
            (n) => n.tagName === "BUTTON" && textOf(n).trim() === label,
        );
    }

    it("shows Remove mark for a marked layer with fixable overlaps and unblocks after removing it", async () => {
        const def = makeDefinition({
            id: "marked-overlap",
            layerName: "Districts",
            noOverlaps: true,
            regions: [box(0, 1.01, "a"), box(1, 2, "b")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(def));

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toContain("Districts");
        expect(textOf(container)).toContain(
            "Marked noOverlaps, but its regions overlap: fix it or remove the mark before importing.",
        );
        const removeButtons = buttonsWithText("Remove mark");
        expect(removeButtons).toHaveLength(1);

        await act(async () => {
            await reactProps(removeButtons[0]).onClick();
            await flushMicrotasks();
        });

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
        expect(env.importPanelProps?.definition.features?.[0].noOverlaps).toBeUndefined();
    });

    it("blocks import and offers Remove mark when checking a marked layer fails", async () => {
        env.requestGeometry.mockRejectedValueOnce(new Error("worker crashed"));
        const def = makeDefinition({
            id: "marked-error",
            layerName: "Districts",
            noOverlaps: true,
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(def));

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toContain("Districts");
        expect(textOf(container)).toContain("Couldn't check: worker crashed");
        const removeButtons = buttonsWithText("Remove mark");
        expect(removeButtons).toHaveLength(1);

        // Removing the mark unblocks import even if the unmarked check errors too.
        env.requestGeometry.mockRejectedValueOnce(new Error("still broken"));
        await act(async () => {
            await reactProps(removeButtons[0]).onClick();
            await flushMicrotasks();
        });

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
        expect(buttonsWithText("Remove mark")).toHaveLength(0);
    });

    it("does not block import when an unmarked layer check errors", async () => {
        env.requestGeometry.mockRejectedValueOnce(new Error("worker crashed"));
        const def = makeDefinition({
            id: "unmarked-error",
            layerName: "Districts",
            noOverlaps: false,
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(def));

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
        expect(textOf(container)).toContain("Couldn't check: worker crashed");
        expect(buttonsWithText("Remove mark")).toHaveLength(0);
    });

    it("unblocks cleanly across two successive clean files", async () => {
        const clean1 = makeDefinition({
            id: "clean-1",
            noOverlaps: false,
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });
        const clean2 = makeDefinition({
            id: "clean-2",
            noOverlaps: false,
            regions: [box(0, 1, "c"), box(1, 2, "d")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });

        await pickFile(makeFile(clean1));
        expect(env.importPanelProps?.definition.id).toBe("clean-1");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();

        await pickFile(makeFile(clean2));
        expect(env.importPanelProps?.definition.id).toBe("clean-2");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
    });

    it("re-reports clean status when RegionOverlapsPanel receives a new definition without remounting", async () => {
        const onWrongMarks = vi.fn();
        const def1 = makeDefinition({
            id: "clean-1",
            noOverlaps: false,
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });
        const def2 = makeDefinition({
            id: "clean-2",
            noOverlaps: false,
            regions: [box(0, 1, "c"), box(1, 2, "d")],
        });

        await act(async () => {
            root.render(
                <RegionOverlapsPanel
                    definition={def1}
                    zones={[]}
                    onFix={async () => {}}
                    onHighlight={() => {}}
                    onWrongMarks={onWrongMarks}
                />,
            );
            await flushMicrotasks();
        });
        expect(onWrongMarks).toHaveBeenLastCalledWith([]);

        onWrongMarks.mockClear();
        await act(async () => {
            root.render(
                <RegionOverlapsPanel
                    definition={def2}
                    zones={[]}
                    onFix={async () => {}}
                    onHighlight={() => {}}
                    onWrongMarks={onWrongMarks}
                />,
            );
            await flushMicrotasks();
        });
        expect(onWrongMarks).toHaveBeenLastCalledWith([]);
    });

    it("discards a stale fix from file A after loading file B", async () => {
        const fixDeferred = deferred<ReturnType<typeof removeRegionOverlaps>>();
        env.requestGeometry.mockImplementation(async (req: any) => {
            if (req.kind === "regionOverlaps") return findRegionOverlaps(req);
            if (req.kind === "removeRegionOverlaps") return fixDeferred.promise;
            throw new Error(`Unexpected request: ${req.kind}`);
        });

        const fileA = makeDefinition({
            id: "game-a",
            noOverlaps: false,
            regions: [box(0, 1.01, "a"), box(1, 2, "b")],
        });
        const fileB = makeDefinition({
            id: "game-b",
            noOverlaps: false,
            regions: [box(0, 1, "c"), box(1, 2, "d")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(fileA));
        expect(env.importPanelProps?.definition.id).toBe("game-a");

        const fixButton = findAll(
            container,
            (n) =>
                n.tagName === "BUTTON" &&
                textOf(n).includes("Fix overlaps and mark"),
        )[0];
        expect(fixButton).toBeDefined();

        // Start fixing file A (worker stays in flight).
        let fixPromise!: Promise<void>;
        await act(async () => {
            fixPromise = reactProps(fixButton).onClick();
            await flushMicrotasks();
        });

        // Pick file B while file A's fix worker is still running.
        await pickFile(makeFile(fileB));
        expect(env.importPanelProps?.definition.id).toBe("game-b");
        expect(env.importPanelProps?.busy).toBe(false);

        // Now resolve file A's stale fix worker result.
        await act(async () => {
            fixDeferred.resolve(
                removeRegionOverlaps({
                    regions: fileA.features![0].data.features as Feature<Polygon>[],
                }),
            );
            await fixPromise;
            await flushMicrotasks();
        });

        // File B must still be loaded, uncorrupted by file A's stale fix.
        expect(env.importPanelProps?.definition.id).toBe("game-b");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
        expect(textOf(container)).not.toContain("The file was changed");
    });

    it("discards a stale fix from file A even while file B is still being read", async () => {
        const fixDeferred = deferred<ReturnType<typeof removeRegionOverlaps>>();
        env.requestGeometry.mockImplementation(async (req: any) => {
            if (req.kind === "regionOverlaps") return findRegionOverlaps(req);
            if (req.kind === "removeRegionOverlaps") return fixDeferred.promise;
            throw new Error(`Unexpected request: ${req.kind}`);
        });

        const fileA = makeDefinition({
            id: "game-a",
            noOverlaps: false,
            regions: [box(0, 1.01, "a"), box(1, 2, "b")],
        });
        const fileBDef = makeDefinition({
            id: "game-b",
            noOverlaps: false,
            regions: [box(0, 1, "c"), box(1, 2, "d")],
        });
        const readB = deferred<string>();
        const slowFileB = {
            name: "game-b.game.json",
            size: 100,
            text: () => readB.promise,
        } as unknown as File;

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(fileA));

        const fixButton = findAll(
            container,
            (n) =>
                n.tagName === "BUTTON" &&
                textOf(n).includes("Fix overlaps and mark"),
        )[0];

        let fixPromise!: Promise<void>;
        await act(async () => {
            fixPromise = reactProps(fixButton).onClick();
            await flushMicrotasks();
        });

        // Start loading file B (still reading its text, so panel A is still mounted).
        const input = findAll(
            container,
            (n) => n.tagName === "INPUT" && reactProps(n).type === "file",
        )[0];
        await act(async () => {
            reactProps(input).onChange({
                target: { files: [slowFileB], value: "" },
            });
            await flushMicrotasks();
        });

        // File A's fix worker finishes BEFORE file B finishes reading.
        await act(async () => {
            fixDeferred.resolve(
                removeRegionOverlaps({
                    regions: fileA.features![0].data.features as Feature<Polygon>[],
                }),
            );
            await fixPromise;
            await flushMicrotasks();
        });

        // Now file B finishes reading; it must win without being cancelled by A's stale fix.
        await act(async () => {
            readB.resolve(JSON.stringify(fileBDef));
            await flushMicrotasks();
        });

        expect(env.importPanelProps?.definition.id).toBe("game-b");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
        expect(textOf(container)).not.toContain("The file was changed");
    });

    it("discards a stale overlap check from file A after loading file B", async () => {
        const checkA = deferred<ReturnType<typeof findRegionOverlaps>>();
        let firstCheck = true;
        env.requestGeometry.mockImplementation(async (req: any) => {
            if (req.kind === "regionOverlaps" && firstCheck) {
                firstCheck = false;
                return checkA.promise;
            }
            if (req.kind === "regionOverlaps") return findRegionOverlaps(req);
            throw new Error(`Unexpected request: ${req.kind}`);
        });

        const fileA = makeDefinition({
            id: "game-a",
            layerName: "LayerA",
            noOverlaps: true,
            regions: [box(0, 1.01, "a"), box(1, 2, "b")],
        });
        const fileB = makeDefinition({
            id: "game-b",
            layerName: "LayerB",
            noOverlaps: true,
            regions: [box(0, 1, "c"), box(1, 2, "d")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(fileA));
        expect(env.importPanelProps?.busy).toBe(true);

        // Load clean file B before file A's overlap check resolves.
        await pickFile(makeFile(fileB));
        expect(env.importPanelProps?.definition.id).toBe("game-b");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();

        // Now resolve file A's overlapping check; file B must remain unblocked.
        await act(async () => {
            checkA.resolve(
                findRegionOverlaps({
                    regions: fileA.features![0].data.features as Feature<Polygon>[],
                }),
            );
            await flushMicrotasks();
        });
        expect(env.importPanelProps?.definition.id).toBe("game-b");
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
    });

    it("blocks a marked layer with identical regions and unblocks via Remove mark", async () => {
        const def = makeDefinition({
            id: "identical-marked",
            layerName: "Districts",
            noOverlaps: true,
            regions: [box(0, 1, "a"), box(0, 1, "b")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(def));

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toContain("Districts");
        expect(textOf(container)).toContain("Can't fix:");
        const removeButtons = buttonsWithText("Remove mark");
        expect(removeButtons).toHaveLength(1);

        await act(async () => {
            await reactProps(removeButtons[0]).onClick();
            await flushMicrotasks();
        });
        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toBeNull();
    });

    it("handles empty-message check errors on marked layers and unreadable files without getting stuck", async () => {
        env.requestGeometry.mockRejectedValueOnce(new Error(""));
        const def = makeDefinition({
            id: "empty-error",
            layerName: "Districts",
            noOverlaps: true,
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });

        await act(async () => {
            root.render(<GameImporter />);
        });
        await pickFile(makeFile(def));

        expect(env.importPanelProps?.busy).toBe(false);
        expect(env.importPanelProps?.blocked).toContain("Districts");
        expect(buttonsWithText("Remove mark")).toHaveLength(1);

        const unreadable = {
            name: "broken.game.json",
            size: 10,
            text: () => Promise.reject(new Error("permission denied")),
        } as unknown as File;
        await pickFile(unreadable);
        expect(textOf(container)).toContain(
            "Couldn't read file: permission denied",
        );
    });
});
