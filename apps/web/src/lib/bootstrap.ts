import { drawingEnabled } from "@/annotations/hooks/useAnnotationStore";
import { removeStorage } from "@/lib/safeStorage";

let hasRun = false;

// Settings of retired features: the picked place and drawn play area, custom
// station lists, the zone sidebar's OSM options and radius, the tutorial,
// Pastebin and the disabled zones of every game in one list.
export const RETIRED_STORAGE_KEYS = [
    "mapGeoLocation",
    "additionalMapGeoLocations",
    "polyGeoJSON",
    "displayHidingZonesOptions",
    "useCustomStations",
    "customStations",
    "includeDefaultStations",
    "removeDuplicates",
    "hidingRadius",
    "hidingRadiusUnits",
    "showTutorials",
    "pastebinApiKey",
    "alwaysUsePastebin",
    "disabledStations",
];
// Browser caches of OpenStreetMap lookups.
export const RETIRED_CACHES = [
    "jlhs-map-generator-cache",
    "jlhs-map-generator-zone-cache",
    "jlhs-map-generator-permanent-cache",
];

/** Remove what retired features left in the browser. */
export function removeRetiredStorage(): void {
    for (const key of RETIRED_STORAGE_KEYS) removeStorage("localStorage", key);
    try {
        // The Cache API exists only in secure contexts, and privacy modes can
        // make it throw.
        if (typeof caches === "undefined") return;
        for (const name of RETIRED_CACHES) {
            caches.delete(name).catch(() => {});
        }
    } catch {
        // Best-effort.
    }
}

export function bootstrapDefaults(): void {
    if (hasRun) return;
    hasRun = true;

    // Pen mode starts off on every load so the user opts in per-session.
    drawingEnabled.set(false);
    removeRetiredStorage();

    // Game defaults are now applied by SessionManager when a session is selected.
    // No game bootstrap here.
}
