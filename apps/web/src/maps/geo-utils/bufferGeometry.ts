import type * as units from "@arcgis/core/core/units.js";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import Point from "@arcgis/core/geometry/Point.js";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils.js";
import type * as unionTypes from "@arcgis/core/unionTypes.js";
import { arcgisToGeoJSON, geojsonToArcGIS } from "@terraformer/arcgis";
import * as turf from "@turf/turf";
import type { BBox, Feature, FeatureCollection, MultiPolygon } from "geojson";

import { bufferDeviation, featuresReaching } from "./bufferReach";

export type BufferRequest = {
    geometry: FeatureCollection;
} & (
    | {
          kind: "radius";
          distance: number;
          unit: units.LengthUnit & turf.Units;
          /** Defaults to 3 ft. */
          maxDeviation?: number;
      }
    | {
          kind: "nearest";
          lat: number;
          lng: number;
          /**
           * The result need only be exact inside this box: features that
           * cannot come within the seeker's distance of it are not buffered.
           */
          within?: BBox;
      }
);
export type DistanceRequest = {
    kind: "distance";
    geometry: FeatureCollection;
    lat: number;
    lng: number;
    unit: units.LengthUnit & turf.Units;
};

async function geodeticDistanceToPoint(
    geometries: unionTypes.GeometryUnion[],
    lat: number,
    lng: number,
    unit: units.LengthUnit & turf.Units,
): Promise<number> {
    await geodeticDistanceOperator.load();
    const point = new Point({ latitude: lat, longitude: lng });
    let nearest = Infinity;
    for (const geometry of geometries) {
        nearest = Math.min(
            nearest,
            geodeticDistanceOperator.execute(geometry, point, { unit }),
        );
    }
    return nearest;
}

export async function calculateDistance(
    request: DistanceRequest,
): Promise<number> {
    const geometries = request.geometry.features.map((feature) =>
        geometryJsonUtils.fromJSON(geojsonToArcGIS(feature.geometry)),
    ) as unionTypes.GeometryUnion[];
    return geodeticDistanceToPoint(
        geometries,
        request.lat,
        request.lng,
        request.unit,
    );
}

/** Pure geometry implementation: safe to import in a worker or a non-browser runtime. */
export async function calculateBuffer(
    request: BufferRequest,
): Promise<Feature<MultiPolygon>> {
    const features = request.geometry.features;
    let geometries = features.map((feature) =>
        geometryJsonUtils.fromJSON(geojsonToArcGIS(feature.geometry)),
    ) as unionTypes.GeometryUnion[];
    const unit = request.kind === "radius" ? request.unit : "miles";
    let distance: number;
    let maxDeviation: number;
    if (request.kind === "radius") {
        distance = request.distance;
        maxDeviation =
            request.maxDeviation ?? turf.convertLength(3, "feet", unit);
    } else {
        // Measured to every feature, so the seeker's distance stays exact.
        distance = await geodeticDistanceToPoint(
            geometries,
            request.lat,
            request.lng,
            unit,
        );
        maxDeviation = bufferDeviation(distance, unit);
        if (request.within) {
            // Only features that come within the distance of the box can
            // add to the buffer inside it.
            const reaching = new Set(
                featuresReaching(
                    features,
                    request.within,
                    turf.convertLength(distance, unit, "kilometers"),
                ),
            );
            geometries = geometries.filter((_, index) => reaching.has(index));
            if (!geometries.length) return turf.multiPolygon([]);
        }
    }
    await geodesicBufferOperator.load();
    const buffered = geodesicBufferOperator.executeMany(
        geometries,
        Array(geometries.length).fill(distance),
        {
            union: true,
            unit,
            maxDeviation,
        },
    );
    const result = arcgisToGeoJSON(buffered[0].toJSON());
    if (result.type !== "Polygon" && result.type !== "MultiPolygon") {
        throw new Error("Buffer calculation did not return a polygon");
    }
    return turf.multiPolygon(
        result.type === "Polygon" ? [result.coordinates] : result.coordinates,
    );
}
