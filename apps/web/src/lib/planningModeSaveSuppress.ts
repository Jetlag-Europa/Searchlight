// The planning mode the server last set on the board. The save effect skips a
// change to exactly that value, as the server already has it. Matching the
// value, not counting updates, means an update that changes nothing (an echo
// of this user's own toggle) can't swallow a later toggle.
let serverValue: boolean | null = null;

/** The server set planning mode to `enabled`: the change isn't saved. */
export function suppressPlanningModeSave(enabled: boolean): void {
    serverValue = enabled;
}

/**
 * Whether the planning mode save effect, seeing `enabled`, should skip saving
 * it. Each check consumes the server's value, which the next change replaces.
 */
export function shouldSuppressPlanningModeSave(enabled: boolean): boolean {
    const suppressed = enabled === serverValue;
    serverValue = null;
    return suppressed;
}

/** Forget the server's value: a session is (re)loading. */
export function resetPlanningModeSaveSuppression(): void {
    serverValue = null;
}
