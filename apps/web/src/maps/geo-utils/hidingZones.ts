import type { DistanceUnit } from "@searchlight/shared";
import * as turf from "@turf/turf";

import type { CompiledGame } from "@/game-definition/compile";
import type { StationCircle, StationPlace } from "@/maps/api";

const isUnit = (unit: unknown): unit is DistanceUnit =>
    unit === "meters" || unit === "kilometers" || unit === "miles";

/**
 * The game's hiding zones as the zone sidebar draws them. A station's zone is
 * a circle of its own radius, else its tier's, else the game's; a polygon
 * zone is its own area. Each carries its station (or a point inside the
 * polygon) as its properties.
 */
export function hidingZoneCircles(
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
): StationCircle[] {
    const { stations = [], baseRadius } = compiled.hidingZones;
    const tierOverrides: Record<string, number> =
        compiled.definition.hidingZones?.tierOverrides ?? {};

    return stations.map((zone) => {
        const [lng, lat] = zone.coordinates;
        const place: StationPlace = turf.point(zone.coordinates, {
            id: String(zone.id) || `${lat},${lng}`,
            name: zone.name,
            ...(zone.tier ? { tier: zone.tier } : {}),
        });
        if (zone.area) return turf.feature(zone.area, place);

        const radius =
            zone.explicitRadius ??
            (zone.tier ? tierOverrides[zone.tier] : undefined) ??
            baseRadius.value;
        const unit = isUnit(zone.radius?.unit)
            ? zone.radius.unit
            : baseRadius.unit;
        return turf.circle(zone.coordinates, radius, {
            steps: 32,
            units: unit,
            properties: place,
        });
    });
}
