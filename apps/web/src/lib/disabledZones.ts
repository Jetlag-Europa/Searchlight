import { persistentAtom } from "@nanostores/persistent";
import { computed } from "nanostores";

import { activeSessionId } from "@/lib/activeSession";
import { readStorage } from "@/lib/safeStorage";

const DISABLED_ZONES_KEY = "disabledZones";

// Zones disabled by hand, per session: zone IDs are only unique within a game.
// Other tabs keep their sessions' entries in the same key.
const disabledZonesBySession = persistentAtom<Record<string, string[]>>(
    DISABLED_ZONES_KEY,
    {},
    {
        encode: JSON.stringify,
        decode: JSON.parse,
    },
);
const NO_ZONES: string[] = [];

// The active session's disabled zones.
export const disabledStations = computed(
    [activeSessionId, disabledZonesBySession],
    // Another tab removing the key leaves the atom undefined.
    (sessionId, bySession) => (bySession ?? {})[sessionId] ?? NO_ZONES,
);

function storeDisabledZones(sessionId: string, ids: string[]): void {
    // Start from what is stored, not this tab's copy, which may not have
    // another tab's latest edit yet.
    let bySession = disabledZonesBySession.get();
    try {
        const stored = readStorage("localStorage", DISABLED_ZONES_KEY);
        if (stored !== null) bySession = JSON.parse(stored);
    } catch {
        // A corrupt entry is replaced.
    }
    bySession = { ...(bySession ?? {}) };
    if (ids.length > 0) bySession[sessionId] = ids;
    else delete bySession[sessionId];
    disabledZonesBySession.set(bySession);
}

export function setDisabledStations(ids: string[]): void {
    const sessionId = activeSessionId.get();
    if (sessionId) storeDisabledZones(sessionId, ids);
}

/** Drop a session's disabled zones, once the session is gone. */
export function forgetDisabledZones(sessionId: string): void {
    storeDisabledZones(sessionId, []);
}
