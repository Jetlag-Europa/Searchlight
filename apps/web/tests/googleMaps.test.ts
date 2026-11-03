import { afterEach, expect, it, vi } from "vitest";

import {
    effectiveBasemap,
    type GoogleLook,
    googleLook,
    googleMapTypeOf,
    HIDE_PLACES_STYLES,
} from "@/lib/googleMaps";

const ok = { available: true, problem: null, printing: false } as const;

it("draws Google only when it is available, loads and isn't printed", () => {
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
    expect(effectiveBasemap("google", { ...ok, printing: true })).toBe(
        "voyager",
    );
});

it("leaves the other basemaps alone", () => {
    for (const chosen of ["voyager", "dark", "transport", "osmcarto"])
        expect(
            effectiveBasemap(chosen, {
                available: false,
                problem: "offline",
                printing: true,
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

it("reads an unknown stored map type as Roadmap", () => {
    expect(googleMapTypeOf("satellite")).toBe("satellite");
    expect(googleMapTypeOf("terrain")).toBe("terrain");
    expect(googleMapTypeOf("moon")).toBe("roadmap");
    expect(googleMapTypeOf("toString")).toBe("roadmap");
    expect(googleMapTypeOf("hasOwnProperty")).toBe("roadmap");
    expect(googleMapTypeOf(undefined)).toBe("roadmap");
});

/** A browser with no network: a window, a navigator and a script loader. */
function stubBrowser(onLine: boolean) {
    const win = new EventTarget();
    const scripts: { src: string; onerror?: () => void; remove(): void }[] = [];
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", { onLine });
    vi.stubGlobal("document", {
        createElement: () => ({ remove() {} }),
        head: {
            appendChild: (script: (typeof scripts)[number]) =>
                scripts.push(script),
        },
    });
    return { win, scripts };
}

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
    (win as any).google = { maps: { importLibrary: async () => ({}) } };
    (win as any).__searchlightGoogleMapsReady();
    await vi.waitFor(() => expect(googleMapsProblem.get()).toBeNull());
    await expect(loadGoogleMapsApi()).resolves.toBeUndefined();
    expect(scripts).toHaveLength(1);
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
