import * as turf from "@turf/turf";
import type { Feature, Point } from "geojson";
import { expect, test } from "vitest";

import { geoSpatialVoronoi } from "@/maps/geo-utils/operators";

// turf's Earth radius, in metres, which its nearest-point distances use.
const EARTH_RADIUS = 6371008.8;
// Cell edges are drawn within a metre of the true boundary, so a point closer
// to it than this may fall on either side.
const BOUNDARY_MARGIN = 5;

type Vector = [number, number, number];

function unitVector(point: Feature<Point>): Vector {
    const [lng, lat] = point.geometry.coordinates.map(
        (degrees) => (degrees * Math.PI) / 180,
    );
    return [
        Math.cos(lat) * Math.cos(lng),
        Math.cos(lat) * Math.sin(lng),
        Math.sin(lat),
    ];
}

/** Metres from p to the great circle equidistant from sites a and b. */
function distanceToBisector(p: Vector, a: Vector, b: Vector) {
    const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const offset =
        Math.abs(p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / Math.hypot(...d);
    return EARTH_RADIUS * Math.asin(Math.min(1, offset));
}

test("voronoi diagram", () => {
    const BASE_POINT_COUNT = 25;
    const TEST_POINT_COUNT = 500;

    const basePoints = turf.randomPoint(BASE_POINT_COUNT);
    const voronoi = geoSpatialVoronoi(basePoints);

    expect(voronoi).toBeDefined();
    expect(voronoi.features.length).toBe(BASE_POINT_COUNT);

    const testPoints = turf.randomPoint(TEST_POINT_COUNT);

    testPoints.features.forEach((point) => {
        const voronoiIndex = voronoi.features.findIndex((feature) =>
            turf.booleanPointInPolygon(point, feature),
        );
        const basePointIndex = turf.nearestPoint(point, basePoints).properties
            .featureIndex;
        if (voronoiIndex === basePointIndex) return;

        // Only a point within BOUNDARY_MARGIN of its nearest site's cell
        // boundary may be in another cell, or in none. Moving it straight
        // towards the bisector with that other site reaches a point no
        // nearer its own site, so it is that close to the boundary.
        const p = unitVector(point);
        const a = unitVector(basePoints.features[basePointIndex]);
        const nearBisector = (site: Feature<Point>) =>
            distanceToBisector(p, a, unitVector(site)) <= BOUNDARY_MARGIN;
        const nearBoundary =
            voronoiIndex === -1
                ? basePoints.features.some(
                      (site, i) => i !== basePointIndex && nearBisector(site),
                  )
                : nearBisector(basePoints.features[voronoiIndex]);
        if (nearBoundary) return;

        expect(voronoiIndex).toBe(basePointIndex);
    });
});
