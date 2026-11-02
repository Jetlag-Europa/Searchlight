import { describe, expect, it } from "vitest";

import { isOsmTileUrl, isTileUrl, tileCacheKey } from "@/lib/tileCache";

const tile = (url: string) => isTileUrl(new URL(url));

describe("isTileUrl", () => {
    it("matches the basemaps' tile hosts", () => {
        expect(
            tile("https://a.basemaps.cartocdn.com/dark_all/10/524/351.png"),
        ).toBe(true);
        expect(
            tile("https://d.basemaps.cartocdn.com/light_all/3/4/2@2x.png"),
        ).toBe(true);
        expect(tile("https://tile.openstreetmap.org/10/524/351.png")).toBe(
            true,
        );
        expect(
            tile("https://tile.thunderforest.com/transport/1/0/0.png?apikey=k"),
        ).toBe(true);
    });

    it("leaves other hosts and plain http alone", () => {
        expect(tile("https://e.basemaps.cartocdn.com/dark_all/1/0/0.png")).toBe(
            false,
        );
        expect(tile("https://basemaps.cartocdn.com.evil.test/1/0/0.png")).toBe(
            false,
        );
        expect(tile("http://tile.openstreetmap.org/1/0/0.png")).toBe(false);
        expect(tile("https://photon.komoot.io/api?q=x")).toBe(false);
        expect(tile("https://api.example.test/sessions")).toBe(false);
    });
});

describe("isOsmTileUrl", () => {
    it("matches only OpenStreetMap's tiles", () => {
        const osm = (url: string) => isOsmTileUrl(new URL(url));
        expect(osm("https://tile.openstreetmap.org/10/524/351.png")).toBe(true);
        expect(osm("http://tile.openstreetmap.org/10/524/351.png")).toBe(false);
        expect(osm("https://a.basemaps.cartocdn.com/dark_all/1/0/0.png")).toBe(
            false,
        );
        expect(osm("https://tile.thunderforest.com/transport/1/0/0.png")).toBe(
            false,
        );
    });
});

describe("tileCacheKey", () => {
    it("gives every CARTO subdomain the same key", () => {
        const keys = ["a", "b", "c", "d"].map((s) =>
            tileCacheKey(
                `https://${s}.basemaps.cartocdn.com/dark_all/10/524/351.png`,
            ),
        );
        expect(new Set(keys)).toEqual(
            new Set(["https://basemaps.cartocdn.com/dark_all/10/524/351.png"]),
        );
    });

    it("keeps the rest of the URL, query included", () => {
        expect(
            tileCacheKey(
                "https://tile.thunderforest.com/transport/1/0/0.png?apikey=k",
            ),
        ).toBe("https://tile.thunderforest.com/transport/1/0/0.png?apikey=k");
        expect(tileCacheKey("https://tile.openstreetmap.org/1/0/0.png")).toBe(
            "https://tile.openstreetmap.org/1/0/0.png",
        );
    });
});
