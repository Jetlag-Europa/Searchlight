import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

type Region = Feature<Polygon | MultiPolygon>;

// Decimal places of a degree to round to, finest first: from 0.1 mm to 10 cm.
const RETRY_PRECISIONS = [9, 8, 7, 6];

/**
 * Runs a Turf polygon operation, and again on rounded coordinates if it
 * throws. Turf's clipper gives up ("Unable to complete output ring") when a
 * vertex of one input lies on an edge of the other to within floating-point
 * rounding. A chain of intersections produces that: an earlier result has
 * vertices where it cut the play area's border, and a later region has the
 * same border as one long edge. Rounding moves the vertices by far less than
 * any question measures, which is enough for the clipper to finish. The
 * first rounding has rescued every case seen; the coarser ones are for
 * coordinates that are already that short.
 */
function robustly(
  operation: (features: FeatureCollection<Polygon | MultiPolygon>) => Region | null,
  features: Region[],
): Region | null {
  try {
    return operation(turf.featureCollection(features));
  } catch (error) {
    // A region with a NaN or Infinity coordinate has to keep failing:
    // rounding its other coordinates can make the clipper finish, with
    // an area that means nothing.
    let finite = true;
    for (const feature of features) {
      turf.coordEach(feature, (coord) => {
        if (!coord.every(Number.isFinite)) finite = false;
      });
    }
    if (!finite) throw error;
    for (const precision of RETRY_PRECISIONS) {
      try {
        return operation(
          turf.featureCollection(features.map((feature) => turf.truncate(feature, { precision }))),
        );
      } catch {
        // Try the next, coarser rounding.
      }
    }
    throw error;
  }
}

const intersect = (features: Region[]) => robustly(turf.intersect, features);
const difference = (features: Region[]) => robustly(turf.difference, features);
const union = (features: Region[]) => robustly(turf.union, features);

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
    let far = difference([regions[index], buffers[candidate]]);
    if (!far) return;
    // When regions overlap, the first containing source wins for both
    // hider answers and map geometry.
    for (let previous = 0; previous < index; previous++) {
      const earlier = regions[previous];
      if (!turf.booleanIntersects(far, earlier)) continue;
      far = difference([far, earlier]);
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
  return union(regions);
}

export function calculateClip({ mapData, modifications, within }: ClipRequest): Region | null {
  if (!mapData.features.length) return null;
  const base = mapData.features.length === 1 ? mapData.features[0] : union(mapData.features);
  if (!base) return null;
  let constraint: Region | null;
  if (modifications.type === "FeatureCollection") {
    if (!modifications.features.length) return within ? null : base;
    constraint =
      modifications.features.length === 1
        ? modifications.features[0]
        : union(modifications.features);
  } else {
    constraint = modifications;
  }
  if (!constraint) throw new Error("Could not combine question constraint");
  return within ? intersect([base, constraint]) : difference([base, constraint]);
}
