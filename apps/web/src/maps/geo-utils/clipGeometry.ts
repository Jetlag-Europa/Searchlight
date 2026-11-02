import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

type Region = Feature<Polygon | MultiPolygon>;
export interface ClipRequest {
    kind: "clip";
    mapData: FeatureCollection<Polygon | MultiPolygon>;
    modifications: FeatureCollection<Polygon | MultiPolygon> | Region;
    within: boolean;
}

export interface UnionRequest {
    kind: "union";
    regions: Region[];
}

export interface BoundaryTargetRequest {
    kind: "boundaryTarget";
    /** A layer's regions; where they overlap, the first one owns the overlap. */
    regions: Region[];
    /** The regions that can shape the target, by index into `regions`. */
    candidates: number[];
    /** Each candidate's boundary buffered by the seeker's distance. */
    buffers: Region[];
}

/**
 * Where a point is closer to its own region's boundary than the buffers'
 * distance. A point in a region is closer within that region's buffer, and a
 * point in none within any region's buffer, as it is measured to the nearest
 * region. So the target is every buffer but the part of each region beyond
 * its own buffer. Those parts never reach a region's edge, which leaves no
 * seams for slivers between neighbouring regions.
 */
export function calculateBoundaryTarget({
    regions,
    candidates,
    buffers,
}: BoundaryTargetRequest): Region | null {
    const farParts: Region[] = [];
    candidates.forEach((index, candidate) => {
        let far = turf.difference(
            turf.featureCollection([regions[index], buffers[candidate]]),
        );
        if (!far) return;
        // When regions overlap, the first containing source wins for both
        // hider answers and map geometry.
        for (let previous = 0; previous < index; previous++) {
            const earlier = regions[previous];
            if (!turf.booleanIntersects(far, earlier)) continue;
            far = turf.difference(turf.featureCollection([far, earlier]));
            if (!far) return;
        }
        farParts.push(far);
    });
    return calculateClip({
        kind: "clip",
        mapData: turf.featureCollection(buffers),
        modifications: turf.featureCollection(farParts),
        within: false,
    });
}

export function calculateUnion({ regions }: UnionRequest): Region | null {
    if (regions.length <= 1) return regions[0] ?? null;
    return turf.union(turf.featureCollection(regions));
}

export function calculateClip({
    mapData,
    modifications,
    within,
}: ClipRequest): Region | null {
    if (!mapData.features.length) return null;
    const base =
        mapData.features.length === 1
            ? mapData.features[0]
            : turf.union(mapData);
    if (!base) return null;
    let constraint: Region | null;
    if (modifications.type === "FeatureCollection") {
        if (!modifications.features.length) return within ? null : base;
        constraint =
            modifications.features.length === 1
                ? modifications.features[0]
                : turf.union(modifications);
    } else {
        constraint = modifications;
    }
    if (!constraint) throw new Error("Could not combine question constraint");
    const operands = turf.featureCollection([base, constraint]);
    return within ? turf.intersect(operands) : turf.difference(operands);
}
