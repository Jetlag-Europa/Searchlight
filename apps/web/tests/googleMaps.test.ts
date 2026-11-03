import { afterEach, describe, expect, it, vi } from "vitest";

import {
    effectiveBasemap,
    type GoogleLook,
    googleLook,
    googleMapTypeOf,
    HIDE_PLACES_STYLES,
    TILE_FADE_MS,
    whenDrawn,
} from "@/lib/googleMaps";

const ok = { available: true, problem: null } as const;

it("draws Google only when it is available and loads", () => {
    expect(effectiveBasemap("google", ok)).toBe("google");
    expect(effectiveBasemap("google", { ...ok, available: false })).toBe(
        "voyager",
    );
    expect(effectiveBasemap("google", { ...ok, problem: "offline" })).toBe(
        "voyager",
    );
    expect(effectiveBasemap("google", { ...ok, problem: "auth-failed" })).toBe(
        "voyager",
    );
});

it("leaves the other basemaps alone", () => {
    for (const chosen of ["voyager", "dark", "transport", "osmcarto"])
        expect(
            effectiveBasemap(chosen, {
                available: false,
                problem: "offline",
            }),
        ).toBe(chosen);
});

/** googleLook against a fake GoogleMutant that logs what it's asked. */
function fakeLook(initial: GoogleLook) {
    const calls: string[] = [];
    const apply = googleLook(
        {
            setMapType: (type) => calls.push(`type ${type}`),
            setStyles: (styles) => calls.push(`styles ${styles.length}`),
            addGoogleLayer: (name) => calls.push(`add ${name}`),
            removeGoogleLayer: (name) => calls.push(`remove ${name}`),
        },
        () => calls.push("redraw"),
        initial,
    );
    return { calls, apply };
}

const roadmap: GoogleLook = {
    type: "roadmap",
    transit: false,
    hidePlaces: false,
};

it("switches Google's transit lines only when the setting changes", () => {
    const { calls, apply } = fakeLook(roadmap);
    apply(roadmap); // as created: nothing to do
    apply({ ...roadmap, transit: true });
    apply({ ...roadmap, transit: true }); // a second TransitLayer would draw the lines twice
    apply(roadmap);
    apply(roadmap);
    apply({ ...roadmap, transit: true });
    expect(calls).toEqual([
        "add TransitLayer",
        "redraw",
        "remove TransitLayer",
        "redraw",
        "add TransitLayer",
        "redraw",
    ]);
});

it("changes map type and places on the same map, one redraw per change", () => {
    const { calls, apply } = fakeLook({ ...roadmap, type: "hybrid" });
    apply({ ...roadmap, type: "hybrid" });
    expect(calls).toEqual([]); // created as hybrid already
    apply({ type: "satellite", transit: true, hidePlaces: true });
    expect(calls).toEqual([
        "type satellite",
        `styles ${HIDE_PLACES_STYLES.length}`,
        "add TransitLayer",
        "redraw",
    ]);
    calls.length = 0;
    apply({ type: "terrain", transit: true, hidePlaces: false });
    expect(calls).toEqual(["type terrain", "styles 0", "redraw"]);
});

it("doesn't redraw for lines or places on Satellite, where Google shows none", () => {
    const { calls, apply } = fakeLook({ ...roadmap, type: "satellite" });
    apply({ type: "satellite", transit: true, hidePlaces: true });
    expect(calls).toEqual([
        `styles ${HIDE_PLACES_STYLES.length}`,
        "add TransitLayer",
    ]);
    calls.length = 0;
    apply({ type: "hybrid", transit: true, hidePlaces: true });
    expect(calls).toEqual(["type hybrid", "redraw"]);
});

it("reads an unknown stored map type as Roadmap", () => {
    expect(googleMapTypeOf("satellite")).toBe("satellite");
    expect(googleMapTypeOf("terrain")).toBe("terrain");
    expect(googleMapTypeOf("moon")).toBe("roadmap");
    expect(googleMapTypeOf("toString")).toBe("roadmap");
    expect(googleMapTypeOf("hasOwnProperty")).toBe("roadmap");
    expect(googleMapTypeOf(undefined)).toBe("roadmap");
});

/** Just enough of a Leaflet tile layer for whenDrawn: events and a view. */
function fakeTileLayer() {
    const listeners = new Map<string, Set<() => void>>();
    const layer = {
        // Whether every tile of the current view has loaded.
        ready: false,
        redrawing: false,
        on(type: string, fn: () => void) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
        },
        off(type: string, fn: () => void) {
            listeners.get(type)?.delete(fn);
        },
        fire(type: string) {
            for (const fn of [...(listeners.get(type) ?? [])]) fn();
        },
        listening: () =>
            [...listeners.values()].reduce((n, set) => n + set.size, 0),
    };
    const drawn = vi.fn();
    const stop = whenDrawn(
        layer,
        () => layer.ready,
        () => layer.redrawing,
        drawn,
    );
    return { layer, drawn, stop };
}

describe("whenDrawn", () => {
    afterEach(() => vi.useRealTimers());

    it("counts the layer drawn once its view has loaded and faded in", () => {
        vi.useFakeTimers();
        const { layer, drawn } = fakeTileLayer();
        layer.fire("loading");
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        expect(drawn).not.toHaveBeenCalled();
        layer.ready = true;
        layer.fire("load");
        vi.advanceTimersByTime(TILE_FADE_MS - 1);
        expect(drawn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(drawn).toHaveBeenCalledTimes(1);
        expect(layer.listening()).toBe(0);
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        expect(drawn).toHaveBeenCalledTimes(1);
    });

    it("waits again when the view changes before the tiles have faded in", () => {
        vi.useFakeTimers();
        const { layer, drawn } = fakeTileLayer();
        layer.ready = true;
        layer.fire("load");
        vi.advanceTimersByTime(100);
        layer.ready = false; // e.g. the game's view is fitted
        layer.fire("loading");
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        expect(drawn).not.toHaveBeenCalled();
        layer.ready = true;
        layer.fire("tileload");
        vi.advanceTimersByTime(TILE_FADE_MS);
        expect(drawn).toHaveBeenCalledTimes(1);
    });

    it("waits for the tiles of a pending redraw", () => {
        vi.useFakeTimers();
        const { layer, drawn } = fakeTileLayer();
        layer.ready = true;
        layer.redrawing = true; // tiles from before the transit lines
        layer.fire("load");
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        expect(drawn).not.toHaveBeenCalled();
        layer.redrawing = false;
        layer.fire("loading");
        layer.fire("load");
        vi.advanceTimersByTime(TILE_FADE_MS);
        expect(drawn).toHaveBeenCalledTimes(1);
    });

    it("waits for a redraw that starts while the tiles fade in", () => {
        vi.useFakeTimers();
        const { layer, drawn } = fakeTileLayer();
        layer.ready = true;
        layer.fire("load");
        vi.advanceTimersByTime(100);
        layer.redrawing = true; // e.g. the server's preferences arrive
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        expect(drawn).not.toHaveBeenCalled();
        layer.redrawing = false;
        layer.fire("load");
        vi.advanceTimersByTime(TILE_FADE_MS);
        expect(drawn).toHaveBeenCalledTimes(1);
    });

    it("notices a loaded view without a load event", () => {
        // A tile of an earlier view that never arrives keeps Leaflet from
        // firing "load"; it is dropped without an event.
        vi.useFakeTimers();
        const { layer, drawn } = fakeTileLayer();
        layer.fire("loading");
        vi.advanceTimersByTime(TILE_FADE_MS * 4);
        layer.ready = true;
        vi.advanceTimersByTime(TILE_FADE_MS * 3);
        expect(drawn).toHaveBeenCalledTimes(1);
    });

    it("stops waiting when told to", () => {
        vi.useFakeTimers();
        const { layer, drawn, stop } = fakeTileLayer();
        layer.ready = true;
        layer.fire("load");
        stop();
        vi.advanceTimersByTime(TILE_FADE_MS * 8);
        layer.fire("load");
        vi.advanceTimersByTime(TILE_FADE_MS * 8);
        expect(drawn).not.toHaveBeenCalled();
        expect(layer.listening()).toBe(0);
    });
});

/** A browser with no network: a window, a navigator and a script loader. */
function stubBrowser(onLine: boolean) {
    const win = new EventTarget();
    const scripts: { src: string; onerror?: () => void; remove(): void }[] = [];
    vi.stubGlobal("window", win);
    const nav = { onLine };
    vi.stubGlobal("navigator", nav);
    vi.stubGlobal("document", {
        createElement: () => ({ remove() {} }),
        head: {
            appendChild: (script: (typeof scripts)[number]) =>
                scripts.push(script),
        },
    });
    /** The browser's connection changes, as the browser reports it. */
    const setOnline = (online: boolean) => {
        nav.onLine = online;
        win.dispatchEvent(new Event(online ? "online" : "offline"));
    };
    return { win, scripts, setOnline };
}

/** Google's loader arriving: the API, then its ready callback. */
function arrive(win: EventTarget) {
    (win as any).google = { maps: { importLibrary: async () => ({}) } };
    (win as any).__searchlightGoogleMapsReady();
}

/** A script of Google's failing to load, as the window sees it. */
function scriptFailed(win: EventTarget, src: string) {
    const failed = new Event("error");
    Object.defineProperty(failed, "target", {
        value: { tagName: "SCRIPT", src, remove() {} },
    });
    win.dispatchEvent(failed);
}

const MAP_MODULE =
    "https://maps.googleapis.com/maps-api-v3/api/js/66/12d/map.js";

/** googleMaps.ts reads the connection and listens for changes on import. */
async function loadModule() {
    vi.resetModules();
    return import("@/lib/googleMaps");
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("falls back while offline and comes back online", async () => {
    const { win } = stubBrowser(false);
    const { googleMapsProblem } = await loadModule();
    expect(googleMapsProblem.get()).toBe("offline");
    win.dispatchEvent(new Event("online"));
    expect(googleMapsProblem.get()).toBeNull();
    win.dispatchEvent(new Event("offline"));
    expect(googleMapsProblem.get()).toBe("offline");
});

it("retries a script that failed to load once back online", async () => {
    const { win, scripts } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();

    const first = loadGoogleMapsApi();
    expect(loadGoogleMapsApi()).toBe(first); // one load per page
    scripts[0].onerror?.();
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("load-failed");

    win.dispatchEvent(new Event("online"));
    expect(googleMapsProblem.get()).toBeNull();
    void loadGoogleMapsApi().catch(() => {});
    expect(scripts).toHaveLength(2);
});

it("gives up on a stalled load, then waits for that script on retry", async () => {
    vi.useFakeTimers();
    const { win, scripts } = stubBrowser(true);
    const {
        GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        googleMapsProblem,
        loadGoogleMapsApi,
    } = await loadModule();

    const first = loadGoogleMapsApi();
    vi.advanceTimersByTime(GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("load-failed");

    // Back online, the stalled script finally arrives: no second script.
    win.dispatchEvent(new Event("online"));
    const retry = loadGoogleMapsApi();
    expect(scripts).toHaveLength(1);
    (win as any).google = { maps: { importLibrary: async () => ({}) } };
    (win as any).__searchlightGoogleMapsReady();
    await expect(retry).resolves.toBeUndefined();
    expect(googleMapsProblem.get()).toBeNull();
});

it("shows Google after all when a timed-out load finishes late", async () => {
    vi.useFakeTimers();
    const { win, scripts } = stubBrowser(true);
    const {
        GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        googleMapsProblem,
        loadGoogleMapsApi,
    } = await loadModule();

    const first = loadGoogleMapsApi();
    vi.advanceTimersByTime(GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("load-failed");

    // No offline/online in between: the browser never noticed.
    arrive(win);
    await vi.waitFor(() => expect(googleMapsProblem.get()).toBeNull());
    await expect(loadGoogleMapsApi()).resolves.toBeUndefined();
    expect(scripts).toHaveLength(1);
});

it("stays on CARTO when a timed-out load finishes late while offline", async () => {
    vi.useFakeTimers();
    const { win, scripts, setOnline } = stubBrowser(true);
    const {
        GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        googleMapsProblem,
        loadGoogleMapsApi,
    } = await loadModule();

    const first = loadGoogleMapsApi();
    setOnline(false);
    expect(googleMapsProblem.get()).toBe("offline");
    vi.advanceTimersByTime(GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("offline"); // not "load-failed"

    arrive(win); // still offline
    await vi.runAllTimersAsync();
    expect(googleMapsProblem.get()).toBe("offline");

    // Back online: Google again, from the script already in the page.
    setOnline(true);
    expect(googleMapsProblem.get()).toBeNull();
    await expect(loadGoogleMapsApi()).resolves.toBeUndefined();
    expect(scripts).toHaveLength(1);
});

it("waits for the connection when a load fails, goes offline, then finishes", async () => {
    vi.useFakeTimers();
    const { win, scripts, setOnline } = stubBrowser(true);
    const {
        GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        googleMapsProblem,
        loadGoogleMapsApi,
    } = await loadModule();

    const first = loadGoogleMapsApi();
    vi.advanceTimersByTime(GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("load-failed");
    setOnline(false);
    arrive(win);
    await vi.runAllTimersAsync();
    expect(googleMapsProblem.get()).toBe("load-failed");

    setOnline(true);
    expect(googleMapsProblem.get()).toBeNull();
    await expect(loadGoogleMapsApi()).resolves.toBeUndefined();
    expect(scripts).toHaveLength(1);
});

it("keeps a rejected key rejected when the load also times out", async () => {
    vi.useFakeTimers();
    const { win } = stubBrowser(true);
    const {
        GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        googleMapsProblem,
        loadGoogleMapsApi,
    } = await loadModule();

    const first = loadGoogleMapsApi();
    (win as any).gm_authFailure();
    vi.advanceTimersByTime(GOOGLE_MAPS_LOAD_TIMEOUT_MS);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("auth-failed");
    arrive(win);
    await vi.runAllTimersAsync();
    expect(googleMapsProblem.get()).toBe("auth-failed");
});

it("starts a new loader once Google's main script has failed", async () => {
    const { win, scripts, setOnline } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();

    const first = loadGoogleMapsApi();
    // The loader ran, defining what it does before the main script...
    (win as any).google = {
        maps: { __gjsload__() {}, Load() {}, modules: {} },
    };
    // ...but the main script it added failed: no timeout wait.
    const failed = new Event("error");
    Object.defineProperty(failed, "target", {
        value: {
            tagName: "SCRIPT",
            src: "https://maps.googleapis.com/maps-api-v3/api/js/66/12d/main.js",
            remove() {},
        },
    });
    win.dispatchEvent(failed);
    await expect(first).rejects.toThrow();
    expect(googleMapsProblem.get()).toBe("load-failed");

    setOnline(true);
    const retry = loadGoogleMapsApi();
    expect(scripts).toHaveLength(2);
    arrive(win);
    await expect(retry).resolves.toBeUndefined();
    expect(googleMapsProblem.get()).toBeNull();
});

it("ignores errors from other scripts", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();
    const first = loadGoogleMapsApi();
    const failed = new Event("error");
    Object.defineProperty(failed, "target", {
        value: {
            tagName: "SCRIPT",
            src: "https://example.com/other.js",
            remove() {},
        },
    });
    win.dispatchEvent(failed);
    arrive(win);
    await expect(first).resolves.toBeUndefined();
    expect(googleMapsProblem.get()).toBeNull();
});

it("loads Google's quarterly release", async () => {
    const { scripts } = stubBrowser(true);
    const { loadGoogleMapsApi } = await loadModule();
    void loadGoogleMapsApi().catch(() => {});
    const params = new URL(scripts[0].src).searchParams;
    expect(params.get("v")).toBe("quarterly");
});

it("falls back when a Google module fails before the map has drawn", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();
    const load = loadGoogleMapsApi();
    arrive(win);
    await expect(load).resolves.toBeUndefined();

    // The API loaded, but the module the map needs to draw didn't.
    scriptFailed(win, MAP_MODULE);
    expect(googleMapsProblem.get()).toBe("load-failed");
});

it("ignores a Google module failing once the map has drawn", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi, googleMapDrawn } =
        await loadModule();
    const load = loadGoogleMapsApi();
    arrive(win);
    await load;
    googleMapDrawn();

    scriptFailed(win, MAP_MODULE);
    expect(googleMapsProblem.get()).toBeNull();
});

it("stops trying after Google rejects the key", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();
    void loadGoogleMapsApi();
    (win as any).gm_authFailure();
    expect(googleMapsProblem.get()).toBe("auth-failed");
    win.dispatchEvent(new Event("online"));
    expect(googleMapsProblem.get()).toBe("auth-failed");
});
