import type * as units from "@arcgis/core/core/units.js";
import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { BLANK_GEOJSON } from "@/maps/api";

import { requestGeometry } from "./geometryClient";

export {
    geoSpatialVoronoi,
    geoSpatialVoronoiSafe,
} from "@/maps/geo-utils/voronoi";

export const safeUnion = (input: FeatureCollection<Polygon | MultiPolygon>) => {
    if (input.features.length === 0) throw new Error("safeUnion: no features");
    if (input.features.length === 1) return input.features[0];
    const union = turf.union(input);
    if (union) return union;
    throw new Error("safeUnion: union returned null");
};

export const holedMask = (
    input:
        | Feature<Polygon | MultiPolygon>
        | FeatureCollection<Polygon | MultiPolygon>,
) => {
    if ("features" in input && input.features.length === 0) {
        return BLANK_GEOJSON.features[0] as Feature<Polygon>;
    }
    return turf.difference(
        turf.featureCollection([
            BLANK_GEOJSON.features[0] as Feature<Polygon>,
            "features" in input ? safeUnion(input) : input,
        ]),
    );
};

export const modifyMapData = (
    mapData: FeatureCollection<Polygon | MultiPolygon>,
    modifications:
        | FeatureCollection<Polygon | MultiPolygon>
        | Feature<Polygon | MultiPolygon>,
    withinModifications: boolean,
) =>
    // Clipping a large play area is the heaviest step of most questions; run it
    // in the geometry worker instead of blocking the UI thread.
    requestGeometry({
        kind: "clip",
        mapData,
        modifications,
        within: withinModifications,
    });

export const arcBuffer = (
    geometry: FeatureCollection,
    distance: number,
    unit: units.LengthUnit & turf.Units = "miles",
    /** How far the result may stray from the true curve; 3 ft by default. */
    maxDeviation?: number,
    /** Shared by buffers that will be overlaid; see BufferRequest. */
    origin?: [number, number],
): Promise<Feature<Polygon | MultiPolygon>> =>
    requestGeometry({
        kind: "radius",
        geometry,
        distance,
        unit,
        maxDeviation,
        origin,
    });

/**
 * Buffers `geometry` by its distance to the point. With `within`, the result
 * is exact only inside that box, which can spare buffering most of a large
 * layer; it may then be an empty MultiPolygon.
 */
export const arcBufferToPoint = (
    geometry: FeatureCollection,
    lat: number,
    lng: number,
    options: { within?: BBox; supersede?: string } = {},
): Promise<Feature<Polygon | MultiPolygon>> =>
    requestGeometry(
        { kind: "nearest", geometry, lat, lng, within: options.within },
        { supersede: options.supersede },
    );

export const arcDistanceToPoint = (
    geometry: FeatureCollection,
    lat: number,
    lng: number,
    unit: units.LengthUnit & turf.Units = "miles",
): Promise<number> =>
    requestGeometry({ kind: "distance", geometry, lat, lng, unit });
