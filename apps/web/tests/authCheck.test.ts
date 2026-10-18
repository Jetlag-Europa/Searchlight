import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("window", new EventTarget());

import { authCheckOutcome, authRetryDelay, watchAuth } from "@/lib/authCheck";

describe("/me outcome", () => {
    test("only a 401 signs the visitor out", () => {
        expect(authCheckOutcome(401)).toBe("signed-out");
    });

    test("a 2xx signs them in", () => {
        expect(authCheckOutcome(200)).toBe("signed-in");
    });

    test.each([undefined, 403, 404, 429, 500, 502, 503, 504])(
        "%s is a blip to retry, not a logout",
        (status) => {
            expect(authCheckOutcome(status)).toBe("unreachable");
        },
    );
});

describe("/me retry delay", () => {
    test("doubles from 2 seconds up to 30", () => {
        expect([1, 2, 3, 4, 5, 6, 20].map(authRetryDelay)).toEqual([
            2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
        ]);
    });
});

describe("watching /me", () => {
    const me = { user: { discordId: "u1" }, preferences: {} };
    const handlers = {
        signedIn: vi.fn(),
        signedOut: vi.fn(),
        unreachable: vi.fn(),
    };
    let stop: () => void;

    function answer(status: number) {
        return new Response(status === 200 ? JSON.stringify(me) : null, {
            status,
        });
    }

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        mockFetch.mockReset();
        for (const handler of Object.values(handlers)) handler.mockReset();
    });

    afterEach(() => {
        stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("a 502 shows the retry state, and a later 200 signs in", async () => {
        mockFetch
            .mockResolvedValueOnce(answer(502))
            .mockResolvedValueOnce(answer(200));
        stop = watchAuth("/me", handlers);
        await vi.advanceTimersByTimeAsync(0);
        expect(handlers.unreachable).toHaveBeenCalledTimes(1);
        expect(handlers.signedIn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(handlers.signedIn).toHaveBeenCalledWith(me);
        expect(handlers.signedOut).not.toHaveBeenCalled();
    });

    test("a 502 then a 401 signs out", async () => {
        mockFetch
            .mockResolvedValueOnce(answer(502))
            .mockResolvedValueOnce(answer(401));
        stop = watchAuth("/me", handlers);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(handlers.unreachable).toHaveBeenCalledTimes(1);
        expect(handlers.signedOut).toHaveBeenCalledTimes(1);
        expect(handlers.signedIn).not.toHaveBeenCalled();
    });

    test("a hanging request times out into the retry state", async () => {
        mockFetch.mockImplementationOnce(
            (_url: string, init: RequestInit) =>
                new Promise((_, reject) =>
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    ),
                ),
        );
        mockFetch.mockResolvedValue(answer(200));
        stop = watchAuth("/me", handlers);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(handlers.unreachable).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(handlers.unreachable).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(handlers.signedIn).toHaveBeenCalledTimes(1);
    });

    test("checks again right away when the device comes back online", async () => {
        mockFetch
            .mockResolvedValueOnce(answer(502))
            .mockResolvedValueOnce(answer(200));
        stop = watchAuth("/me", handlers);
        await vi.advanceTimersByTimeAsync(0);
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
        expect(handlers.signedIn).toHaveBeenCalledTimes(1);
    });
});
