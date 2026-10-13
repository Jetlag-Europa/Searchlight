import * as turf from "@turf/turf";
import type { BBox, Feature, Point } from "geojson";
import { describe, expect, it } from "vitest";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils/voronoi";

const bounds: BBox = [-0.01, -0.01, 0.03, 0.01];

describe("safe Voronoi partitions", () => {
    it("returns no cells for no sites and gives one distinct site the whole domain", () => {
        expect(
            geoSpatialVoronoiSafe(turf.featureCollection([]), bounds).features,
        ).toEqual([]);
        const site = turf.point([0, 0], { name: "Only site" }, { id: "only" });
        const result = geoSpatialVoronoiSafe(
            turf.featureCollection([site, turf.clone(site)]),
            bounds,
        );
        expect(result.features).toHaveLength(1);
        expect(
            turf.booleanEqual(
                result.features[0].geometry,
                turf.bboxPolygon(bounds).geometry,
            ),
        ).toBe(true);
        expect(result.features[0].properties?.site.id).toBe("only");
    });

    it.each([2, 3])(
        "partitions collinear %i-site inputs without gaps, overlap, or lost site identity",
        (count) => {
            const points = turf.featureCollection(
                Array.from({ length: count }, (_, i) =>
                    turf.point([i * 0.01, 0], {}, { id: i }),
                ),
            );
            const result = geoSpatialVoronoiSafe(points, bounds);
            for (const longitude of [
                -0.005, 0.004, 0.006, 0.014, 0.016, 0.025,
            ]) {
                for (const latitude of [-0.005, 0.005]) {
                    const probe = turf.point([longitude, latitude]);
                    const cells = result.features.filter((cell) =>
                        turf.booleanPointInPolygon(probe, cell),
                    );
                    expect(cells).toHaveLength(1);
                    const site = cells[0].properties?.site as Feature<Point>;
                    expect(site.id).toBe(turf.nearestPoint(probe, points).id);
                }
            }
        },
    );
});
