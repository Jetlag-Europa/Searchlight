import { afterEach, expect, it, vi } from "vitest";

import { effectiveBasemap } from "@/lib/googleMaps";

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

it("stops trying after Google rejects the key", async () => {
    const { win } = stubBrowser(true);
    const { googleMapsProblem, loadGoogleMapsApi } = await loadModule();
    void loadGoogleMapsApi();
    (win as any).gm_authFailure();
    expect(googleMapsProblem.get()).toBe("auth-failed");
    win.dispatchEvent(new Event("online"));
    expect(googleMapsProblem.get()).toBe("auth-failed");
});
