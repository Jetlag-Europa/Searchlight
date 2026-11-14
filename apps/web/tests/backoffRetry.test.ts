import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type BackoffRetry, createBackoffRetry } from "@/lib/backoffRetry";

const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
});
const network = { onLine: true };
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", page);
vi.stubGlobal("navigator", network);

describe("background retries", () => {
    let retry: BackoffRetry;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        network.onLine = true;
        page.visibilityState = "visible";
        retry = createBackoffRetry();
    });

    afterEach(() => {
        retry.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("tries after 3, 6, 12 and 24 seconds, then every 30", async () => {
        const attempt = vi.fn(async () => false);
        retry.start(attempt);
        for (const wait of [3000, 6000, 12_000, 24_000, 30_000, 30_000]) {
            const before = attempt.mock.calls.length;
            await vi.advanceTimersByTimeAsync(wait - 1);
            expect(attempt).toHaveBeenCalledTimes(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(attempt).toHaveBeenCalledTimes(before + 1);
        }
    });

    test("stops once an attempt works", async () => {
        const attempt = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(9000);
        expect(attempt).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    test("an attempt that throws is tried again", async () => {
        const attempt = vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue(true);
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(9000);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    test("tries right away when back online, and waits while offline", async () => {
        const attempt = vi.fn(async () => false);
        network.onLine = false;
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).not.toHaveBeenCalled();

        network.onLine = true;
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).toHaveBeenCalledTimes(1);
        // Then backs off again from where it was.
        await vi.advanceTimersByTimeAsync(5999);
        expect(attempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    test("a try when back online replaces the wait", async () => {
        const attempt = vi.fn(async () => false);
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(1000);
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).toHaveBeenCalledTimes(1);
        // Not again at 3 seconds: the next wait is 6.
        await vi.advanceTimersByTimeAsync(5999);
        expect(attempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    test("tryNow tries the run going right away", async () => {
        const attempt = vi.fn(async () => false);
        retry.tryNow();
        retry.start(attempt);
        retry.tryNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).toHaveBeenCalledTimes(1);
        retry.stop();
        retry.tryNow();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    test("tries right away when the tab is shown", async () => {
        const attempt = vi.fn(async () => false);
        retry.start(attempt);
        page.visibilityState = "hidden";
        page.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).not.toHaveBeenCalled();
        page.visibilityState = "visible";
        page.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    test("showing the tab while offline tries nothing", async () => {
        const attempt = vi.fn(async () => false);
        network.onLine = false;
        retry.start(attempt);
        page.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).not.toHaveBeenCalled();
    });

    test("doesn't overlap an attempt still running", async () => {
        let finish: (done: boolean) => void = () => {};
        const attempt = vi.fn(
            () => new Promise<boolean>((resolve) => (finish = resolve)),
        );
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(3000);
        expect(attempt).toHaveBeenCalledTimes(1);
        window.dispatchEvent(new Event("online"));
        page.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).toHaveBeenCalledTimes(1);

        finish(false);
        await vi.advanceTimersByTimeAsync(6000);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    test("stopped, it tries nothing more, even when back online", async () => {
        const attempt = vi.fn(async () => false);
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(3000);
        retry.stop();
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    test("an attempt in flight when stopped doesn't schedule another", async () => {
        let finish: (done: boolean) => void = () => {};
        const attempt = vi.fn(
            () => new Promise<boolean>((resolve) => (finish = resolve)),
        );
        retry.start(attempt);
        await vi.advanceTimersByTimeAsync(3000);
        retry.stop();
        finish(false);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    test("a new run replaces the one going", async () => {
        const first = vi.fn(async () => false);
        retry.start(first);
        const second = vi.fn(async () => false);
        retry.start(second);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalled();
    });

    // An attempt that works but starts something failing again, which
    // starts another run.
    test("the next run keeps the delay reached until reset", async () => {
        const first = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
        retry.start(first);
        await vi.advanceTimersByTimeAsync(9000);
        expect(first).toHaveBeenCalledTimes(2);

        const second = vi.fn(async () => false);
        retry.start(second);
        await vi.advanceTimersByTimeAsync(11_999);
        expect(second).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(2);

        retry.reset();
        const third = vi.fn(async () => false);
        retry.start(third);
        await vi.advanceTimersByTimeAsync(3000);
        expect(third).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });
});
