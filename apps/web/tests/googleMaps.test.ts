import { afterEach, describe, expect, it, vi } from "vitest";

import {
    type GoogleLook,
    googleLook,
    googleMapTypeOf,
    HIDE_PLACES_STYLES,
    TILE_FADE_MS,
    viewTilesShown,
    whenDrawn,
} from "@/lib/googleMaps";

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

/**
 * A Leaflet GridLayer as far as viewTilesShown reads it, at zoom 15 with
 * tiles x 10-12, y 20-21 on screen. Leaflet keeps marking tiles up to two
 * beyond the screen `current`, which these stand-ins mimic.
 */
function fakeGrid(now: number) {
    const tiles: Record<string, { current: boolean; loaded?: number }> = {};
    const grid = {
        _map: { getCenter: () => "center" },
        _tileZoom: 15,
        _tiles: tiles,
        _getTiledPixelBounds: (center: unknown) => ({ center }),
        _pxBoundsToTileRange: () => ({
            min: { x: 10, y: 20 },
            max: { x: 12, y: 21 },
        }),
        _isValidTile: (c: { x: number; y: number; z: number }) => c.y >= 0,
        _tileCoordsToKey: (c: { x: number; y: number; z: number }) =>
            `${c.x}:${c.y}:${c.z}`,
    };
    const loadOnScreen = (at: number) => {
        for (let x = 10; x <= 12; x++)
            for (let y = 20; y <= 21; y++)
                tiles[`${x}:${y}:15`] = { current: true, loaded: at };
    };
    const shown = () => viewTilesShown(grid, (x, y, z) => ({ x, y, z }), now);
    return { grid, tiles, loadOnScreen, shown };
}

describe("viewTilesShown", () => {
    const now = 1_000_000;

    it("needs every tile on screen loaded and faded in", () => {
        const { tiles, loadOnScreen, shown } = fakeGrid(now);
        expect(shown()).toBe(false); // none yet
        loadOnScreen(now - TILE_FADE_MS);
        expect(shown()).toBe(true);
        tiles["11:21:15"] = { current: true }; // one still loading
        expect(shown()).toBe(false);
        tiles["11:21:15"] = { current: true, loaded: now - 50 }; // fading in
        expect(shown()).toBe(false);
        delete tiles["11:21:15"]; // not even requested yet (mid-drag)
        expect(shown()).toBe(false);
    });

    it("ignores a tile just off screen that never arrived", () => {
        // A short pan left this tile in Leaflet's buffer, still `current`,
        // and off screen Google never delivers it.
        const { tiles, loadOnScreen, shown } = fakeGrid(now);
        loadOnScreen(now - TILE_FADE_MS);
        tiles["13:21:15"] = { current: true };
        tiles["9:20:15"] = { current: true };
        expect(shown()).toBe(true);
    });

    it("leaves out columns past the world's edge on a layer that doesn't wrap", () => {
        // EPSG:3857 wraps longitudes, so Leaflet's _isValidTile accepts
        // column 12 although the world at this zoom ends at 11; Google's
        // layer (noWrap) never gets a tile there.
        const { grid, tiles, loadOnScreen, shown } = fakeGrid(now);
        Object.assign(grid, {
            options: { noWrap: true },
            _globalTileRange: { min: { x: 0, y: 0 }, max: { x: 11, y: 40 } },
        });
        loadOnScreen(now - TILE_FADE_MS);
        delete tiles["12:20:15"];
        delete tiles["12:21:15"];
        expect(shown()).toBe(true);
        // A layer that wraps would load it: still needed there.
        (grid as any).options.noWrap = false;
        expect(shown()).toBe(false);
    });

    it("waits while the map zooms", () => {
        const { grid, loadOnScreen, shown } = fakeGrid(now);
        loadOnScreen(now - TILE_FADE_MS);
        (grid._map as any)._animatingZoom = true;
        expect(shown()).toBe(false);
    });

    it("isn't shown without a map or a tile zoom", () => {
        const { grid, loadOnScreen, shown } = fakeGrid(now);
        loadOnScreen(now - TILE_FADE_MS);
        (grid as any)._tileZoom = undefined;
        expect(shown()).toBe(false);
        (grid as any)._tileZoom = 15;
        (grid as any)._map = null;
        expect(shown()).toBe(false);
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

it("keeps Google's map offline once it has drawn", async () => {
    // CARTO, as the stand-in, has hardly any tiles cached for a Google user.
    const { win } = stubBrowser(true);
    const { googleMapsProblem, googleMapDrawn } = await loadModule();
    googleMapDrawn();
    win.dispatchEvent(new Event("offline"));
    expect(googleMapsProblem.get()).toBeNull();
    win.dispatchEvent(new Event("online"));
    expect(googleMapsProblem.get()).toBeNull();
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

it("notes a Google module failing before the map has drawn, without giving up on it", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, googleModuleFailed, loadGoogleMapsApi } =
        await loadModule();
    const load = loadGoogleMapsApi();
    arrive(win);
    await expect(load).resolves.toBeUndefined();

    // The API loaded, but a module didn't: maybe one the map needs to draw,
    // maybe not (stats). CARTO stands in either way; Google stays on.
    scriptFailed(win, MAP_MODULE);
    expect(googleModuleFailed.get()).toBe(true);
    expect(googleMapsProblem.get()).toBeNull();
});

it("drops the module note once Google's map has drawn after all", async () => {
    const { win } = stubBrowser(true);
    const { googleModuleFailed, loadGoogleMapsApi, googleMapDrawn } =
        await loadModule();
    const load = loadGoogleMapsApi();
    arrive(win);
    await load;
    scriptFailed(win, MAP_MODULE); // a module it didn't need
    googleMapDrawn();
    expect(googleModuleFailed.get()).toBe(false);
});

it("ignores a Google module failing once the map has drawn", async () => {
    const { win } = stubBrowser(true);
    const { googleModuleFailed, loadGoogleMapsApi, googleMapDrawn } =
        await loadModule();
    const load = loadGoogleMapsApi();
    arrive(win);
    await load;
    googleMapDrawn();

    scriptFailed(win, MAP_MODULE);
    expect(googleModuleFailed.get()).toBe(false);
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
