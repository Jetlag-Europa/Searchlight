import type * as units from "@arcgis/core/core/units.js";
import * as bufferOperator from "@arcgis/core/geometry/operators/bufferOperator.js";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDensifyOperator from "@arcgis/core/geometry/operators/geodeticDensifyOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import * as projectOperator from "@arcgis/core/geometry/operators/projectOperator.js";
import Point from "@arcgis/core/geometry/Point.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
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
          /**
           * Where to centre the projection, if not on the geometry. Buffers
           * that will be overlaid, such as neighbouring regions', should
           * share one, so their common edges come out the same in each.
           */
          origin?: [number, number];
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

// The Earth's shortest radius of curvature in meters (north-south at the
// equator), where a projection's stretch grows fastest.
const MIN_EARTH_RADIUS = 6335439;
// Geodesic edges are split to this length before projecting, so each stays
// straight to within millimetres in the local projection.
const MAX_PROJECTED_SEGMENT = 5000;

let planarShortfall: number | undefined;

/**
 * How far inside the distance a planar buffer's edges dip between its
 * vertices, relative to the distance. ArcGIS draws its arcs from a fixed
 * number of segments, ignoring a finer maxDeviation, so this is measured
 * on a circle rather than asked for.
 */
function planarBufferShortfall(): number {
    if (planarShortfall === undefined) {
        const [circle] = bufferOperator.executeMany(
            [new Point({ x: 0, y: 0, spatialReference: { wkid: 3857 } })],
            [1],
        );
        planarShortfall = 0;
        for (const ring of circle.rings) {
            for (let i = 0; i + 1 < ring.length; i++) {
                const midpoint = Math.hypot(
                    (ring[i][0] + ring[i + 1][0]) / 2,
                    (ring[i][1] + ring[i + 1][1]) / 2,
                );
                planarShortfall = Math.max(planarShortfall, 1 - midpoint);
            }
        }
    }
    return planarShortfall;
}

/**
 * Buffers in an azimuthal equidistant projection on the WGS84 ellipsoid,
 * centred on `origin`, else on the geometry. A planar buffer there is
 * several times faster than a geodesic one, and as close to the true
 * distance: the projection keeps distances from its centre and stretches
 * others by no more than about ρ²/6R² at ρ from it. The planar buffer's own error is centred on the
 * distance by buffering half its shortfall farther. Returns undefined when
 * the two errors together could exceed `maxDeviation`, as when the geometry
 * spreads too far from the centre, to buffer geodesically instead.
 */
async function projectedBuffer(
    features: Feature[],
    geometries: unionTypes.GeometryUnion[],
    distance: number,
    maxDeviation: number,
    origin?: [number, number],
): Promise<unionTypes.GeometryUnion | undefined> {
    const [west, south, east, north] = turf.bbox(
        turf.featureCollection(features),
    );
    if (east - west > 90) return undefined;
    const center = turf.point(
        origin ?? [(west + east) / 2, (south + north) / 2],
    );
    // Spherical distances, so with some slack, to the farthest point the
    // buffer can reach.
    const reach =
        Math.max(
            ...[
                [west, south],
                [west, north],
                [east, south],
                [east, north],
            ].map((corner) =>
                turf.distance(center, corner, { units: "meters" }),
            ),
        ) *
            1.01 +
        distance;
    const stretch = (reach / MIN_EARTH_RADIUS) ** 2 / 6;
    const planarError = (distance * planarBufferShortfall()) / 2;
    if (distance * stretch + planarError > maxDeviation) return undefined;

    await Promise.all([projectOperator.load(), geodeticDensifyOperator.load()]);
    const [longitude, latitude] = center.geometry.coordinates;
    const local = new SpatialReference({
        wkt:
            'PROJCS["Local_Azimuthal_Equidistant",GEOGCS["GCS_WGS_1984",' +
            'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
            'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
            'PROJECTION["Azimuthal_Equidistant"],PARAMETER["False_Easting",0.0],' +
            `PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",${longitude}],` +
            `PARAMETER["Latitude_Of_Origin",${latitude}],UNIT["Meter",1.0]]`,
    });
    const projected = projectOperator.executeMany(
        geometries.map((geometry) =>
            geometry.type === "point"
                ? geometry
                : (geodeticDensifyOperator.execute(
                      geometry,
                      MAX_PROJECTED_SEGMENT,
                  ) ?? geometry),
        ),
        local,
    );
    const [buffered] = bufferOperator.executeMany(
        projected,
        Array(projected.length).fill(distance + planarError),
        { union: true, maxDeviation: planarError },
    );
    return projectOperator.execute(buffered, SpatialReference.WGS84);
}

async function geodesicBuffer(
    geometries: unionTypes.GeometryUnion[],
    distance: number,
    unit: units.LengthUnit,
    maxDeviation: number,
): Promise<unionTypes.GeometryUnion> {
    await geodesicBufferOperator.load();
    const [buffered] = geodesicBufferOperator.executeMany(
        geometries,
        Array(geometries.length).fill(distance),
        { union: true, unit, maxDeviation },
    );
    return buffered;
}

/** Pure geometry implementation: safe to import in a worker or a non-browser runtime. */
export async function calculateBuffer(
    request: BufferRequest,
): Promise<Feature<MultiPolygon>> {
    let features = request.geometry.features;
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
            features = features.filter((_, index) => reaching.has(index));
            if (!geometries.length) return turf.multiPolygon([]);
        }
    }
    const buffered =
        (await projectedBuffer(
            features,
            geometries,
            turf.convertLength(distance, unit, "meters"),
            turf.convertLength(maxDeviation, unit, "meters"),
            request.kind === "radius" ? request.origin : undefined,
        )) ?? (await geodesicBuffer(geometries, distance, unit, maxDeviation));
    const result = arcgisToGeoJSON(buffered.toJSON());
    if (result.type !== "Polygon" && result.type !== "MultiPolygon") {
        throw new Error("Buffer calculation did not return a polygon");
    }
    return turf.multiPolygon(
        result.type === "Polygon" ? [result.coordinates] : result.coordinates,
    );
}
