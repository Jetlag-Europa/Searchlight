// The join and play pages (an invite or spectator link, a game link) on a
// connection that hangs: each request gives up after a while and the page
// offers Try again, and coming back online tries again at once. Runs each
// page's own inline script against a minimal stand-in for its elements.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// How long the pages wait on a request (DEADLINE_MS in their scripts).
const DEADLINE_MS = 15_000;

interface FakeElement {
    classes: Set<string>;
    classList: {
        add(name: string): void;
        remove(name: string): void;
        contains(name: string): boolean;
        replace(from: string, to: string): void;
    };
    textContent: string;
    value: string;
    disabled: boolean;
    listeners: Map<string, (event: unknown) => unknown>;
    addEventListener(type: string, listener: (event: unknown) => unknown): void;
    focus(): void;
}

function element(hidden: boolean): FakeElement {
    const classes = new Set(hidden ? ["hidden"] : []);
    const listeners = new Map<string, (event: unknown) => unknown>();
    return {
        classes,
        classList: {
            add: (name) => void classes.add(name),
            remove: (name) => void classes.delete(name),
            contains: (name) => classes.has(name),
            replace: (from, to) => {
                classes.delete(from);
                classes.add(to);
            },
        },
        textContent: "",
        value: "",
        disabled: false,
        listeners,
        addEventListener: (type, listener) => listeners.set(type, listener),
        focus() {},
    };
}

// Opens `page` with a link token: its script runs, with `fetch` for the
// network.
function open(page: "join" | "play", fetch: typeof globalThis.fetch) {
    const source = readFileSync(
        new URL(`../src/pages/${page}.astro`, import.meta.url),
        "utf8",
    );
    const script = source
        .split("<script define:vars={{ apiBase }}>")[1]
        .split("</script>")[0];
    // Every element with an id, hidden as the markup has it.
    const elements = new Map<string, FakeElement>();
    for (const [, attributes] of source.matchAll(
        /<\w+\s([^>]*\bid="[^"]+"[^>]*)>/g,
    )) {
        const id = attributes.match(/\bid="([^"]+)"/)![1];
        const classes = attributes.match(/\bclass="([^"]*)"/)?.[1] ?? "";
        elements.set(id, element(classes.split(/\s+/).includes("hidden")));
    }
    const windowListeners = new Map<string, () => void>();
    const location = {
        search: "?token=t1",
        pathname: `/${page}`,
        href: `http://localhost/${page}?token=t1`,
    };
    const window = {
        location,
        addEventListener: (type: string, listener: () => void) =>
            windowListeners.set(type, listener),
    };
    const document = { getElementById: (id: string) => elements.get(id) };
    new Function(
        "apiBase",
        "document",
        "window",
        "location",
        "fetch",
        "localStorage",
        script,
    )("http://api", document, window, location, fetch, {
        setItem() {},
    });
    const shown = (id: string) => !elements.get(id)!.classes.has("hidden");
    return { elements, windowListeners, location, shown };
}

// Answers like the API, or never: a request that hangs until it's given up.
const LINK_INFO = {
    join: { valid: true, linkType: "join", sessionName: "S", gameName: "G" },
    play: { valid: true, gameName: "G", serverName: "Server" },
};
let hang = false;
const fetchMock = vi.fn(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (hang) {
            return new Promise((_, reject) =>
                init?.signal?.addEventListener("abort", () =>
                    reject(new DOMException("Aborted", "AbortError")),
                ),
            );
        }
        if (url.endsWith("/me")) {
            return Promise.resolve(Response.json({ user: {} }));
        }
        if (init?.method === "POST") {
            return Promise.resolve(Response.json({ id: "s1", sessionId: "s1" }));
        }
        const page = url.includes("/game-links/") ? "play" : "join";
        return Promise.resolve(Response.json(LINK_INFO[page]));
    },
);

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hang = false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe.each(["join", "play"] as const)("the %s page", (page) => {
    it("says it can't reach Searchlight when the link hangs, and tries again", async () => {
        hang = true;
        const { elements, shown } = open(page, fetchMock);
        await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
        expect(shown("loading")).toBe(true);
        expect(shown("unreachable")).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await settle();
        expect(shown("loading")).toBe(false);
        expect(shown("unreachable")).toBe(true);

        hang = false;
        elements.get("retry-btn")!.listeners.get("click")!({});
        await settle();
        expect(shown("unreachable")).toBe(false);
        expect(shown("valid")).toBe(true);
    });

    it("tries again at once when the device is back online", async () => {
        hang = true;
        const { windowListeners, shown } = open(page, fetchMock);
        await settle();

        hang = false;
        windowListeners.get("online")!();
        await settle();
        expect(shown("loading")).toBe(false);
        expect(shown("valid")).toBe(true);
        // The try it replaced doesn't change the page when it gives up.
        await vi.advanceTimersByTimeAsync(DEADLINE_MS);
        await settle();
        expect(shown("valid")).toBe(true);
        expect(shown("unreachable")).toBe(false);
    });

    it("lets the player try again when joining or starting hangs", async () => {
        const { elements, shown, location } = open(page, fetchMock);
        await settle();
        expect(shown("valid")).toBe(true);

        hang = true;
        const button = elements.get(
            page === "join" ? "redeem-btn" : "start-btn",
        )!;
        if (page === "join") {
            void button.listeners.get("click")!({});
        } else {
            void elements.get("valid")!.listeners.get("submit")!({
                preventDefault() {},
            });
        }
        await settle();
        expect(button.disabled).toBe(true);

        await vi.advanceTimersByTimeAsync(DEADLINE_MS);
        await settle();
        expect(button.disabled).toBe(false);
        expect(shown(page === "join" ? "redeem-error" : "error")).toBe(true);
        expect(location.href).toBe(`http://localhost/${page}?token=t1`);
    });
});
