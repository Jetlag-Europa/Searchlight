import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const toastError = vi.hoisted(() => vi.fn());
vi.mock("react-toastify", () => ({ toast: { error: toastError } }));

import { activeSessionId } from "@/lib/activeSession";
import { enqueueEvent } from "@/lib/eventQueue";
import { handleRejectedEdits, RELOAD_DELAY_MS } from "@/lib/rejectedEdits";
import { flushPendingEvents } from "@/lib/syncManager";

const SID = "rejected-session";

function queueStrokes(count: number) {
    for (let i = 0; i < count; i++) {
        enqueueEvent({
            sessionId: SID,
            type: "stroke.create",
            payloadJson: { properties: { clientUuid: `s${i}` } },
            clientUuid: `stroke-create-s${i}`,
            clientCreatedAt: 1,
        });
    }
}

describe("rejected edits", () => {
    const reload = vi.fn();
    const confirmUnavailable = vi.fn();
    let loading = false;
    let stop: () => void;

    beforeEach(() => {
        store.clear();
        mockFetch.mockReset();
        toastError.mockReset();
        reload.mockReset();
        confirmUnavailable.mockReset();
        loading = false;
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        activeSessionId.set(SID);
        stop = handleRejectedEdits({
            isLoading: () => loading,
            reload,
            confirmUnavailable,
        });
    });

    afterEach(() => {
        stop();
        activeSessionId.set("");
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("many refused edits share one toast and one reload", async () => {
        queueStrokes(20);
        mockFetch.mockResolvedValue(new Response(null, { status: 400 }));
        await flushPendingEvents(SID);
        expect(mockFetch).toHaveBeenCalledTimes(20);
        // react-toastify shows one toast per toastId.
        const ids = new Set(
            toastError.mock.calls.map(([, opts]) => opts.toastId),
        );
        expect(ids).toEqual(new Set(["rejected-stroke.create"]));
        expect(toastError.mock.calls[0][0]).toBe(
            "A drawing couldn't be saved (error 400), so the board shows what's saved instead.",
        );
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(confirmUnavailable).not.toHaveBeenCalled();
    });

    test("a session load in progress isn't loaded again", async () => {
        loading = true;
        queueStrokes(1);
        mockFetch.mockResolvedValue(new Response(null, { status: 413 }));
        await flushPendingEvents(SID);
        await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(reload).not.toHaveBeenCalled();
    });

    test("another session's refused edits say and reload nothing", async () => {
        activeSessionId.set("other-session");
        queueStrokes(1);
        mockFetch.mockResolvedValue(new Response(null, { status: 400 }));
        await flushPendingEvents(SID);
        await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
        expect(toastError).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
    });

    test("a 403/404 only asks the server once whether the session is gone", async () => {
        queueStrokes(3);
        mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
        await flushPendingEvents(SID);
        await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
        expect(toastError).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(confirmUnavailable).toHaveBeenCalledExactlyOnceWith(SID);
    });
});
