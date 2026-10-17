import type { DistanceUnit } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import type { CompiledGame } from "@/game-definition/compile";
import type { StationCircle, StationPlace } from "@/maps/api";

const isUnit = (unit: unknown): unit is DistanceUnit =>
    unit === "meters" || unit === "kilometers" || unit === "miles";

/**
 * The game's hiding zones as the zone sidebar draws them. A station's zone is
 * a circle of its own radius, else its tier's, else the game's, times `scale`
 * (a curse can resize the zones); a polygon zone is its own area, whatever
 * the scale. Each carries its station (or a point inside the polygon) as its
 * properties.
 */
export function hidingZoneCircles(
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
    scale = 1,
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
        return turf.circle(zone.coordinates, radius * scale, {
            steps: 32,
            units: unit,
            properties: place,
        });
    });
}

/** A question's still-possible region and the zone size it was asked at. */
export interface AnsweredRegion {
    region: FeatureCollection<Polygon | MultiPolygon> | null | undefined;
    zoneScale?: number;
}

type FilterZones = (
    circles: Feature<Polygon | MultiPolygon>[],
    regions: FeatureCollection<Polygon | MultiPolygon>[],
) => Promise<number[]> | number[];

/**
 * The zones the hider can still be in, drawn at `currentScale`. A hider may
 * move within their zone, so a zone survives while it overlaps each
 * question's region on its own (see DissapearingAct), with the zone sized as
 * it was when that question was asked: a curse that resizes the zones changes
 * only what later answers say. A missing region eliminates everywhere.
 * Returns undefined once `isCurrent` turns false.
 */
export async function survivingHidingZones(
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
    answered: readonly AnsweredRegion[],
    currentScale: number,
    filterZones: FilterZones,
    isCurrent: () => boolean = () => true,
): Promise<StationCircle[] | undefined> {
    const current = hidingZoneCircles(compiled, currentScale);
    if (current.length === 0 || answered.length === 0) return current;
    if (answered.some(({ region }) => !region)) return [];

    const regionsByScale = new Map<
        number,
        FeatureCollection<Polygon | MultiPolygon>[]
    >();
    for (const { region, zoneScale = 1 } of answered) {
        const regions = regionsByScale.get(zoneScale) ?? [];
        regions.push(region!);
        regionsByScale.set(zoneScale, regions);
    }

    // Indexes into the game's zones, narrowed by each zone size in turn.
    let surviving = current.map((_, index) => index);
    for (const [scale, regions] of regionsByScale) {
        const circles =
            scale === currentScale
                ? current
                : hidingZoneCircles(compiled, scale);
        const kept = await filterZones(
            surviving.map((index) => circles[index]),
            regions,
        );
        if (!isCurrent()) return undefined;
        surviving = kept.map((index) => surviving[index]);
        if (surviving.length === 0) break;
    }
    return surviving.map((index) => current[index]);
}
