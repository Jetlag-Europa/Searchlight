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
import type { WorkboxPlugin } from "workbox-core/types";
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
import {
    CacheFirst,
    NetworkFirst,
    StaleWhileRevalidate,
} from "workbox-strategies";

import { pageCacheKey } from "./lib/pageCache";
import {
    isOsmTileUrl,
    isTileUrl,
    OSM_TILE_CACHE,
    TILE_CACHE,
    tileCacheKey,
} from "./lib/tileCache";

declare const self: ServiceWorkerGlobalScope & {
    __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const DAY = 24 * 60 * 60;

const DOWNLOADED_AT = "X-Searchlight-Downloaded-At";

/**
 * Serves a cached response only within `maxAgeSeconds` of its download, and
 * deletes it once it's older. ExpirationPlugin can't do this: it counts from
 * a response's last use, and a CORS response doesn't show it the Date header.
 * So the copy put in the cache is stamped with the time.
 */
function downloadedWithin(maxAgeSeconds: number): WorkboxPlugin {
    return {
        cacheWillUpdate: async ({ response }) => {
            const headers = new Headers(response.headers);
            headers.set(DOWNLOADED_AT, String(Date.now()));
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        },
        cachedResponseWillBeUsed: async ({
            cacheName,
            request,
            cachedResponse,
        }) => {
            if (!cachedResponse) return null;
            const downloadedAt = Number(
                cachedResponse.headers.get(DOWNLOADED_AT),
            );
            if (Date.now() - downloadedAt <= maxAgeSeconds * 1000) {
                return cachedResponse;
            }
            await (await caches.open(cacheName)).delete(request);
            return null;
        },
    };
}

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

// Map tiles, kept as they are viewed, as CORS responses (the tile layers set
// crossOrigin): an opaque one would count for megabytes of storage. Only 200s
// are kept, one copy per tile across CARTO's subdomains, the newest few
// thousand (tiles are 20–60 KB).
const tileKey: WorkboxPlugin = {
    cacheKeyWillBeUsed: async ({ request }) => tileCacheKey(request.url),
};

// CARTO's terms allow keeping tiles on the device for 30 days at most, and
// Thunderforest's until fresh ones are downloaded: they come from the cache
// first, for 30 days after they were downloaded.
registerRoute(
    ({ url }) => isTileUrl(url) && !isOsmTileUrl(url),
    new CacheFirst({
        cacheName: TILE_CACHE,
        plugins: [
            tileKey,
            new CacheableResponsePlugin({ statuses: [200] }),
            downloadedWithin(30 * DAY),
            new ExpirationPlugin({
                maxEntries: 3000,
                maxAgeSeconds: 30 * DAY,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

// OpenStreetMap asks clients to honour its caching headers (about a day,
// then stale-if-error for a week). Its tiles come from the network, through
// the browser's HTTP cache that applies them; the copy kept here is only
// used when the network fails or takes over 3 s, and for a week at most.
registerRoute(
    ({ url }) => isOsmTileUrl(url),
    new NetworkFirst({
        cacheName: OSM_TILE_CACHE,
        networkTimeoutSeconds: 3,
        plugins: [
            new CacheableResponsePlugin({ statuses: [200] }),
            downloadedWithin(7 * DAY),
            new ExpirationPlugin({
                maxEntries: 1000,
                maxAgeSeconds: 7 * DAY,
                purgeOnQuotaError: true,
            }),
        ],
    }),
);

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
