export type AuthCheckOutcome = "signed-in" | "signed-out" | "unreachable";

/**
 * What a /me answer means. Only a 401 says the visitor is logged out. A
 * timeout or network error (no status) or a server error is a blip to wait
 * out: it must not throw a player onto the login page mid-game.
 */
export function authCheckOutcome(status: number | undefined): AuthCheckOutcome {
    if (status === 401) return "signed-out";
    if (status !== undefined && status >= 200 && status < 300)
        return "signed-in";
    return "unreachable";
}

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** How long to wait before checking /me again after `failures` failed checks. */
export function authRetryDelay(failures: number): number {
    return Math.min(
        RETRY_MIN_MS * 2 ** Math.max(0, failures - 1),
        RETRY_MAX_MS,
    );
}
