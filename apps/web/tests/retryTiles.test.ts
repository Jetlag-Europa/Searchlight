import { describe, expect, it } from "vitest";

import { retryFailedTiles, retryTilesWhenOnline } from "@/lib/retryTiles";

/** A Leaflet tile layer as far as the retry reads it. */
function fakeLayer(keys: string[]) {
    const layer = {
        _map: {},
        _tiles: Object.fromEntries(keys.map((k) => [k, {}])) as Record<
            string,
            unknown
        >,
        removed: [] as string[],
        updates: 0,
        _tileCoordsToKey: (c: { x: number; y: number; z: number }) =>
            `${c.x}:${c.y}:${c.z}`,
        _removeTile(key: string) {
            this.removed.push(key);
            delete this._tiles[key];
        },
        _update() {
            this.updates++;
        },
    };
    return layer;
}

describe("retryFailedTiles", () => {
    it("asks again for the tiles that failed, and only those", () => {
        const layer = fakeLayer(["1:1:15", "2:1:15", "3:1:15"]);
        retryTilesWhenOnline.tileerror({
            target: layer,
            coords: { x: 2, y: 1, z: 15 },
        });
        retryFailedTiles();
        expect(layer.removed).toEqual(["2:1:15"]);
        expect(layer.updates).toBe(1);
        // Done: the next reconnect has nothing to ask again.
        retryFailedTiles();
        expect(layer.updates).toBe(1);
    });

    it("skips tiles gone since, and layers off the map", () => {
        const panned = fakeLayer(["1:1:15"]);
        retryTilesWhenOnline.tileerror({
            target: panned,
            coords: { x: 9, y: 9, z: 15 }, // off screen and dropped by now
        });
        const removed = fakeLayer(["1:1:15"]);
        retryTilesWhenOnline.tileerror({
            target: removed,
            coords: { x: 1, y: 1, z: 15 },
        });
        retryTilesWhenOnline.remove({ target: removed });
        retryFailedTiles();
        expect(panned.updates).toBe(0);
        expect(removed.removed).toEqual([]);
    });
});
