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
