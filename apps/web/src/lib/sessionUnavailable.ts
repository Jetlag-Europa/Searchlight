// The API's message when there is no such session (resolveSessionAccess).
export const SESSION_NOT_FOUND = "Session not found";

/** The API said the session is gone, or closed to this user. */
export class SessionUnavailableError extends Error {
    constructor(readonly status: 403 | 404) {
        super(`Session unavailable (${status})`);
        this.name = "SessionUnavailableError";
    }
}

/**
 * Why a read of the session failed: a SessionUnavailableError when the API
 * says the session is gone or closed (see sessionUnavailableStatus).
 */
export async function readError(res: Response, what: string): Promise<Error> {
    const status = await sessionUnavailableStatus(res);
    return status === null
        ? new Error(`Failed to load ${what}: ${res.status}`)
        : new SessionUnavailableError(status);
}

// A 404 whose body never ends mustn't hold up the retries waiting on it.
const BODY_TIMEOUT_MS = 5_000;

/**
 * 403 or 404 when the API says this session is closed to the user or gone,
 * else null. Any other 404 says nothing about the session: one for a route
 * the running API lacks (a cached older or newer build, or a rollback), or
 * one that isn't JSON (a proxy's, on a same-origin setup).
 */
export async function sessionUnavailableStatus(
    res: Response,
): Promise<403 | 404 | null> {
    if (res.status === 403) return 403;
    if (res.status !== 404) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const body: unknown = await Promise.race([
            res.clone().json(),
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), BODY_TIMEOUT_MS);
            }),
        ]);
        const isSessionNotFound =
            typeof body === "object" &&
            body !== null &&
            !Array.isArray(body) &&
            (body as { message?: unknown }).message === SESSION_NOT_FOUND;
        return isSessionNotFound ? 404 : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
