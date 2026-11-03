type HiderMode = false | { latitude: number; longitude: number };

// The hider position the server last set on the board. The save effect skips
// a change to exactly that value, as the server already has it. Matching the
// value, not counting updates, means an update that changes nothing (a
// spectator's always-hidden hider, or an echo) can't swallow a later move.
const NONE = Symbol("none");
let serverValue: HiderMode | typeof NONE = NONE;

/** The server set the hider to `value`: the change it causes isn't saved. */
export function suppressHiderSave(value: HiderMode): void {
    serverValue = value;
}

/**
 * Whether the hider save effect, seeing `value`, should skip saving it. Each
 * check consumes the server's value, which the next change replaces.
 */
export function shouldSuppressHiderSave(value: HiderMode): boolean {
    const suppressed = value === serverValue;
    serverValue = NONE;
    return suppressed;
}

/** Forget the server's value: a session is (re)loading. */
export function resetHiderSaveSuppression(): void {
    serverValue = NONE;
}
