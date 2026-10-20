import type { Evaluator } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";

import { arcBuffer, cellOfSite, geoSpatialVoronoiSafe } from "@/maps/geo-utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

import { cachedGeometry, geometrySource, type Region } from "./geometry";

export function getFeatureCoordinates(f: unknown): [number, number] | null {
    if (!f || typeof f !== "object") return null;
    const feat = f as Record<string, unknown>;
    const geom = feat.geometry as
        | { type?: string; coordinates?: unknown }
        | undefined;
    const coords = geom?.coordinates;
    if (
        Array.isArray(coords) &&
        coords.length >= 2 &&
        typeof coords[0] === "number" &&
        typeof coords[1] === "number"
    ) {
        return [coords[0], coords[1]];
    }
    const props = feat.properties as Record<string, unknown> | undefined;
    if (typeof props?.lon === "number" && typeof props?.lat === "number") {
        return [props.lon, props.lat];
    }
    if (typeof props?.lng === "number" && typeof props?.lat === "number") {
        return [props.lng, props.lat];
    }
    return null;
}

export function featuresMatch(a: unknown, b: unknown): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    const aCoords = getFeatureCoordinates(a);
    const bCoords = getFeatureCoordinates(b);
    if (aCoords && bCoords) {
        return aCoords[0] === bCoords[0] && aCoords[1] === bCoords[1];
    }
    if (typeof a === "object" && typeof b === "object") {
        const aObj = a as Record<string, unknown>;
        const bObj = b as Record<string, unknown>;
        if (
            aObj.id !== undefined &&
            aObj.id !== null &&
            bObj.id !== undefined &&
            bObj.id !== null
        ) {
            if (aObj.id === bObj.id) return true;
        }
    }
    return false;
}

export interface TentacleEvaluationParams {
    evaluator: Evaluator;
    datasets: Record<string, unknown>;
    data: {
        lat: number;
        lng: number;
        radius: number;
        unit: "meters" | "kilometers" | "miles";
        location: Feature<Point> | false;
        places?: unknown[];
    };
    mapGeoData: FeatureCollection<Polygon | MultiPolygon> | null | undefined;
}

/**
 * Whether a tentacle question has a radius to draw its circle with. Older
 * cards stored a cleared radius field as null; such a question eliminates
 * nothing until the player enters one.
 */
export const hasTentacleRadius = (data: { radius?: unknown }) =>
    typeof data.radius === "number" &&
    Number.isFinite(data.radius) &&
    data.radius > 0;

export async function determineTentacleGeometry({
    evaluator,
    datasets,
    data,
}: Omit<TentacleEvaluationParams, "mapGeoData" | "data"> & {
    data: Omit<TentacleEvaluationParams["data"], "location">;
}): Promise<{
    circle: Region;
    /** The sites inside the circle: the possible answers. */
    points: Feature<Point>[];
    cells: FeatureCollection<Polygon | MultiPolygon>;
}> {
    const source = geometrySource(evaluator, datasets, data);
    const build = async () => {
        // The geodesic circle radar uses. Sites count as within the radius
        // exactly when they lie inside the circle the map is clipped to.
        const circle = await arcBuffer(
            turf.featureCollection([turf.point([data.lng, data.lat])]),
            data.radius,
            data.unit,
        );
        const points =
            source?.points.filter((point) =>
                turf.booleanPointInPolygon(point, circle),
            ) ?? [];
        if (!points.length)
            return {
                circle,
                points,
                cells: turf.featureCollection<Polygon | MultiPolygon>([]),
            };
        const voronoi = geoSpatialVoronoiSafe(
            turf.featureCollection(points),
            turf.bbox(circle),
        );
        const cells: Region[] = [];
        for (const cell of voronoi.features) {
            const clipped = turf.intersect(
                turf.featureCollection([cell, circle]),
            );
            if (clipped) {
                clipped.properties = cell.properties;
                cells.push(clipped);
            }
        }
        return { circle, points, cells: turf.featureCollection(cells) };
    };
    if (!source) return build();
    return cachedGeometry(
        source,
        `tentacle:${data.lat}:${data.lng}:${data.radius}:${data.unit}`,
        build,
    );
}

export async function evaluateTentacleOperator(
    params: TentacleEvaluationParams,
): Promise<
    Feature<Polygon | MultiPolygon> | TentacleEvaluationParams["mapGeoData"]
> {
    const { data, mapGeoData } = params;
    if (!mapGeoData || !hasTentacleRadius(data)) return mapGeoData;
    const { circle, cells } = await determineTentacleGeometry(params);
    if (data.location === false) {
        return requestGeometry({
            kind: "clip",
            mapData: mapGeoData,
            modifications: circle,
            within: false,
        });
    }
    const location = getFeatureCoordinates(data.location);
    const cell =
        cells.features.find((feature) =>
            featuresMatch(feature.properties?.site, data.location),
        ) ?? (location ? cellOfSite(cells.features, location) : undefined);
    return cell
        ? requestGeometry({
              kind: "clip",
              mapData: mapGeoData,
              modifications: cell,
              within: true,
          })
        : mapGeoData;
}
