import { atom, computed } from "nanostores";

import { disabledStations } from "@/lib/context";

/**
 * The hiding zones the latest calculation left (their ids), out of how many
 * the game has. Null while the zones are hidden or not worked out yet for the
 * game on the board.
 */
export const survivingZones = atom<{ ids: string[]; total: number } | null>(
    null,
);

export interface ZonesLeft {
    left: number;
    total: number;
    /** Zones the questions left that were disabled by hand. */
    disabled: number;
}

/**
 * The zones still left once those disabled by hand are taken out. A disabled
 * zone the questions already ruled out isn't counted again.
 */
export function countZonesLeft(
    survivingIds: readonly string[],
    disabledIds: readonly string[],
    total: number,
): ZonesLeft {
    const disabledSet = new Set(disabledIds);
    const disabled = survivingIds.filter((id) => disabledSet.has(id)).length;
    return { left: survivingIds.length - disabled, total, disabled };
}

export const zonesLeft = computed(
    [survivingZones, disabledStations],
    (zones, disabled): ZonesLeft | null =>
        zones && countZonesLeft(zones.ids, disabled, zones.total),
);
