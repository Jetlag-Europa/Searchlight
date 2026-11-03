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
}

// The tiles that failed, per layer on the map.
const failed = new Map<RetryLayer, Set<string>>();

/** Event handlers for a react-leaflet TileLayer (`eventHandlers`). */
export const retryTilesWhenOnline = {
    tileerror(event: { target: RetryLayer; coords: unknown }) {
        const layer = event.target;
        let keys = failed.get(layer);
        if (!keys) failed.set(layer, (keys = new Set()));
        keys.add(layer._tileCoordsToKey(event.coords));
    },
    remove(event: { target: RetryLayer }) {
        failed.delete(event.target);
    },
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
