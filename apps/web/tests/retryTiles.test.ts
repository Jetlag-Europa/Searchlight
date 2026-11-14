import { describe, expect, it } from "vitest";

import { retryFailedTiles, retryTilesWhenOnline } from "@/lib/retryTiles";

type Coords = { x: number; y: number; z: number };
const at = (x: number): Coords => ({ x, y: 1, z: 15 });

/** A Leaflet tile layer as far as the retry reads it. */
function fakeLayer(keys: string[]) {
    const once = new Map<string, () => void>();
    const layer = {
        _map: {} as unknown,
        _tiles: Object.fromEntries(keys.map((k) => [k, {}])) as Record<
            string,
            unknown
        >,
        removed: [] as string[],
        updates: 0,
        _tileCoordsToKey: (c: Coords) => `${c.x}:${c.y}:${c.z}`,
        _removeTile(key: string) {
            this.removed.push(key);
            delete this._tiles[key];
        },
        _update() {
            this.updates++;
        },
        once(type: string, fn: () => void) {
            once.set(type, fn);
        },
        /** Taken off the map, as react-leaflet does on unmount. */
        removeFromMap() {
            this._map = undefined;
            once.get("remove")?.();
        },
    };
    return layer;
}

const fail = (layer: ReturnType<typeof fakeLayer>, x: number) =>
    retryTilesWhenOnline.tileerror({ target: layer, coords: at(x) });

describe("retryFailedTiles", () => {
    it("asks again for the tiles that failed, and only those", () => {
        const layer = fakeLayer(["1:1:15", "2:1:15", "3:1:15"]);
        fail(layer, 2);
        retryFailedTiles();
        expect(layer.removed).toEqual(["2:1:15"]);
        expect(layer.updates).toBe(1);
        // Done: the next reconnect has nothing to ask again.
        retryFailedTiles();
        expect(layer.updates).toBe(1);
    });

    it("leaves a tile alone that has loaded since", () => {
        // Failed, panned away (dropped), back: it loaded this time.
        const layer = fakeLayer(["1:1:15", "2:1:15"]);
        fail(layer, 1);
        retryTilesWhenOnline.tileunload({ target: layer, coords: at(1) });
        fail(layer, 2);
        retryTilesWhenOnline.tileload({ target: layer, coords: at(2) });
        retryFailedTiles();
        expect(layer.removed).toEqual([]);
        expect(layer.updates).toBe(0);
    });

    it("forgets a layer once it's off the map", () => {
        const layer = fakeLayer(["1:1:15"]);
        fail(layer, 1);
        layer.removeFromMap();
        layer._map = {}; // even were it back with the same tile
        retryFailedTiles();
        expect(layer.removed).toEqual([]);
    });
});
