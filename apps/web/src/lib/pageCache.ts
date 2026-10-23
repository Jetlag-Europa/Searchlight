// The pages' HTML in the service worker's precache, shared by the build
// (astro.config.mjs names the entries) and the service worker (src/sw.ts finds
// them again). Keep this module free of imports: both bundle it.

/**
 * The precache URL of a built file. A page is precached under its directory,
 * the URL both nginx and Cloudflare serve it at without a redirect
 * ("map/index.html" → "/map/", "index.html" → "/"); other files keep theirs.
 */
export function precacheUrl(file: string): string {
    if (file === "index.html") return "/";
    if (file.endsWith("/index.html")) {
        return `/${file.slice(0, -"index.html".length)}`;
    }
    return file;
}

/**
 * The precache key of the page a navigation to `url` shows. Links reach a
 * page with or without the trailing slash and with a query (`/play?token=…`,
 * `/map/?x`), so both are dropped to the form precacheUrl gives.
 */
export function pageCacheKey(url: URL): string {
    const path = url.pathname.replace(/\/index\.html$/, "/");
    return path.endsWith("/") ? path : `${path}/`;
}
