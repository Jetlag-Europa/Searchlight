import { atom } from "nanostores";

// Quick answers would only flash the indicator.
export const SHOW_AFTER_MS = 500;
// The map's area and then its hiding zones are worked out one after the
// other; a handover this quick is still the same calculation.
export const HANDOVER_MS = 250;

// The newest calculation of each source of question results (the map's
// eliminated area, the hiding zones left in it), while it runs.
const running = new Map<string, symbol>();
let showTimer: ReturnType<typeof setTimeout> | undefined;
let endTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Whether question results have been calculating for a while, so a slow
 * answer can say so rather than look like a hung page.
 */
export const showCalculating = atom<boolean>(false);

/**
 * Whether the newest calculation of any source is running, without the
 * indicator's delay. Readers that must wait for the map to apply the answers
 * (the answer split) use this, not isLoading.
 */
export const resultsPending = atom<boolean>(false);

function update() {
    resultsPending.set(running.size > 0);
    if (running.size) {
        clearTimeout(endTimer);
        endTimer = undefined;
        showTimer ??= setTimeout(
            () => showCalculating.set(true),
            SHOW_AFTER_MS,
        );
    } else {
        endTimer ??= setTimeout(() => {
            clearTimeout(showTimer);
            showTimer = endTimer = undefined;
            showCalculating.set(false);
        }, HANDOVER_MS);
    }
}

/**
 * Marks a calculation of question results as running until the returned
 * function is called. A newer calculation from the same source takes over:
 * an obsolete one still finishing its work no longer counts.
 */
export function startCalculation(source: string): () => void {
    const token = Symbol(source);
    running.set(source, token);
    update();
    return () => {
        if (running.get(source) !== token) return;
        running.delete(source);
        update();
    };
}
