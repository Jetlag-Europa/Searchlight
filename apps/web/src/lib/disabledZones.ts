import { MAX_DISABLED_ZONES, MAX_ZONE_ID_LENGTH } from "@searchlight/shared";
import { atom } from "nanostores";

import { readStorage, removeStorage, writeStorage } from "@/lib/safeStorage";

// The active session's zones disabled by hand, as the board shows them: the
// server's list with this device's unsaved changes on top (see
// showDisabledZones in sessionState). Several players build the list up a
// zone at a time, so changes are saved as deltas, never as the whole list.
export const disabledStations = atom<string[]>([]);

/** A change to the disabled zones: the zones to add and to remove. */
export interface ZonesDelta {
    disableZoneIds: string[];
    enableZoneIds: string[];
}

type EditListener = (delta: ZonesDelta) => void;
let editListener: EditListener | undefined;

/**
 * Hear about the player's own edits (see setDisabledStations), to save them.
 * Returns a function that stops listening.
 */
export function onDisabledZonesEdit(listener: EditListener): () => void {
    editListener = listener;
    return () => {
        if (editListener === listener) editListener = undefined;
    };
}

/**
 * Show the zones the player chose, and save the difference to what the board
 * showed. The delta is taken right away: an update from another player
 * landing before a save is scheduled would otherwise hide the edit.
 */
export function setDisabledStations(ids: string[]): void {
    const delta = diffZoneIds(disabledStations.get(), ids);
    disabledStations.set(ids);
    if (!isNoZonesChange(delta)) editListener?.(delta);
}

/** Disable a zone, or enable it again, against the board's current list. */
export function toggleDisabledZone(id: string): void {
    const current = disabledStations.get();
    setDisabledStations(
        current.includes(id)
            ? current.filter((x) => x !== id)
            : [...current, id],
    );
}

/**
 * Disable all these zones, keeping the ones already disabled: the questions
 * may have ruled those out, so they aren't among the zones listed.
 */
export function disableZones(ids: readonly string[]): void {
    setDisabledStations([...new Set([...disabledStations.get(), ...ids])]);
}

/** The same zones, in any order. */
export function sameZoneIds(
    a: readonly string[],
    b: readonly string[],
): boolean {
    const ids = new Set(a);
    return ids.size === new Set(b).size && b.every((id) => ids.has(id));
}

export function isNoZonesChange(delta: ZonesDelta): boolean {
    return (
        delta.disableZoneIds.length === 0 && delta.enableZoneIds.length === 0
    );
}

/** What changes `from` into `to`. */
export function diffZoneIds(
    from: readonly string[],
    to: readonly string[],
): ZonesDelta {
    const before = new Set(from);
    const after = new Set(to);
    return {
        disableZoneIds: [...after].filter((id) => !before.has(id)),
        enableZoneIds: [...before].filter((id) => !after.has(id)),
    };
}

export function applyZonesDelta(
    ids: readonly string[],
    delta: ZonesDelta,
): string[] {
    const result = new Set(ids);
    for (const id of delta.disableZoneIds) result.add(id);
    for (const id of delta.enableZoneIds) result.delete(id);
    return [...result];
}

function zoneIdList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
}

/** A queued zones.disabled event's delta, read defensively from storage. */
export function zonesDeltaOf(payload: unknown): ZonesDelta {
    const { disableZoneIds, enableZoneIds } = (payload ?? {}) as Record<
        string,
        unknown
    >;
    return {
        disableZoneIds: zoneIdList(disableZoneIds),
        enableZoneIds: zoneIdList(enableZoneIds),
    };
}

// Before disabled zones synced, each device kept them per session in this
// key. A session's entry is added to the session the next time it loads (see
// loadSessionContent), then dropped; the key goes once no entry is left.
const LEGACY_DISABLED_ZONES_KEY = "disabledZones";

function readLegacyEntries(): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(
            readStorage("localStorage", LEGACY_DISABLED_ZONES_KEY) ?? "{}",
        );
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

/**
 * The zones this device disabled in a session before they synced. Only IDs
 * the server accepts: one bad ID would get the whole save refused.
 */
export function legacyDisabledZones(sessionId: string): string[] {
    const ids = zoneIdList(readLegacyEntries()?.[sessionId]).filter(
        (id) => id.length > 0 && id.length <= MAX_ZONE_ID_LENGTH,
    );
    return [...new Set(ids)].slice(0, MAX_DISABLED_ZONES);
}

/** Drop a session's legacy disabled zones from the device. */
export function forgetLegacyDisabledZones(sessionId: string): void {
    const entries = readLegacyEntries();
    if (entries === null) {
        // A corrupt entry can't be adopted.
        removeStorage("localStorage", LEGACY_DISABLED_ZONES_KEY);
        return;
    }
    if (!(sessionId in entries)) return;
    delete entries[sessionId];
    if (Object.keys(entries).length > 0) {
        writeStorage(
            "localStorage",
            LEGACY_DISABLED_ZONES_KEY,
            JSON.stringify(entries),
        );
    } else {
        removeStorage("localStorage", LEGACY_DISABLED_ZONES_KEY);
    }
}
