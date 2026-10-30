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

import { safeUnion } from "./operators";

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

/** How the zone sidebar shows the zones. */
export type ZoneDisplayStyle =
    | "zones"
    | "stations"
    | "no-overlap"
    | "no-display";

/**
 * The layer the zone sidebar draws for the zones still in play: each zone,
 * each zone's station, or the zones merged into one shape ("no-overlap").
 * With no zones (not worked out yet, all ruled out, or all disabled by hand)
 * there is nothing to draw, in every style.
 */
export function hidingZoneLayer(
    zones: StationCircle[],
    style: ZoneDisplayStyle,
): FeatureCollection {
    if (style === "no-display" || zones.length === 0)
        return turf.featureCollection([]);
    switch (style) {
        case "no-overlap":
            return turf.featureCollection([
                safeUnion(turf.featureCollection(zones)),
            ]);
        case "stations":
            return turf.featureCollection(zones.map((zone) => zone.properties));
        default:
            return turf.featureCollection(zones);
    }
}

/** A question's still-possible region and the zone size it was asked at. */
export interface AnsweredRegion {
    region: FeatureCollection<Polygon | MultiPolygon> | null | undefined;
    zoneScale?: number;
}

export type FilterZones = (
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
    const surviving = await survivingZoneIndexes(
        compiled,
        answered,
        filterZones,
        isCurrent,
        { scale: currentScale, circles: current },
    );
    return surviving?.map((index) => current[index]);
}

/**
 * Indexes into the game's zones of those {@link survivingHidingZones} keeps.
 * `known` passes zones already drawn at one scale, to reuse them.
 */
export async function survivingZoneIndexes(
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
    answered: readonly AnsweredRegion[],
    filterZones: FilterZones,
    isCurrent: () => boolean = () => true,
    known?: { scale: number; circles: StationCircle[] },
): Promise<number[] | undefined> {
    const count = compiled.hidingZones.stations?.length ?? 0;
    let surviving = Array.from({ length: count }, (_, index) => index);
    if (count === 0 || answered.length === 0) return surviving;
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

    // Narrowed by each zone size in turn.
    for (const [scale, regions] of regionsByScale) {
        const circles =
            scale === known?.scale
                ? known.circles
                : hidingZoneCircles(compiled, scale);
        const kept = await filterZones(
            surviving.map((index) => circles[index]),
            regions,
        );
        if (!isCurrent()) return undefined;
        surviving = kept.map((index) => surviving[index]);
        if (surviving.length === 0) break;
    }
    return surviving;
}
