// Shared Overpass client. A self-hosted instance (set OVERPASS_URL, e.g.
// http://host.docker.internal:12345/api/interpreter in dev, or
// https://overpass.lucifersserver.com/api/interpreter behind Cloudflare Access in
// prod) is tried first — the public servers regularly time out on the
// is_in/admin-boundary queries the Bezirk/canton questions need, which surfaced as
// 502s. Public servers remain as fallback. Every Overpass call in the app (backend
// boundary routes and the /overpass proxy the frontend uses) funnels through here.

const DEFAULT_TIMEOUT_MS = 30_000;

const PRIVATE_OVERPASS_URL = process.env.OVERPASS_URL;

const OVERPASS_URLS = [
    PRIVATE_OVERPASS_URL,
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
].filter((u): u is string => Boolean(u));

// The self-hosted Overpass (OVERPASS_URL) may sit behind Cloudflare Access. When
// these service-token credentials are set, send them as headers — but only to the
// private URL, never to the public fallbacks.
const CF_ACCESS_CLIENT_ID = process.env.OVERPASS_CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.OVERPASS_CF_ACCESS_CLIENT_SECRET;

function overpassHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent": "Searchlight/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
    };
    if (
        url === PRIVATE_OVERPASS_URL &&
        CF_ACCESS_CLIENT_ID &&
        CF_ACCESS_CLIENT_SECRET
    ) {
        headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
        headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
    }
    return headers;
}

export async function overpassFetch(
    query: string,
    opts: { timeoutMs?: number } = {},
): Promise<Response | null> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // POST with the query in the body, not GET-with-query-param: large poly: filters
    // (zone/border/places queries from the frontend) overflow the GET URL length
    // limit (414). Short boundary queries POST fine too.
    const body = `data=${encodeURIComponent(query)}`;
    for (const url of OVERPASS_URLS) {
        // Fresh signal per attempt — a timed-out signal would otherwise instantly
        // abort the next endpoint.
        const res = await fetch(url, {
            method: "POST",
            headers: overpassHeaders(url),
            body,
            signal: AbortSignal.timeout(timeoutMs),
        }).catch(() => null);
        if (res?.ok) return res;
    }
    return null;
}

// Returns parsed Overpass JSON or throws a 502-tagged error.
export async function overpassJson(
    query: string,
    opts: { timeoutMs?: number; errorMessage?: string } = {},
): Promise<any> {
    const res = await overpassFetch(query, opts);
    if (!res) {
        throw Object.assign(
            new Error(opts.errorMessage ?? "Overpass API unavailable"),
            { statusCode: 502 },
        );
    }
    return res.json();
}
