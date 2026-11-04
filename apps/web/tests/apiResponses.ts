// The API's error answers, as its Fastify error handler sends them.

export const SESSION_NOT_FOUND_BODY = {
    statusCode: 404,
    error: "Not Found",
    message: "Session not found",
};

export const FORBIDDEN_BODY = {
    statusCode: 403,
    error: "Forbidden",
    message: "Forbidden",
};

/** Fastify's own 404 for a route the API doesn't have. */
export function routeNotFoundBody(method: string, path: string) {
    return {
        message: `Route ${method}:${path} not found`,
        error: "Not Found",
        statusCode: 404,
    };
}

export function sessionNotFound(): Response {
    return Response.json(SESSION_NOT_FOUND_BODY, { status: 404 });
}

export function forbidden(): Response {
    return Response.json(FORBIDDEN_BODY, { status: 403 });
}

export function routeNotFound(method = "GET", path = "/x"): Response {
    return Response.json(routeNotFoundBody(method, path), { status: 404 });
}

/** A proxy's 404, which only reaches the app on a same-origin setup. */
export function plainTextNotFound(): Response {
    return new Response("404 page not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
    });
}

/** A proxy's or firewall's block page, which only reaches the app on a same-origin setup. */
export function htmlForbidden(): Response {
    return new Response("<html><body>Access denied</body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
    });
}

/**
 * 403s and 404s that say nothing about the session: a 404 for a route the
 * running API doesn't have (an older or newer build), and a proxy's.
 */
export const notTheSession: Array<[string, () => Response]> = [
    ["a route-not-found 404", () => routeNotFound()],
    ["a plain-text 404", () => plainTextNotFound()],
    ["an HTML 403", () => htmlForbidden()],
];
