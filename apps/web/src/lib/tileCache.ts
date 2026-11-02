// Map tile caching in the service worker (src/sw.ts). Keep this module free
// of DOM, Leaflet and store imports: the service worker bundles it.

/** CARTO and Thunderforest tiles, kept as they are viewed. Bounded. */
export const TILE_CACHE = "searchlight-tiles";

/**
 * OpenStreetMap tiles. Kept apart: they are a fallback for a few days while
 * the connection is bad, not a cache that answers first.
 */
export const OSM_TILE_CACHE = "searchlight-osm-tiles";

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

export function isOsmTileUrl(url: URL): boolean {
    return (
        url.protocol === "https:" && url.hostname === "tile.openstreetmap.org"
    );
}
