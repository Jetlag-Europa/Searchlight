import "./arcgisNode";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import Point from "@arcgis/core/geometry/Point.js";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils.js";
import type * as unionTypes from "@arcgis/core/unionTypes.js";
import { geojsonToArcGIS } from "@terraformer/arcgis";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";
import { beforeAll, describe, expect, it } from "vitest";

import { calculateBuffer } from "@/maps/geo-utils/bufferGeometry";
import { bufferDeviation } from "@/maps/geo-utils/bufferReach";
import { ringsToMultiPolygon } from "@/maps/geo-utils/polygonRings";
import { regionLines } from "@/maps/questions/operators/geometry";

const belgium = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../games/preloaded/belgium-2026.game.json"),
        "utf8",
    ),
);
const province = (name: string) =>
    belgium.features
        .find((layer: { name: string }) => layer.name === "Province")
        .data.features.find(
            (feature: Feature) => feature.properties?.name === name,
        ) as Feature<Polygon | MultiPolygon>;

const toArcGIS = (fc: FeatureCollection) =>
    fc.features.map((feature) =>
        geometryJsonUtils.fromJSON(geojsonToArcGIS(feature.geometry)),
    ) as unionTypes.GeometryUnion[];

/** The farthest any point on the buffer's outline is from `meters`. */
function worstStray(
    buffer: Feature<Polygon | MultiPolygon>,
    targets: unionTypes.GeometryUnion[],
    meters: number,
): number {
    const outline = turf.coordAll(buffer);
    const step = Math.max(1, Math.floor(outline.length / 150));
    let worst = 0;
    for (let i = 0; i + 1 < outline.length; i += step) {
        // Vertices and the middles of edges, where chords fall short.
        for (const [lng, lat] of [
            outline[i],
            [
                (outline[i][0] + outline[i + 1][0]) / 2,
                (outline[i][1] + outline[i + 1][1]) / 2,
            ],
        ]) {
            const point = new Point({ longitude: lng, latitude: lat });
            const distance = Math.min(
                ...targets.map((target) =>
                    geodeticDistanceOperator.execute(target, point, {
                        unit: "meters",
                    }),
                ),
            );
            worst = Math.max(worst, Math.abs(distance - meters));
        }
    }
    return worst;
}

function geodesicBuffer(fc: FeatureCollection, miles: number) {
    const geometries = toArcGIS(fc);
    const [buffered] = geodesicBufferOperator.executeMany(
        geometries,
        geometries.map(() => miles),
        {
            union: true,
            unit: "miles",
            maxDeviation: bufferDeviation(miles, "miles"),
        },
    );
    return turf.multiPolygon(
        ringsToMultiPolygon((buffered as __esri.Polygon).rings),
    );
}

describe("buffers built in a local projection", () => {
    beforeAll(async () => {
        await Promise.all([
            geodesicBufferOperator.load(),
            geodeticDistanceOperator.load(),
        ]);
    });

    const lines = regionLines(province("Hainaut"));
    const targets = toArcGIS(lines);

    it.each([0.5, 6, 20])(
        "stay within the buffer tolerance of the true distance, at %d miles",
        async (miles) => {
            const meters = turf.convertLength(miles, "miles", "meters");
            const deviation = turf.convertLength(
                bufferDeviation(miles, "miles"),
                "miles",
                "meters",
            );
            const projected = await calculateBuffer({
                kind: "radius",
                geometry: lines,
                distance: miles,
                unit: "miles",
                maxDeviation: bufferDeviation(miles, "miles"),
            });
            const geodesic = geodesicBuffer(lines, miles);
            expect(worstStray(projected, targets, meters)).toBeLessThanOrEqual(
                deviation,
            );
            // And they cover the same ground, to within that deviation
            // along the outline.
            const apart =
                turf.area(
                    turf.difference(
                        turf.featureCollection([projected, geodesic]),
                    ) ?? turf.polygon([]),
                ) +
                turf.area(
                    turf.difference(
                        turf.featureCollection([geodesic, projected]),
                    ) ?? turf.polygon([]),
                );
            const outline = turf.length(turf.polygonToLine(geodesic) as never, {
                units: "meters",
            });
            expect(apart / outline).toBeLessThan(deviation);
        },
        60_000,
    );

    it("buffers geometry spread over a continent geodesically", async () => {
        // Lisbon and Moscow: too far apart for one local projection.
        const points = turf.featureCollection([
            turf.point([-9.14, 38.72]),
            turf.point([37.62, 55.75]),
        ]);
        const buffer = await calculateBuffer({
            kind: "radius",
            geometry: points,
            distance: 10,
            unit: "kilometers",
        });
        const pieces = turf.flatten(buffer).features;
        expect(pieces).toHaveLength(2);
        for (const piece of pieces) {
            // A 10 km circle, as the geodesic buffer draws it.
            expect(turf.area(piece) / (Math.PI * 1e8)).toBeCloseTo(1, 2);
        }
        expect(worstStray(buffer, toArcGIS(points), 10_000)).toBeLessThan(1);
    }, 60_000);
});
