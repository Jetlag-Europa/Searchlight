// Google Fonts, shared by Layout.astro (which links the stylesheet) and the
// service worker (src/sw.ts, which keeps it). Keep this module free of
// imports: both bundle it.

/** The stylesheet every page links. It blocks rendering until it loads. */
export const FONT_STYLESHEET_URL =
    "https://fonts.googleapis.com/css2?family=Oxygen:wght@300;400;700&family=Poppins:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap";

export const FONT_STYLES_CACHE = "searchlight-font-styles";

/**
 * `response`, or a network error once it fails or takes over `ms`. A page
 * waits for the font stylesheet before it shows anything, so on a connection
 * that drops packets it would wait for a minute or more: without it, the page
 * shows at once in the fallback fonts.
 */
export function responseWithin(
    response: Promise<Response>,
    ms: number,
): Promise<Response> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(Response.error()), ms);
        response.then(
            (r) => {
                clearTimeout(timer);
                resolve(r);
            },
            () => {
                clearTimeout(timer);
                resolve(Response.error());
            },
        );
    });
}

/**
 * Downloads the font stylesheet into `cache`, as the service worker installs.
 * The first visit loads it before the service worker controls the page, so
 * the runtime route never sees it, and the next load on a bad connection
 * would have none kept. Fails quietly after `timeoutMs`: an old copy stays,
 * and the app installs without fonts rather than not at all.
 */
export async function keepFontStyles(
    cache: Pick<Cache, "put">,
    timeoutMs: number,
    fetcher: typeof fetch = fetch,
): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // As the page's <link crossorigin> asks for it: CORS, no cookies.
        const request = new Request(FONT_STYLESHEET_URL, {
            mode: "cors",
            credentials: "same-origin",
        });
        const response = await fetcher(request, { signal: controller.signal });
        if (response.status === 200) await cache.put(request, response);
    } catch {
        // Offline, or too slow: the runtime route keeps it on a later load.
    } finally {
        clearTimeout(timer);
    }
}
