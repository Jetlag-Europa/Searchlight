import { atom } from "nanostores";

// Google Maps as a basemap, so seekers see the same footpaths as in the
// Google Maps app (hiding spots are defined by them). It is drawn by the Maps
// JavaScript API, which bills per map load rather than per tile, through
// GoogleMutant (components/GoogleBasemap.tsx).
//
// Baked in at build time; without it the option isn't offered. It ships to
// the browser like the CARTO key, so restrict it in Google Cloud to the site's
// referrers and the Maps JavaScript API, and cap its daily map loads.
export const GOOGLE_MAPS_API_KEY = (import.meta.env
    .PUBLIC_GOOGLE_MAPS_API_KEY ?? "") as string;

export const googleMapsAvailable = GOOGLE_MAPS_API_KEY !== "";

/**
 * Why Google's map can't be shown right now, if it can't. "offline" clears
 * when the browser is back online, and "load-failed" is tried again then;
 * "auth-failed" lasts until a reload.
 */
export type GoogleMapsProblem = "offline" | "load-failed" | "auth-failed";
export const googleMapsProblem = atom<GoogleMapsProblem | null>(
    typeof navigator !== "undefined" && navigator.onLine === false
        ? "offline"
        : null,
);

/** The basemap to draw for the chosen one: CARTO whenever Google can't be. */
export function effectiveBasemap<T extends string>(
    chosen: T,
    {
        available,
        problem,
    }: {
        available: boolean;
        problem: GoogleMapsProblem | null;
    },
): T | "voyager" {
    if (chosen !== "google") return chosen;
    return available && !problem ? chosen : "voyager";
}

if (typeof window !== "undefined") {
    // Without a connection Google's map can't load, and its tiles may not be
    // cached by us, so the map falls back to CARTO's cached tiles meanwhile.
    window.addEventListener("offline", () => {
        if (!googleMapsProblem.get()) googleMapsProblem.set("offline");
    });
    window.addEventListener("online", () => {
        const problem = googleMapsProblem.get();
        if (problem === "offline") googleMapsProblem.set(null);
        // The script may have failed for want of a connection: try again
        // (a failed load leaves no promise behind, see loadGoogleMapsApi).
        if (problem === "load-failed") googleMapsProblem.set(null);
    });
}

// A bad connection can stall the script without failing it. Past this the
// map shows CARTO, and Google is tried again once the browser is back online.
export const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 15_000;

let apiLoad: Promise<void> | null = null;
// The loader script while it's in the page and hasn't failed. A retry waits
// for it rather than adding another: Google warns against loading it twice.
let script: HTMLScriptElement | null = null;
// Fails the load waiting for that script.
let failLoader: ((error: Error) => void) | null = null;

/** The loader, or the main script it adds, failed: the next try starts over. */
function loaderFailed(): void {
    script?.remove();
    script = null;
    failLoader?.(new Error("The Maps JavaScript API didn't load"));
    failLoader = null;
}

// Whether this page's Google map has drawn its tiles once. Until it has, the
// map shows CARTO (GoogleBasemap.tsx), and a failing Google module means it
// won't draw at all.
let drawn = false;

/** Google's map has drawn its first tiles. */
export function googleMapDrawn(): void {
    drawn = true;
}

/** Set while CARTO stands in for a Google map that hasn't drawn yet. */
export const googleStandingIn = atom(false);

/** The events of a Leaflet tile layer that whenDrawn listens to. */
export interface TileEvents {
    on(type: "load" | "loading" | "tileload", fn: () => void): unknown;
    off(type: "load" | "loading" | "tileload", fn: () => void): unknown;
}

// Leaflet fades each tile in over 200 ms once it has loaded; a frame to spare.
export const TILE_FADE_MS = 250;

/** A tile's position, as Leaflet's GridLayer methods take it. */
export interface TileCoords {
    x: number;
    y: number;
    z: number;
}

/** What viewTilesShown reads of a Leaflet GridLayer (private parts). */
export interface TileGrid {
    _map?: { getCenter(): unknown } | null;
    _tileZoom?: number;
    _tiles: Record<string, { loaded?: number }>;
    _getTiledPixelBounds(center: any): unknown;
    _pxBoundsToTileRange(bounds: any): {
        min: { x: number; y: number };
        max: { x: number; y: number };
    };
    _isValidTile(coords: any): boolean;
    _tileCoordsToKey(coords: any): string;
}

/**
 * Whether every tile on screen has loaded and faded in. The tiles on screen
 * are worked out as Leaflet's GridLayer does when it requests them, not read
 * from its `current` flag: that also covers tiles up to two beyond the
 * screen, which Google may never deliver once they're off it.
 */
export function viewTilesShown(
    grid: TileGrid,
    tileCoords: (x: number, y: number, z: number) => TileCoords,
    now = Date.now(),
): boolean {
    const zoom = grid._tileZoom;
    if (!grid._map || zoom === undefined) return false;
    const range = grid._pxBoundsToTileRange(
        grid._getTiledPixelBounds(grid._map.getCenter()),
    );
    let onScreen = 0;
    for (let y = range.min.y; y <= range.max.y; y++)
        for (let x = range.min.x; x <= range.max.x; x++) {
            const coords = tileCoords(x, y, zoom);
            if (!grid._isValidTile(coords)) continue;
            const loaded = grid._tiles[grid._tileCoordsToKey(coords)]?.loaded;
            if (loaded === undefined || now - loaded < TILE_FADE_MS)
                return false;
            onScreen++;
        }
    return onScreen > 0;
}

/**
 * Calls `drawn` once the layer shows its whole current view: every tile of
 * it loaded (`viewReady`) and faded in, with no redraw of Google's tiles still
 * to come (`redrawing`), which would replace them. Checked when tiles load or
 * a view starts loading, and every TILE_FADE_MS besides: Leaflet's own "load"
 * can stay away for good when a tile of an earlier view never arrives.
 * Returns a function that stops waiting.
 */
export function whenDrawn(
    layer: TileEvents,
    viewReady: () => boolean,
    redrawing: () => boolean,
    drawn: () => void,
): () => void {
    const shows = () => viewReady() && !redrawing();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
        if (!shows()) {
            clearTimeout(timer);
            timer = undefined;
        } else
            timer ??= setTimeout(() => {
                timer = undefined;
                // Still so after the fade: a view change or redraw meanwhile
                // starts the wait over.
                if (!shows()) return;
                stop();
                drawn();
            }, TILE_FADE_MS);
    };
    const poll = setInterval(check, TILE_FADE_MS);
    const events = ["load", "loading", "tileload"] as const;
    const stop = () => {
        clearTimeout(timer);
        clearInterval(poll);
        for (const type of events) layer.off(type, check);
    };
    for (const type of events) layer.on(type, check);
    return stop;
}

if (typeof window !== "undefined") {
    window.addEventListener(
        "error",
        (event) => {
            const target = event.target as HTMLScriptElement | null;
            if (
                target?.tagName !== "SCRIPT" ||
                !target.src.startsWith(
                    "https://maps.googleapis.com/maps-api-v3/",
                )
            )
                return;
            target.remove();
            // The loader adds Google's main script, which can fail on its own
            // on a bad connection. The loader then never calls back, and
            // nothing of the API is defined, so a new loader can load it again.
            if (!(window as any).google?.maps?.importLibrary)
                return loaderFailed();
            // A module the loaded API fetches later. Before the map has drawn,
            // it may be the one it needs to: say so, CARTO stays. After that,
            // Google's map works without it.
            if (!drawn && !googleMapsProblem.get())
                googleMapsProblem.set("load-failed");
        },
        // Load errors don't bubble.
        true,
    );
}

/** Resolves once Google's loader has run (google.maps.importLibrary). */
function loadBootstrap(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const w = window as any;
        if (w.google?.maps?.importLibrary) return resolve();
        w.__searchlightGoogleMapsReady = () => resolve();
        failLoader = reject;
        if (script) return;
        script = document.createElement("script");
        script.src =
            "https://maps.googleapis.com/maps/api/js?" +
            new URLSearchParams({
                key: GOOGLE_MAPS_API_KEY,
                // GoogleMutant relies on Google's internals (tile URLs, where
                // the logo sits): the quarterly release changes them least
                // often.
                v: "quarterly",
                loading: "async",
                callback: "__searchlightGoogleMapsReady",
            });
        script.async = true;
        script.onerror = loaderFailed;
        document.head.appendChild(script);
    });
}

/**
 * Loads the Maps JavaScript API once per page. Loading it costs nothing;
 * only creating a map counts as a map load.
 */
export function loadGoogleMapsApi(): Promise<void> {
    if (apiLoad) return apiLoad;
    const attempt: Promise<void> = new Promise<void>((resolve, reject) => {
        const w = window as any;
        // Google calls this when it rejects the key: wrong referrer, or the
        // API isn't enabled for it.
        w.gm_authFailure = () => googleMapsProblem.set("auth-failed");
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("The Maps JavaScript API timed out"));
        }, GOOGLE_MAPS_LOAD_TIMEOUT_MS);
        loadBootstrap()
            // GoogleMutant needs google.maps.Map, which the async loader
            // only defines once the maps library is imported.
            .then(() => w.google.maps.importLibrary("maps"))
            .then(() => {
                resolve();
                // It arrived after all, on a slow connection the browser
                // still calls online: show Google now rather than after a
                // reload. The next load finds the API and resolves at once.
                // Not while offline: Google's tiles couldn't load.
                if (
                    timedOut &&
                    googleMapsProblem.get() === "load-failed" &&
                    navigator.onLine !== false
                )
                    googleMapsProblem.set(null);
            }, reject)
            .finally(() => clearTimeout(timer));
    }).catch((error) => {
        // The next load tries again, once a problem has cleared.
        if (apiLoad === attempt) apiLoad = null;
        // Offline and a rejected key say more, and clear on their own terms.
        if (!googleMapsProblem.get()) googleMapsProblem.set("load-failed");
        throw error;
    });
    apiLoad = attempt;
    return attempt;
}

/** Google's map types, drawn by the same map: switching costs nothing. */
export const GOOGLE_MAP_TYPES = {
    roadmap: "Roadmap",
    satellite: "Satellite",
    hybrid: "Hybrid",
    terrain: "Terrain",
} as const;
export type GoogleMapType = keyof typeof GOOGLE_MAP_TYPES;

/** A stored map type, or Roadmap for one this version doesn't know. */
export function googleMapTypeOf(value: unknown): GoogleMapType {
    // Not Object.hasOwn: Safari 14 and Chrome 87, which the build targets,
    // don't have it.
    return typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(GOOGLE_MAP_TYPES, value)
        ? (value as GoogleMapType)
        : "roadmap";
}

/**
 * Hides Google's pins for shops, restaurants, sights and other places, with
 * their names, so the paths stand out. Parks keep their names: hiding spots
 * are often described by them.
 */
export const HIDE_PLACES_STYLES = [
    {
        featureType: "poi",
        elementType: "labels",
        stylers: [{ visibility: "off" }],
    },
    {
        featureType: "poi.park",
        elementType: "labels.text",
        stylers: [{ visibility: "on" }],
    },
];

/** What Google's map shows. */
export interface GoogleLook {
    type: GoogleMapType;
    transit: boolean;
    hidePlaces: boolean;
}

/** What changes what Google's map shows (GoogleMutant, in GoogleBasemap). */
export interface GoogleLookControls {
    setMapType(type: GoogleMapType): void;
    setStyles(styles: object[]): void;
    addGoogleLayer(name: string): unknown;
    removeGoogleLayer(name: string): unknown;
}

/**
 * Applies a look to Google's map, starting from the one it was created with.
 * Only what changed is sent, so the transit layer is never added twice. Map
 * type, styles and transit lines all apply to that same map, so none of them
 * costs a map load. `redraw` runs once after each change: Google draws all
 * of them into its tiles, and the tiles already copied onto the map are old.
 */
export function googleLook(
    controls: GoogleLookControls,
    redraw: () => void,
    initial: GoogleLook,
) {
    let current = { ...initial };
    return (look: GoogleLook) => {
        let changed = false;
        // Satellite is the bare photo: Google draws no lines or places on it,
        // so changing those doesn't change its tiles.
        const drawsLook = look.type !== "satellite";
        if (look.type !== current.type) {
            controls.setMapType(look.type);
            changed = true;
        }
        if (look.hidePlaces !== current.hidePlaces) {
            controls.setStyles(look.hidePlaces ? HIDE_PLACES_STYLES : []);
            changed ||= drawsLook;
        }
        if (look.transit !== current.transit) {
            if (look.transit) controls.addGoogleLayer("TransitLayer");
            else controls.removeGoogleLayer("TransitLayer");
            changed ||= drawsLook;
        }
        current = { ...look };
        if (changed) redraw();
    };
}
