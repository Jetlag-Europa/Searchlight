import * as turf from "@turf/turf";
import { geoMercator } from "d3-geo";
// @ts-expect-error No type declaration
import { geoProject, geoStitch } from "d3-geo-projection";
// @ts-expect-error No type declaration
import { geoVoronoi } from "d3-geo-voronoi";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";

const scaleReference = turf.toMercator(turf.point([180, 90])); // I thought this would yield the same as turf.earthRadius * Math.pi, but it's slightly larger

export const geoSpatialVoronoi = (
    points: FeatureCollection<Point>,
): FeatureCollection<Polygon | MultiPolygon> => {
    const voronoi = geoVoronoi()(points).polygons();
    const projected = geoProject(
        geoStitch(voronoi),
        geoMercator().translate([0, 0]).precision(0.005),
    );

    const ratio = scaleReference.geometry.coordinates[0] / 480.5; // 961 is the default scale for some reason

    turf.coordEach(projected, (coord) => {
        coord[0] = coord[0] * ratio;
        coord[1] = coord[1] * -ratio; // y-coordinates are flipped
    });

    return turf.toWgs84(projected);
};

/**
 * geoSpatialVoronoi reprojects a spherical Voronoi through Mercator, which
 * produces overlapping/gappy cells for tightly-clustered sites (e.g. 3
 * consulates within ~150 m) — a point can then land in no cell or several. This
 * variant detects that (every site must lie in its own cell) and, if degenerate,
 * recomputes a planar Voronoi clipped to `fallbackBbox`, which tiles cleanly.
 * Planar cells carry the same `properties.site` as the spherical ones (matched
 * by input index) so callers can use them interchangeably.
 */
export const geoSpatialVoronoiSafe = (
    points: FeatureCollection<Point>,
    fallbackBbox: BBox,
): FeatureCollection<Polygon | MultiPolygon> => {
    const spherical = geoSpatialVoronoi(points);

    if (points.features.length < 2) return spherical;

    const sound = spherical.features.every((f) => {
        const site = (f.properties as { site?: Feature<Point> } | undefined)?.site;
        if (!f?.geometry || !site) return false;
        try {
            return turf.booleanPointInPolygon(site, f as Feature<Polygon | MultiPolygon>);
        } catch {
            return false;
        }
    });
    if (sound) return spherical;

    const planar = turf.voronoi(points, { bbox: fallbackBbox });
    const features: Feature<Polygon | MultiPolygon>[] = [];
    planar.features.forEach((f, i) => {
        if (f?.geometry) {
            f.properties = { ...(f.properties ?? {}), site: points.features[i] };
            features.push(f as Feature<Polygon | MultiPolygon>);
        }
    });
    return turf.featureCollection(features);
};
