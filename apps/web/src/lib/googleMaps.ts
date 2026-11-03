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

/** Google Maps Platform's free map loads a month (Maps JavaScript API). */
export const FREE_MAP_LOADS_PER_MONTH = 10_000;

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

/**
 * Tells the API that this page created its Google map, which Google bills as
 * a map load, for the counts on the admin page. Best effort: a lost report
 * only makes the count a little low.
 */
export function reportGoogleMapLoad(sessionId: string): void {
    fetch(`${API_BASE}/me/google-map-loads`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
    }).catch(() => {});
}

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
    return typeof value === "string" && Object.hasOwn(GOOGLE_MAP_TYPES, value)
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
        if (look.type !== current.type) {
            controls.setMapType(look.type);
            changed = true;
        }
        if (look.hidePlaces !== current.hidePlaces) {
            controls.setStyles(look.hidePlaces ? HIDE_PLACES_STYLES : []);
            changed = true;
        }
        if (look.transit !== current.transit) {
            if (look.transit) controls.addGoogleLayer("TransitLayer");
            else controls.removeGoogleLayer("TransitLayer");
            changed = true;
        }
        current = { ...look };
        if (changed) redraw();
    };
}
