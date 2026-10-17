import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    HANDOVER_MS,
    SHOW_AFTER_MS,
    showCalculating,
    startCalculation,
} from "@/lib/calculating";

describe("calculating question results", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
    });

    it("shows nothing for a quick answer", () => {
        const finish = startCalculation("questions");
        vi.advanceTimersByTime(SHOW_AFTER_MS - 1);
        finish();
        vi.advanceTimersByTime(SHOW_AFTER_MS + HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
    });

    it("shows a slow answer until it is done", () => {
        const finish = startCalculation("questions");
        vi.advanceTimersByTime(SHOW_AFTER_MS);
        expect(showCalculating.get()).toBe(true);
        finish();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
    });

    it("counts the map's area and then its zones as one calculation", () => {
        const questions = startCalculation("questions");
        vi.advanceTimersByTime(300);
        questions();
        vi.advanceTimersByTime(20);
        const zones = startCalculation("zones");
        // 500 ms after the area started, not after the zones did.
        vi.advanceTimersByTime(SHOW_AFTER_MS - 320);
        expect(showCalculating.get()).toBe(true);
        zones();
        vi.advanceTimersByTime(HANDOVER_MS - 1);
        expect(showCalculating.get()).toBe(true);
        const again = startCalculation("questions");
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(true);
        again();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
    });

    it("ignores an obsolete calculation finishing before or after the newer one", () => {
        const obsolete = startCalculation("questions");
        const newer = startCalculation("questions");
        obsolete();
        vi.advanceTimersByTime(SHOW_AFTER_MS + HANDOVER_MS);
        expect(showCalculating.get()).toBe(true);
        newer();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);

        const late = startCalculation("questions");
        const latest = startCalculation("questions");
        vi.advanceTimersByTime(SHOW_AFTER_MS);
        latest();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
        late();
        vi.advanceTimersByTime(SHOW_AFTER_MS + HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
    });

    it("waits for every source", () => {
        const questions = startCalculation("questions");
        const zones = startCalculation("zones");
        vi.advanceTimersByTime(SHOW_AFTER_MS);
        questions();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(true);
        zones();
        questions();
        vi.advanceTimersByTime(HANDOVER_MS);
        expect(showCalculating.get()).toBe(false);
    });
});
