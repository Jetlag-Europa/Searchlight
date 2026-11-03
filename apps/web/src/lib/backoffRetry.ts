// A doubling delay, capped. Also the event stream's.
export const RETRY_MIN_MS = 3_000;
export const RETRY_MAX_MS = 30_000;

export interface BackoffRetry {
    /**
     * Try `attempt` after the current delay, then again with a doubling one
     * until it returns true. Replaces a run already going. Without a network
     * it waits for one; coming back online or to the tab tries right away.
     */
    start(attempt: () => Promise<boolean>): void;
    /** Stop the run going, if any. The delay it reached stays. */
    stop(): void;
    /** Back to the shortest delay, for the next wait. */
    reset(): void;
    /** Try the run going now instead of waiting out its delay. */
    tryNow(): void;
}

/**
 * Keep trying something in the background until it works. The delay carries
 * over from one run to the next until reset, so a run that keeps being
 * restarted (each attempt starting something that fails again) still backs
 * off.
 */
export function createBackoffRetry(
    minMs = RETRY_MIN_MS,
    maxMs = RETRY_MAX_MS,
): BackoffRetry {
    let delay = minMs;
    let stopRun: (() => void) | undefined;
    let tryRunNow: (() => void) | undefined;

    const stop = () => {
        stopRun?.();
    };

    const start = (attempt: () => Promise<boolean>) => {
        stop();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let inFlight = false;
        let stopped = false;

        const tryNow = async () => {
            if (stopped || inFlight) return;
            clearTimeout(timer);
            timer = undefined;
            // The `online` event tries again.
            if (typeof navigator !== "undefined" && navigator.onLine === false)
                return;
            inFlight = true;
            let done = false;
            try {
                done = await attempt();
            } catch (err) {
                console.warn("[searchlight:retry] attempt failed:", err);
            } finally {
                inFlight = false;
            }
            if (stopped) return;
            if (done) stopThis();
            else schedule();
        };
        const schedule = () => {
            const wait = delay;
            delay = Math.min(delay * 2, maxMs);
            timer = setTimeout(() => void tryNow(), wait);
        };
        const onOnline = () => void tryNow();
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") void tryNow();
        };
        const stopThis = () => {
            stopped = true;
            clearTimeout(timer);
            timer = undefined;
            window.removeEventListener("online", onOnline);
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
            if (stopRun === stopThis) {
                stopRun = undefined;
                tryRunNow = undefined;
            }
        };

        stopRun = stopThis;
        tryRunNow = () => void tryNow();
        window.addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVisibilityChange);
        schedule();
    };

    return {
        start,
        stop,
        reset: () => {
            delay = minMs;
        },
        tryNow: () => tryRunNow?.(),
    };
}
