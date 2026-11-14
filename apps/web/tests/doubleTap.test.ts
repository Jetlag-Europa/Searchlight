import { describe, expect, it } from "vitest";

import { DOUBLE_TAP_MS, isSameDoubleTap } from "@/lib/doubleTap";

describe("isSameDoubleTap", () => {
    it("treats a quick second tap as part of the first", () => {
        expect(isSameDoubleTap(1_000, 1_000 + DOUBLE_TAP_MS - 1)).toBe(true);
    });

    it("takes a later second tap as a decision", () => {
        expect(isSameDoubleTap(1_000, 1_000 + DOUBLE_TAP_MS)).toBe(false);
    });

    it("needs a first tap", () => {
        expect(isSameDoubleTap(null, 1_000)).toBe(false);
    });

    it("doesn't take every later tap as quick after the clock goes back", () => {
        expect(isSameDoubleTap(1_000, 900)).toBe(false);
    });
});
