import { describe, expect, it } from "vitest";

import { pageCacheKey, precacheUrl } from "@/lib/pageCache";

const key = (url: string) => pageCacheKey(new URL(url, "https://app.test"));

describe("precacheUrl", () => {
    it("names a page by its directory", () => {
        expect(precacheUrl("index.html")).toBe("/");
        expect(precacheUrl("map/index.html")).toBe("/map/");
        expect(precacheUrl("games/import/index.html")).toBe("/games/import/");
    });

    it("keeps other files' URLs", () => {
        expect(precacheUrl("_astro/client.abc123.js")).toBe(
            "_astro/client.abc123.js",
        );
        expect(precacheUrl("manifest.webmanifest")).toBe(
            "manifest.webmanifest",
        );
    });
});

describe("pageCacheKey", () => {
    it("finds a page with or without the trailing slash", () => {
        expect(key("/map")).toBe("/map/");
        expect(key("/map/")).toBe("/map/");
        expect(key("/games/import")).toBe("/games/import/");
        expect(key("/games/import/")).toBe("/games/import/");
        expect(key("/")).toBe("/");
    });

    it("drops the query and hash", () => {
        expect(key("/play?token=abc")).toBe("/play/");
        expect(key("/map/?x=1#y")).toBe("/map/");
        expect(key("/?returnTo=%2Fmap")).toBe("/");
    });

    it("finds a page by its index.html", () => {
        expect(key("/index.html")).toBe("/");
        expect(key("/map/index.html")).toBe("/map/");
    });

    it("gives the key precacheUrl gives the page's file", () => {
        for (const file of [
            "index.html",
            "map/index.html",
            "games/import/index.html",
        ]) {
            expect(key(precacheUrl(file))).toBe(precacheUrl(file));
        }
    });
});
