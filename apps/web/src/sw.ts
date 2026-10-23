/// <reference lib="webworker" />
// The service worker (vite-plugin-pwa builds it with injectManifest). The app
// is meant to keep working while the connection is bad or gone for a while,
// not to work fully offline: it precaches the app itself and keeps the map
// tiles and fonts it has shown. Anything else, the API and the geocoder above
// all, goes to the network untouched.
// Imports are relative: the service worker's build doesn't know the `@/`
// alias.
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { clientsClaim } from "workbox-core";
import type { RouteHandlerCallbackOptions } from "workbox-core/types";
import { ExpirationPlugin } from "workbox-expiration";
import {
    addPlugins,
    cleanupOutdatedCaches,
    getCacheKeyForURL,
    matchPrecache,
    precacheAndRoute,
} from "workbox-precaching";
import { RangeRequestsPlugin } from "workbox-range-requests";
import { registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";

import { pageCacheKey } from "./lib/pageCache";
import {
    isTileUrl,
    SAVED_TILE_CACHE,
    TILE_CACHE,
    tileCacheKey,
} from "./lib/tileCache";

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const DAY = 24 * 60 * 60;

// The page asks a waiting update to take over when the player chooses to
// reload (src/lib/serviceWorker.tsx); it never takes over on its own while
// the old version has pages open.
self.addEventListener("message", (event) => {
    if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
// The first install takes over the open page at once, so the tiles it shows
// are already kept.
clientsClaim();
cleanupOutdatedCaches();

// Pages come from the precache first, without asking the network. On a bad
// connection a page opens at once instead of waiting for a timeout, and it
// always matches the scripts precached with it (an HTML page from the network
// could name scripts of a newer build that aren't cached). New builds arrive
// as a service worker update, which the page offers to reload into. Links
// reach a page with or without the trailing slash and with a query
// (`/play?token=…`), so the key drops both. Other paths, such as the link
// previews under /og/, aren't precached pages and go to the network.
registerRoute(
    ({ request, url }) =>
        request.mode === "navigate" &&
        url.origin === self.location.origin &&
        getCacheKeyForURL(pageCacheKey(url)) !== undefined,
    async ({ request, url }) =>
        (await matchPrecache(pageCacheKey(url))) ?? fetch(request),
);

// The alarm plays from the precache. Media elements ask for byte ranges, and
// Safari plays nothing unless it gets the range it asked for.
addPlugins([new RangeRequestsPlugin()]);
precacheAndRoute(self.__WB_MANIFEST);

// Map tiles, kept as they are viewed: the newest few thousand (tiles are
// 20–60 KB) for a month. Only 200s are kept; a CORS response (the tile layers
// set crossOrigin) costs its real size in storage, where an opaque one would
// count for megabytes.
const tiles = new CacheFirst({
    cacheName: TILE_CACHE,
    plugins: [
        {
            cacheKeyWillBeUsed: async ({ request }) =>
                tileCacheKey(request.url),
        },
        new CacheableResponsePlugin({ statuses: [200] }),
        new ExpirationPlugin({
            maxEntries: 3000,
            maxAgeSeconds: 30 * DAY,
            purgeOnQuotaError: true,
        }),
    ],
});

async function tile(options: RouteHandlerCallbackOptions): Promise<Response> {
    // Tiles the player saved for a game come first. That cache belongs to
    // the page: this never writes to it or trims it.
    const saved = await caches.match(tileCacheKey(options.request.url), {
        cacheName: SAVED_TILE_CACHE,
        ignoreVary: true,
    });
    return saved ?? tiles.handle(options);
}

registerRoute(({ url }) => isTileUrl(url), tile);

// Google Fonts: the stylesheet is refreshed in the background, the font
// files it names never change. Layout.astro loads the stylesheet with CORS,
// like the font files, so neither is kept as an opaque response.
registerRoute(
    ({ url }) => url.origin === "https://fonts.googleapis.com",
    new StaleWhileRevalidate({
        cacheName: "searchlight-font-styles",
        plugins: [
            new CacheableResponsePlugin({ statuses: [200] }),
            new ExpirationPlugin({ maxEntries: 5 }),
        ],
    }),
);
registerRoute(
    ({ url }) => url.origin === "https://fonts.gstatic.com",
    new CacheFirst({
        cacheName: "searchlight-fonts",
        plugins: [
            new CacheableResponsePlugin({ statuses: [200] }),
            new ExpirationPlugin({
                maxEntries: 30,
                maxAgeSeconds: 365 * DAY,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);
