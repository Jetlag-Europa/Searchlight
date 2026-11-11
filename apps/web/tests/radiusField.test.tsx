// The radar card's radius field, rendered with React into a minimal
// stand-in for the DOM (there is no DOM library here), typed into at the
// speeds that used to lose an edit. The field saves 500 ms after the last
// keystroke or on blur; a radius only counts above zero.
import { useStore } from "@nanostores/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Just enough of the DOM for react-dom to render the card.
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
        private _value = "";
        listeners = new Map<string, Set<(...args: any[]) => void>>();
        constructor(
            public nodeType: number,
            public nodeName: string,
            public ownerDocument: FakeNode | null,
            public namespaceURI = "http://www.w3.org/1999/xhtml",
        ) {}
        get tagName() {
            return this.nodeName;
        }
        get value() {
            return this._value;
        }
        set value(v: string) {
            this._value = String(v);
        }
        get className() {
            return this.attributes.get("class") ?? "";
        }
        set className(v: string) {
            this.attributes.set("class", String(v));
        }
        get options() {
            return this.childNodes.filter((n) => n.nodeName === "OPTION");
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
            if (name === "value") this._value = String(value);
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
        addEventListener(type: string, fn: (...args: any[]) => void) {
            let set = this.listeners.get(type);
            if (!set) this.listeners.set(type, (set = new Set()));
            set.add(fn);
        }
        removeEventListener(type: string, fn: (...args: any[]) => void) {
            this.listeners.get(type)?.delete(fn);
        }
        focus() {}
        blur() {}
        closest() {
            return null;
        }
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
        querySelector() {
            return null;
        }
        createDocumentFragment() {
            return new FakeDocumentFragment(this);
        }
    }
    class FakeDocumentFragment extends FakeNode {
        constructor(ownerDocument: FakeNode | null = document) {
            super(11, "#document-fragment", ownerDocument);
        }
    }
    const document = new FakeDocument();
    const window = Object.assign(new EventTarget(), {
        document,
        HTMLIFrameElement: class {},
        HTMLElement: FakeNode,
        HTMLInputElement: FakeNode,
        HTMLSelectElement: FakeNode,
        DocumentFragment: FakeDocumentFragment,
        setTimeout: globalThis.setTimeout.bind(globalThis),
        clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    document.defaultView = window;
    const store = new Map<string, string>();
    const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        get length() {
            return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
    };
    Object.assign(globalThis, {
        window,
        document,
        localStorage: storage,
        sessionStorage: storage,
        DocumentFragment: FakeDocumentFragment,
        HTMLElement: FakeNode,
        HTMLInputElement: FakeNode,
        HTMLSelectElement: FakeNode,
        IS_REACT_ACT_ENVIRONMENT: true,
    });
    return { document, FakeNode, store };
});

import { RadiusQuestionComponent } from "@/components/cards/radius";
import { setActiveGameDefinition } from "@/game-definition/store";
import { autoSave, hiderMode, isLoading, questions } from "@/lib/context";

// Renders each radar card as the sidebar does: keyed by question, fed the
// question's current data.
const Cards = () => {
    const $questions = useStore(questions);
    return (
        <>
            {$questions.map((question: any) => (
                <RadiusQuestionComponent
                    key={question.key}
                    data={question.data}
                    questionKey={question.key}
                />
            ))}
        </>
    );
};

const radar = (key: number, data: Record<string, unknown> = {}): any => ({
    id: "radius",
    key,
    data: {
        lat: 59.33,
        lng: 18.06,
        radius: 5,
        unit: "kilometers",
        within: true,
        drag: true,
        color: "red",
        collapsed: false,
        enabled: true,
        ...data,
    },
});

// A game declaring three radar sizes, so the card shows its quick picks.
const game = {
    id: "radius-field",
    name: "Radius field",
    serverId: "home-games",
    radars: [1, 5, 10],
    unit: "kilometers",
    map: {
        center: [18.06, 59.33],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 500,
        unit: "meters",
        features: { type: "FeatureCollection", features: [] },
    },
} as any;

let container: any;
let root: Root;

const render = (...list: any[]) => {
    questions.set(list);
    act(() => root.render(<Cards />));
};
const reactProps = (node: any): Record<string, any> =>
    node[Object.keys(node).find((k) => k.startsWith("__reactProps$"))!];
// The radius field of the nth card.
const field = (index = 0) =>
    [...container.walk()].filter(
        (node: any) =>
            node.nodeName === "INPUT" && node.className.includes("w-16"),
    )[index];
const shown = (index = 0) => String(reactProps(field(index)).value);
const disabled = () => reactProps(field()).disabled;
const type = (value: string) =>
    act(() => reactProps(field()).onChange({ target: { value } }));
const blur = () => act(() => reactProps(field()).onBlur({}));
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const stored = () => (questions.get()[0].data as { radius: number }).radius;
// What the server sends when a teammate edits the radar: new data.
const teammateSets = (data: Record<string, unknown>) =>
    act(() => {
        const [question]: any[] = questions.get();
        questions.set([{ ...question, data: { ...question.data, ...data } }]);
    });
// The quick pick's own handler, as a click on "10 km" runs it.
const quickPick = (value: string) => {
    const visit = (fiber: any): any =>
        fiber &&
        (String(fiber.memoizedProps?.className ?? "").includes("grid-cols-3") &&
        fiber.memoizedProps.onValueChange
            ? fiber.memoizedProps
            : visit(fiber.child) || visit(fiber.sibling));
    const rootKey = Object.keys(container).find((k) =>
        k.startsWith("__reactContainer$"),
    )!;
    const props = visit(container[rootKey]);
    act(() => props.onValueChange(value));
};

beforeEach(() => {
    vi.useFakeTimers();
    setActiveGameDefinition(game);
    isLoading.set(false);
    hiderMode.set(false);
    autoSave.set(true);
    container = env.document.createElement("div");
    env.document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    env.document.body.removeChild(container);
    vi.useRealTimers();
    setActiveGameDefinition(null);
    questions.set([]);
});

describe("the radar's radius field", () => {
    it("shows 0 and 0. on the way to 0.5, and never saves zero", () => {
        render(radar(1));
        type("0");
        wait(500);
        expect([shown(), stored()]).toEqual(["0", 5]);
        type("0.");
        wait(500);
        expect([shown(), stored()]).toEqual(["0.", 5]);
        type("0.5");
        wait(500);
        expect([shown(), stored()]).toEqual(["0.5", 0.5]);
        blur();
        expect([shown(), stored()]).toEqual(["0.5", 0.5]);
    });

    it("saves 500 ms after the last keystroke, not on every digit", () => {
        render(radar(1));
        type("2");
        wait(300);
        type("25");
        wait(300);
        expect([shown(), stored()]).toEqual(["25", 5]);
        wait(200);
        expect([shown(), stored()]).toEqual(["25", 25]);
    });

    for (const text of ["0", "", "-3"])
        it(`keeps the radius for ${JSON.stringify(text)}, and shows it again on blur`, () => {
            render(radar(1));
            type(text);
            wait(500);
            expect([shown(), stored()]).toEqual([text, 5]);
            blur();
            wait(1000);
            expect([shown(), stored()]).toEqual(["5", 5]);
        });

    it("doesn't bring a 0 back after a quick blur", () => {
        render(radar(1));
        type("0");
        wait(100);
        blur();
        wait(1000);
        expect([shown(), stored()]).toEqual(["5", 5]);
    });

    it("saves the last edit when the field loses focus straight after it", () => {
        render(radar(1));
        type("2");
        wait(500);
        expect(stored()).toBe(2);
        type("25");
        wait(100);
        blur();
        expect([shown(), stored()]).toEqual(["25", 25]);
        wait(1000);
        expect([shown(), stored()]).toEqual(["25", 25]);
    });

    it("saves 0.5 typed after a saved-over 0 and a quick blur", () => {
        render(radar(1));
        type("0");
        wait(500);
        type("0.5");
        wait(100);
        blur();
        wait(1000);
        expect([shown(), stored()]).toEqual(["0.5", 0.5]);
    });

    it("saves the last radius above zero typed, even if the field was then cleared", () => {
        render(radar(1));
        type("25");
        wait(100);
        type("");
        blur();
        expect([shown(), stored()]).toEqual(["25", 25]);
    });

    it("shows a teammate's radius at once, and drops the unsaved edit", () => {
        render(radar(1));
        type("2");
        wait(100);
        teammateSets({ radius: 10 });
        expect([shown(), stored()]).toEqual(["10", 10]);
        wait(1000);
        blur();
        expect([shown(), stored()]).toEqual(["10", 10]);
    });

    it("shows a teammate's radius over a saved edit without a blur", () => {
        render(radar(1));
        type("2");
        wait(500);
        expect([shown(), stored()]).toEqual(["2", 2]);
        teammateSets({ radius: 10 });
        expect([shown(), stored()]).toEqual(["10", 10]);
    });

    it("shows the stored radius when a teammate locks the card mid-edit", () => {
        // WebKit doesn't blur a focused field that becomes disabled.
        render(radar(1));
        type("0");
        teammateSets({ radius: 10, drag: false });
        expect([shown(), disabled()]).toEqual(["10", true]);
        type("2");
        wait(100);
        teammateSets({ drag: false });
        wait(1000);
        expect([shown(), stored()]).toEqual(["10", 10]);
    });

    it("shows a quick pick over what was typed", () => {
        render(radar(1));
        type("0");
        quickPick("2");
        expect([shown(), stored()]).toEqual(["10", 10]);
        type("2");
        wait(100);
        blur();
        quickPick("0");
        wait(1000);
        expect([shown(), stored()]).toEqual(["1", 1]);
    });

    it("saves an edit the card unmounts under", () => {
        render(radar(1));
        type("25");
        wait(100);
        act(() => root.render(<></>));
        expect(stored()).toBe(25);
    });
});

describe("a stored radar with a radius of 0 or less", () => {
    for (const radius of [-3, 0, null])
        it(`(${radius}) leaves its own card and the others usable`, () => {
            render(radar(1), radar(2, { radius }));
            expect(shown(0)).toBe("5");
            expect(shown(1)).toBe(String(radius ?? ""));
        });

    it("can be corrected in its card", () => {
        render(radar(1, { radius: -3 }));
        type("2");
        blur();
        expect([shown(), stored()]).toEqual(["2", 2]);
    });
});
