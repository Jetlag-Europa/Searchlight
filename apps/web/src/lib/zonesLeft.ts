import { atom, computed } from "nanostores";

import { compiledGameAtom } from "@/game-definition/store";
import {
    disabledStations,
    displayHidingZones,
    trainStations,
} from "@/lib/context";

/**
 * Whether trainStations holds the zones worked out for the game on the
 * board. An empty list alone can't tell none left from not worked out yet.
 */
export const hidingZonesCalculated = atom<boolean>(false);

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

/** The zones left, or null while they are hidden or not worked out yet. */
export const zonesLeft = computed(
    [
        hidingZonesCalculated,
        displayHidingZones,
        compiledGameAtom,
        trainStations,
        disabledStations,
    ],
    (calculated, display, game, stations, disabled): ZonesLeft | null =>
        calculated && display && game
            ? countZonesLeft(
                  stations.map((zone) => zone.properties.properties.id),
                  disabled,
                  game.hidingZones.stations?.length ?? 0,
              )
            : null,
);
