import { editingInOtherTab } from "@/lib/activeSession";

// One held Web Lock per tab for the active local session. Separate lock
// prefix from online `tabLock.ts` so local and online tabs never collide.
let held: { sessionId: string; release: () => void } | undefined;

export function releaseLocalSessionLock(): void {
    held?.release();
    held = undefined;
    editingInOtherTab.set(false);
}

/**
 * Acquires exclusive edit ownership of local `sessionId` in this tab,
 * stealing it from any other tab that had the same local session open.
 * Resolves once this tab owns the lock (or immediately when Web Locks aren't
 * supported). When another tab later steals the lock, `onTakenOver` runs and
 * `editingInOtherTab` becomes true so this tab stops editing and offers
 * "Use here" (OtherTabNotice).
 */
export function acquireLocalSessionLock(
    sessionId: string,
    onTakenOver: () => void,
): Promise<void> {
    editingInOtherTab.set(false);
    if (held?.sessionId === sessionId) return Promise.resolve();
    releaseLocalSessionLock();

    if (typeof navigator === "undefined" || !navigator.locks) {
        return Promise.resolve();
    }

    return new Promise<void>((resolveAcquired) => {
        const lock = { sessionId, release: () => {} };
        held = lock;
        let acquired = false;

        navigator.locks
            .request(
                `searchlight-local-session:${sessionId}`,
                { steal: true },
                () => {
                    acquired = true;
                    resolveAcquired();
                    return held === lock
                        ? new Promise<void>((resolveRelease) => {
                              lock.release = resolveRelease;
                          })
                        : undefined;
                },
            )
            .catch((err: unknown) => {
                if (!acquired) resolveAcquired();
                if (
                    held !== lock ||
                    (err as Error | null)?.name !== "AbortError"
                ) {
                    return;
                }
                held = undefined;
                onTakenOver();
                editingInOtherTab.set(true);
            });
    });
}
