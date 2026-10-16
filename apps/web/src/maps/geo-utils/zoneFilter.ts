import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

export type FilterZoneRequest = {
    kind: "filterZone";
    circles: Feature<Polygon | MultiPolygon>[];
    regions: FeatureCollection<Polygon | MultiPolygon>[];
};

export function calculateFilterZoneIndexes(
    circles: Feature<Polygon | MultiPolygon>[],
    regions: FeatureCollection<Polygon | MultiPolygon>[],
): number[] {
    if (!circles || !circles.length) return [];
    if (!regions || !regions.length) return circles.map((_, i) => i);

    // Empty region yields []
    for (const r of regions) {
        if (!r || !r.features || r.features.length === 0) {
            return [];
        }
        for (const f of r.features) {
            if (!f || !f.geometry) {
                throw new Error(
                    "unionRegion: feature has invalid or null geometry",
                );
            }
        }
    }

    // Precompute region features and their bounding boxes without expensive union
    const preparedRegions = regions.map((r) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const features = r.features.map((f) => {
            const bbox = turf.bbox(f);
            minX = Math.min(minX, bbox[0]);
            minY = Math.min(minY, bbox[1]);
            maxX = Math.max(maxX, bbox[2]);
            maxY = Math.max(maxY, bbox[3]);
            return { feature: f, bbox };
        });
        return {
            bbox: [minX, minY, maxX, maxY] as BBox,
            features,
        };
    });

    // Precompute circle bounding boxes
    const circleBboxes: BBox[] = circles.map((c) => turf.bbox(c));

    const surviving: number[] = [];
    for (let i = 0; i < circles.length; i++) {
        const circle = circles[i];
        if (!circle || !circle.geometry) continue;
        const cBbox = circleBboxes[i];
        let intersectsAll = true;

        for (const reg of preparedRegions) {
            // Bounding box pruning: disjoint region bbox cannot intersect
            if (
                cBbox[0] > reg.bbox[2] ||
                cBbox[2] < reg.bbox[0] ||
                cBbox[1] > reg.bbox[3] ||
                cBbox[3] < reg.bbox[1]
            ) {
                intersectsAll = false;
                break;
            }

            // Circle intersects region if it intersects at least one feature
            let intersectsAnyFeature = false;
            for (const { feature, bbox: fBbox } of reg.features) {
                if (
                    cBbox[0] > fBbox[2] ||
                    cBbox[2] < fBbox[0] ||
                    cBbox[1] > fBbox[3] ||
                    cBbox[3] < fBbox[1]
                ) {
                    continue;
                }
                if (turf.booleanIntersects(circle, feature)) {
                    intersectsAnyFeature = true;
                    break;
                }
            }

            if (!intersectsAnyFeature) {
                intersectsAll = false;
                break;
            }
        }

        if (intersectsAll) {
            surviving.push(i);
        }
    }

    return surviving;
}
