import * as turf from "@turf/turf";
import type { BBox, Feature } from "geojson";

// Kept apart from bufferGeometry.ts, which needs ArcGIS's browser WASM.

/**
 * How far a buffer of `distance` may stray from the true curve: 3 ft, or
 * 0.05% of the distance when that is larger. A multi-mile buffer around a
 * large layer at 3 ft runs to millions of vertices.
 */
export function bufferDeviation(distance: number, unit: turf.Units): number {
    return Math.max(turf.convertLength(3, "feet", unit), distance / 2000);
}

// The shortest a degree of latitude gets (at the equator), and a degree of
// longitude at the equator. Neither is shorter anywhere on the WGS84 ellipsoid.
const MIN_KM_PER_DEGREE_LATITUDE = 110.574;
const KM_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111.3195;

/**
 * A box containing every point within `km` (geodesic) of `bbox`. It errs on
 * the large side, taking every longitude near the poles or across the
 * antimeridian.
 */
export function bboxReach(bbox: BBox, km: number): BBox {
    const [west, south, east, north] = bbox;
    // Allows for rounding in the constants and the distance.
    const slack = 1.01;
    // Feature bboxes span their vertices, but a geodesic segment bows
    // poleward of its ends: a 100 km one at 50° by about 0.25 km.
    const pad = 0.01;
    const latitude = (km / MIN_KM_PER_DEGREE_LATITUDE) * slack + pad;
    const reachSouth = Math.max(-90, south - latitude);
    const reachNorth = Math.min(90, north + latitude);
    // A path within `km` of the box stays between these latitudes, where a
    // degree of longitude is at least as long as at the highest of them.
    const highest = Math.max(Math.abs(reachSouth), Math.abs(reachNorth));
    if (highest >= 89) return [-180, reachSouth, 180, reachNorth];
    const longitude =
        (km /
            (KM_PER_DEGREE_LONGITUDE_AT_EQUATOR *
                Math.cos((highest * Math.PI) / 180))) *
            slack +
        pad;
    if (west - longitude < -180 || east + longitude > 180) {
        return [-180, reachSouth, 180, reachNorth];
    }
    return [west - longitude, reachSouth, east + longitude, reachNorth];
}

/**
 * The indexes of the features that may come within `km` of `bbox`: the only
 * ones a buffer of that distance needs inside the box.
 */
export function featuresReaching(
    features: Feature[],
    bbox: BBox,
    km: number,
): number[] {
    const [west, south, east, north] = bboxReach(bbox, km);
    const indexes: number[] = [];
    features.forEach((feature, index) => {
        const [w, s, e, n] = turf.bbox(feature);
        if (w <= east && e >= west && s <= north && n >= south) {
            indexes.push(index);
        }
    });
    return indexes;
}
