// Leaflet keeps a tile that failed to load (offline, a bad connection) broken,
// and only asks for it again once it has left the screen and come back. So a
// map moved while the connection was gone keeps its holes after it's back.
// These are asked for again then.

/** What the retry needs of a Leaflet tile layer (private parts). */
interface RetryLayer {
    _map?: unknown;
    _tiles: Record<string, unknown>;
    _tileCoordsToKey(coords: any): string;
    _removeTile(key: string): void;
    _update(): void;
    once(type: "remove", fn: () => void): unknown;
}

type TileEvent = { target: RetryLayer; coords: unknown };

// The tiles that failed and haven't loaded since, per layer on the map.
const failed = new Map<RetryLayer, Set<string>>();

function forget({ target, coords }: TileEvent) {
    failed.get(target)?.delete(target._tileCoordsToKey(coords));
}

/** Event handlers for a react-leaflet TileLayer (`eventHandlers`). */
export const retryTilesWhenOnline = {
    tileerror({ target, coords }: TileEvent) {
        let keys = failed.get(target);
        if (!keys) {
            failed.set(target, (keys = new Set()));
            // Directly on the layer: react-leaflet takes its event handlers
            // off before it removes the layer, so one there would never run.
            target.once("remove", () => failed.delete(target));
        }
        keys.add(target._tileCoordsToKey(coords));
    },
    // Loaded after all (panned away and back), or dropped.
    tileload: forget,
    tileunload: forget,
};

/** Asks again for every failed tile still shown. */
export function retryFailedTiles(): void {
    for (const [layer, keys] of failed) {
        failed.delete(layer);
        if (!layer._map) continue;
        let retried = false;
        for (const key of keys)
            if (key in layer._tiles) {
                layer._removeTile(key);
                retried = true;
            }
        // Requests the tiles now missing from the view.
        if (retried) layer._update();
    }
}

if (typeof window !== "undefined")
    window.addEventListener("online", retryFailedTiles);
