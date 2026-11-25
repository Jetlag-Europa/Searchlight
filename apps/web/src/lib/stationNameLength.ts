import * as turf from "@turf/turf";
import { computed } from "nanostores";

import type { CompiledHidingZone } from "@/game-definition/compile";
import { compiledGameAtom } from "@/game-definition/store";
import { planningModeEnabled, questions, triggerLocalRefresh } from "@/lib/context";
import { disabledStations, sameZoneIds } from "@/lib/disabledZones";
import { zoneId } from "@/maps/geo-utils/hidingZones";

// The matching question "is your station's name as long as ours?". The rules
// count every character, spaces and punctuation included, of the name as
// spelled on the game map. It rules out zones by name, not by area.
export const STATION_NAME_LENGTH = "station-name-length";

export const nameLength = (name: string) => Array.from(name).length;

/** A Station Name Length question: it rules out zones by name, never map area. */
export const isStationNameLength = (question: { id: string; data: object }) =>
  question.id === "matching" && (question.data as { type?: unknown }).type === STATION_NAME_LENGTH;

/** The game's zone nearest a point: the seekers' station for their pin, or the hider's. */
export function nearestZone(
  zones: readonly CompiledHidingZone[],
  lat: number,
  lng: number,
): CompiledHidingZone | undefined {
  let nearest: CompiledHidingZone | undefined;
  let best = Infinity;
  for (const zone of zones) {
    const distance = turf.distance([lng, lat], zone.coordinates);
    if (distance < best) [nearest, best] = [zone, distance];
  }
  return nearest;
}

let lastRuledOut: string[] = [];

/**
 * The zones the answered station name length questions rule out. Hider mode
 * writes its answers into the cards in place, hence triggerLocalRefresh. The
 * same array while the zones are the same, so the zones aren't redrawn for
 * every edit.
 */
export const zonesRuledOutByName = computed(
  [questions, triggerLocalRefresh, compiledGameAtom, planningModeEnabled],
  (list, _refresh, compiled, planning): string[] => {
    const zones = compiled?.hidingZones.stations ?? [];
    const out = new Set<string>();
    for (const { id, data } of list) {
      if (id !== "matching" || data.type !== STATION_NAME_LENGTH) continue;
      // Like the other questions: hidden, waiting, or unlocked in planning mode rules nothing out.
      if (data.enabled === false || data.same === undefined || (planning && data.drag)) continue;
      const seekers = nearestZone(zones, data.lat, data.lng);
      if (!seekers) continue;
      const length = nameLength(seekers.name);
      for (const zone of zones) {
        if ((nameLength(zone.name) === length) !== data.same) out.add(zoneId(zone));
      }
    }
    const ids = [...out];
    if (!sameZoneIds(ids, lastRuledOut)) lastRuledOut = ids;
    return lastRuledOut;
  },
);

/**
 * All zones out of play besides those the map rules out: disabled by hand, or
 * by name length. Kept here, not in disabledZones.ts, which can't import the
 * questions.
 */
export const ruledOutZones = computed(
  [disabledStations, zonesRuledOutByName],
  (disabled, byName): string[] =>
    byName.length ? [...new Set([...disabled, ...byName])] : disabled,
);
