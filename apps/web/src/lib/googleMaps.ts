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
 * when the browser is back online; the others last until a reload.
 */
export type GoogleMapsProblem = "offline" | "load-failed" | "auth-failed";
export const googleMapsProblem = atom<GoogleMapsProblem | null>(
    typeof navigator !== "undefined" && navigator.onLine === false
        ? "offline"
        : null,
);

/**
 * Set while the map is printed. Google's terms don't allow storing its map
 * outside the API, so prints use CARTO.
 */
export const printingWithoutGoogle = atom(false);

/** The basemap to draw for the chosen one: CARTO whenever Google can't be. */
export function effectiveBasemap<T extends string>(
    chosen: T,
    {
        available,
        problem,
        printing,
    }: {
        available: boolean;
        problem: GoogleMapsProblem | null;
        printing: boolean;
    },
): T | "voyager" {
    if (chosen !== "google") return chosen;
    return available && !problem && !printing ? chosen : "voyager";
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
        // The script may have failed for want of a connection: try again.
        if (problem === "load-failed") {
            apiLoad = null;
            googleMapsProblem.set(null);
        }
    });
}

// A bad connection can stall the script without failing it. Past this the
// map shows CARTO, and Google is tried again once the browser is back online.
export const GOOGLE_MAPS_LOAD_TIMEOUT_MS = 15_000;

let apiLoad: Promise<void> | null = null;
// The loader script while it's in the page and hasn't failed. A retry waits
// for it rather than adding another: Google warns against loading it twice.
let script: HTMLScriptElement | null = null;

/** Resolves once Google's loader has run (google.maps.importLibrary). */
function loadBootstrap(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const w = window as any;
        if (w.google?.maps?.importLibrary) return resolve();
        w.__searchlightGoogleMapsReady = () => resolve();
        if (script) return;
        script = document.createElement("script");
        script.src =
            "https://maps.googleapis.com/maps/api/js?" +
            new URLSearchParams({
                key: GOOGLE_MAPS_API_KEY,
                v: "weekly",
                loading: "async",
                callback: "__searchlightGoogleMapsReady",
            });
        script.async = true;
        script.onerror = () => {
            script?.remove();
            script = null;
            reject(new Error("The Maps JavaScript API didn't load"));
        };
        document.head.appendChild(script);
    });
}

/**
 * Loads the Maps JavaScript API once per page. Loading it costs nothing;
 * only creating a map counts as a map load.
 */
export function loadGoogleMapsApi(): Promise<void> {
    apiLoad ??= new Promise<void>((resolve, reject) => {
        const w = window as any;
        // Google calls this when it rejects the key: wrong referrer, or the
        // API isn't enabled for it.
        w.gm_authFailure = () => googleMapsProblem.set("auth-failed");
        const timer = setTimeout(
            () => reject(new Error("The Maps JavaScript API timed out")),
            GOOGLE_MAPS_LOAD_TIMEOUT_MS,
        );
        loadBootstrap()
            // GoogleMutant needs google.maps.Map, which the async loader
            // only defines once the maps library is imported.
            .then(() => w.google.maps.importLibrary("maps"))
            .then(() => resolve(), reject)
            .finally(() => clearTimeout(timer));
    }).catch((error) => {
        googleMapsProblem.set("load-failed");
        throw error;
    });
    return apiLoad;
}

/** The part of GoogleMutant that puts Google's own layers on its map. */
export interface GoogleSublayers {
    addGoogleLayer(name: string): unknown;
    removeGoogleLayer(name: string): unknown;
}

/**
 * Shows or hides Google's transit lines on the layer's map. They are drawn
 * on that same map, so switching them costs no map load. GoogleMutant only
 * applies the change once its map exists, so this remembers what it asked for
 * rather than asking twice. `redraw` runs after each change: Google bakes the
 * lines into its tiles, and the tiles already copied onto the map are old.
 */
export function transitLines(layer: GoogleSublayers, redraw: () => void) {
    let shown = false;
    return (show: boolean) => {
        if (show === shown) return;
        shown = show;
        if (show) layer.addGoogleLayer("TransitLayer");
        else layer.removeGoogleLayer("TransitLayer");
        redraw();
    };
}
