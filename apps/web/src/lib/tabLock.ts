import { activeSessionId, editingInOtherTab } from "@/lib/activeSession";
import { flushSessionSaves } from "@/lib/sessionState";
import { stopSSE } from "@/lib/sseManager";

// The session this tab edits, while its lock is asked for or held.
let held: { sessionId: string; release: () => void } | undefined;

function release(): void {
    held?.release();
    held = undefined;
}

/**
 * Edit `sessionId` in this tab, taking it over from any other tab or window
 * of this browser. Those share its queue and its kept copy, and two boards
 * editing through them undo each other's question changes. So the tab that
 * opens a session last edits it: the one it takes it from queues what it
 * had, stops its stream and saves nothing more (see editingInOtherTab) until
 * the player takes the session back there. `onTakenOver` runs then.
 *
 * Web Locks are shared by exactly the tabs that share storage (the iOS Home
 * Screen app has its own, like another device). Without them (Safari before
 * 15.4), tabs edit side by side, as before.
 */
export function editSessionHere(
    sessionId: string,
    onTakenOver: () => void,
): void {
    editingInOtherTab.set(false);
    if (held?.sessionId === sessionId) return;
    release();
    if (typeof navigator === "undefined" || !navigator.locks) return;
    const lock = { sessionId, release: () => {} };
    held = lock;
    navigator.locks
        .request(`searchlight-session:${sessionId}`, { steal: true }, () =>
            // Held until released, unless that happened meanwhile.
            held === lock
                ? new Promise<void>((resolve) => {
                      lock.release = resolve;
                  })
                : undefined,
        )
        .catch((err: unknown) => {
            // Stolen by a tab that opened the session since.
            if (held !== lock || (err as Error | null)?.name !== "AbortError") {
                return;
            }
            held = undefined;
            // Edits still in their debounce are queued first: the other tab
            // shows and sends them.
            flushSessionSaves(sessionId);
            stopSSE();
            editingInOtherTab.set(true);
            onTakenOver();
        });
}

// A board that shows another session, or none, doesn't edit this one.
activeSessionId.listen((id) => {
    if (id === held?.sessionId) return;
    release();
    editingInOtherTab.set(false);
});
