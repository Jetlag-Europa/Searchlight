import type { MeResponse } from "@searchlight/shared";

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

/**
 * Who plays while /me can't be reached: the last account verified in this
 * browser, if any, and nobody once /me has verified one.
 */
export function offlinePlayer(
    storedUserId: string | null,
    verifiedUserId: string | null,
): string | null {
    if (verifiedUserId) return null;
    return storedUserId || null;
}

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
export const ME_TIMEOUT_MS = 8_000;

/** How long to wait before checking /me again after `failures` failed checks. */
export function authRetryDelay(failures: number): number {
    return Math.min(
        RETRY_MIN_MS * 2 ** Math.max(0, failures - 1),
        RETRY_MAX_MS,
    );
}

interface AuthHandlers {
    signedIn: (data: MeResponse) => void;
    signedOut: () => void;
    unreachable: () => void;
}

/**
 * Check `meUrl` until it answers 200 or 401, waiting longer after each
 * failure, and right away once the device is back online. Returns a function
 * that stops checking.
 */
export function watchAuth(meUrl: string, handlers: AuthHandlers): () => void {
    let stopped = false;
    let failures = 0;
    let controller: AbortController | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
        clearTimeout(retryTimer);
        retryTimer = undefined;
        controller?.abort();
        const current = new AbortController();
        controller = current;
        const timeout = setTimeout(() => current.abort(), ME_TIMEOUT_MS);

        let status: number | undefined;
        let data: MeResponse | undefined;
        try {
            const res = await fetch(meUrl, {
                credentials: "include",
                signal: current.signal,
            });
            if (res.ok) data = (await res.json()) as MeResponse;
            status = res.status;
        } catch (err) {
            // Also a timeout: the request was aborted.
            console.warn("[searchlight] /me failed:", err);
        } finally {
            clearTimeout(timeout);
        }
        if (stopped || controller !== current) return;

        const outcome = authCheckOutcome(status);
        if (outcome === "signed-out") {
            handlers.signedOut();
        } else if (outcome === "unreachable" || !data) {
            failures++;
            const delay = authRetryDelay(failures);
            console.warn(
                "[searchlight] can't reach the server (" +
                    (status ?? "no response") +
                    "), checking /me again in",
                delay,
                "ms",
            );
            handlers.unreachable();
            retryTimer = setTimeout(() => void check(), delay);
        } else {
            handlers.signedIn(data);
        }
    };

    const handleOnline = () => {
        if (retryTimer !== undefined) void check();
    };
    window.addEventListener("online", handleOnline);
    void check();
    return () => {
        stopped = true;
        controller?.abort();
        clearTimeout(retryTimer);
        window.removeEventListener("online", handleOnline);
    };
}
