// A second tap this soon after the first is one quick double tap, not a
// decision to confirm.
export const DOUBLE_TAP_MS = 500;

/** Whether a tap at `now` is still part of the one that came at `firstAt`. */
export function isSameDoubleTap(firstAt: number | null, now: number): boolean {
    if (firstAt === null) return false;
    const elapsed = now - firstAt;
    // A clock set back in between mustn't make every later tap count as quick.
    return elapsed >= 0 && elapsed < DOUBLE_TAP_MS;
}
