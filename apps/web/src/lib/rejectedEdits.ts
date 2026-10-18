import { toast } from "react-toastify";

import { activeSessionId } from "@/lib/activeSession";
import type { EventType } from "@/lib/eventQueue";
import { classifySendFailure, onEventRejected } from "@/lib/syncManager";

// What a toast calls an edit the server refused.
const REJECTED_EDITS: Record<EventType, string> = {
    "stroke.create": "A drawing",
    "stroke.delete": "Erasing a drawing",
    "questions.replace": "Your question changes",
    "hider.update": "The hider's position",
    "planning.toggle": "Planning mode",
};

// Edits flushed together are often refused together: wait this long so they
// cause one reload.
export const RELOAD_DELAY_MS = 250;

interface Options {
    /** A session load is running: it reads the server after its flush. */
    isLoading: () => boolean;
    /** Load the active session again, as after selecting it. */
    reload: () => void;
    /**
     * A write got a 403/404, which a proxy can answer too: forget the
     * session only if the server says it's gone. The edit stays queued.
     */
    confirmUnavailable: (sessionId: string) => void;
}

/**
 * Handle the edits to the board's session the server refused for good (see
 * onEventRejected): say what couldn't be saved, and load the session again
 * so the board shows the server's state instead. Returns a function that
 * stops listening.
 */
export function handleRejectedEdits({
    isLoading,
    reload,
    confirmUnavailable,
}: Options): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reloadNeeded = false;

    const schedule = (sessionId: string, needsReload: boolean) => {
        reloadNeeded ||= needsReload;
        if (timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            const shouldReload = reloadNeeded;
            reloadNeeded = false;
            if (activeSessionId.get() !== sessionId) return;
            // A reload checks the session too.
            if (shouldReload) reload();
            else confirmUnavailable(sessionId);
        }, RELOAD_DELAY_MS);
    };

    const unlisten = onEventRejected((event, status) => {
        const { sessionId, type } = event;
        // Another session's board isn't shown, and loads from the server
        // when it is.
        if (activeSessionId.get() !== sessionId) return;
        if (classifySendFailure(status) === "unavailable") {
            schedule(sessionId, false);
            return;
        }
        toast.error(
            `${REJECTED_EDITS[type]} couldn't be saved (error ${status}), so the board shows what's saved instead.`,
            { toastId: `rejected-${type}` },
        );
        if (!isLoading()) schedule(sessionId, true);
    });

    return () => {
        unlisten();
        clearTimeout(timer);
        timer = undefined;
        reloadNeeded = false;
    };
}
