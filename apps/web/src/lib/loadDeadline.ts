// How long a session load may wait on the server (its edits sent, its state
// read, its game loaded) before the board shows the copy kept here instead.
export const LOAD_TIMEOUT_MS = 60_000;
// How long a load waits for the session's details before it starts, and for
// its queued edits to be sent before it reads the server's state anyway.
export const DETAILS_TIMEOUT_MS = 15_000;
export const FLUSH_WAIT_MS = 10_000;

/** A session load ran out of time (see startLoadDeadline). */
export class LoadTimeoutError extends Error {
    constructor() {
        super("The server took too long to answer");
        this.name = "LoadTimeoutError";
    }
}

export interface LoadDeadline {
    /** Aborted once the time is up, for reads that can just stop. */
    readonly signal: AbortSignal;
    /**
     * `work`, unless the time is up first: then a LoadTimeoutError. The work
     * itself goes on (an edit being sent may still land); nothing waits for
     * it anymore.
     */
    race<T>(work: Promise<T>): Promise<T>;
    /** The load is over: stop the clock. */
    clear(): void;
}

/** One deadline for everything a session load waits for. */
export function startLoadDeadline(ms = LOAD_TIMEOUT_MS): LoadDeadline {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new LoadTimeoutError()),
        ms,
    );
    const expired = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
            reject(controller.signal.reason),
        );
    });
    // Only a race that loses reports it.
    expired.catch(() => {});
    return {
        signal: controller.signal,
        race: (work) => Promise.race([work, expired]),
        clear: () => clearTimeout(timer),
    };
}
