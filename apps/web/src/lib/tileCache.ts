// Map tile caching, shared by the service worker (src/sw.ts) and the page.
// Keep this module free of DOM, Leaflet and store imports: the service worker
// bundles it too.

/** Tiles cached as they are viewed. Bounded; the oldest are dropped first. */
export const TILE_CACHE = "searchlight-tiles";

/**
 * Tiles the player saved for a game's area ("Save map for offline"). The
 * service worker reads it before TILE_CACHE and never writes or trims it;
 * only the page adds and deletes entries.
 */
export const SAVED_TILE_CACHE = "searchlight-saved-tiles";

// CARTO spreads tiles over a.–d. subdomains (Leaflet's `{s}`); the rest use
// one host.
const TILE_HOSTS = [
    /^[a-d]\.basemaps\.cartocdn\.com$/,
    /^tile\.openstreetmap\.org$/,
    /^tile\.thunderforest\.com$/,
];

export function isTileUrl(url: URL): boolean {
    return (
        url.protocol === "https:" &&
        TILE_HOSTS.some((host) => host.test(url.hostname))
    );
}

/**
 * The cache key for a tile URL. The same tile is served from any CARTO
 * subdomain, so the key drops it: a tile cached from `a.` is found again when
 * requested from `c.`.
 */
export function tileCacheKey(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace(
        /^[a-d]\.(basemaps\.cartocdn\.com)$/,
        "$1",
    );
    return parsed.href;
}
