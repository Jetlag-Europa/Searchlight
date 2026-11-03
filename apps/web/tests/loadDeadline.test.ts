import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
    LOAD_TIMEOUT_MS,
    LoadTimeoutError,
    startLoadDeadline,
} from "@/lib/loadDeadline";

describe("load deadline", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test("passes on what comes in time", async () => {
        const deadline = startLoadDeadline();
        await expect(deadline.race(Promise.resolve(3))).resolves.toBe(3);
        await expect(
            deadline.race(Promise.reject(new Error("boom"))),
        ).rejects.toThrow("boom");
        expect(deadline.signal.aborted).toBe(false);
        deadline.clear();
    });

    test("gives up on everything at once when the time is up", async () => {
        const deadline = startLoadDeadline();
        const first = deadline.race(new Promise(() => {}));
        let second: unknown;
        void deadline
            .race(new Promise(() => {}))
            .catch((e: unknown) => (second = e));
        first.catch(() => {});
        await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1);
        expect(second).toBeUndefined();
        expect(deadline.signal.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(first).rejects.toBeInstanceOf(LoadTimeoutError);
        expect(second).toBeInstanceOf(LoadTimeoutError);
        expect(deadline.signal.aborted).toBe(true);
        expect(deadline.signal.reason).toBeInstanceOf(LoadTimeoutError);
        // Anything raced later is too late as well.
        await expect(
            deadline.race(new Promise(() => {})),
        ).rejects.toBeInstanceOf(LoadTimeoutError);
    });

    test("cleared, it never gives up and leaves no timer", async () => {
        const deadline = startLoadDeadline(1000);
        expect(vi.getTimerCount()).toBe(1);
        deadline.clear();
        expect(vi.getTimerCount()).toBe(0);
        let settled = false;
        void deadline
            .race(new Promise(() => {}))
            .finally(() => (settled = true));
        await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS * 2);
        expect(settled).toBe(false);
        expect(deadline.signal.aborted).toBe(false);
    });

    // An edit being sent may still land: only the wait ends.
    test("doesn't stop the work it raced", async () => {
        const deadline = startLoadDeadline(1000);
        let finish: (value: string) => void = () => {};
        const work = new Promise<string>((resolve) => (finish = resolve));
        const raced = deadline.race(work);
        raced.catch(() => {});
        await vi.advanceTimersByTimeAsync(1000);
        await expect(raced).rejects.toBeInstanceOf(LoadTimeoutError);
        finish("sent");
        await expect(work).resolves.toBe("sent");
    });
});
