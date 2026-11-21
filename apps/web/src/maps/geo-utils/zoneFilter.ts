import * as turf from "@turf/turf";
import type { BBox, Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";

export type FilterZoneRequest = {
  kind: "filterZone";
  circles: Feature<Polygon | MultiPolygon>[];
  regions: FeatureCollection<Polygon | MultiPolygon>[];
};

const polygonsOf = (geometry: Polygon | MultiPolygon): Position[][][] =>
  geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

/**
 * The polygons of a geometry, cut to a box. A polygon whose outer ring has no
 * part in the box is left out, so a hole never stands in for it.
 */
function partInBox(geometry: Polygon | MultiPolygon, box: BBox): Position[][][] {
  const cut = (ring: Position[]) =>
    turf.bboxClip({ type: "Polygon", coordinates: [ring] }, box).geometry.coordinates[0] as
      | Position[]
      | undefined;
  const part: Position[][][] = [];
  for (const [outer, ...holes] of polygonsOf(geometry)) {
    const cutOuter = outer && cut(outer);
    if (!cutOuter) continue;
    part.push([cutOuter, ...holes.map(cut).filter((ring) => ring !== undefined)]);
  }
  return part;
}

// In degrees, about 0.01 mm: far above rounding errors, far below map detail.
const TOUCHING = 1e-10;

/** Whether a vertex of `rings` lies on an edge of `others`. */
function hasVertexOnEdge(rings: Position[][], others: Position[][]): boolean {
  for (const ring of rings) {
    for (const [x, y] of ring) {
      for (const other of others) {
        for (let i = 1; i < other.length; i++) {
          const [x1, y1] = other[i - 1];
          const dx = other[i][0] - x1;
          const dy = other[i][1] - y1;
          const length2 = dx * dx + dy * dy;
          const along = length2
            ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length2))
            : 0;
          const offX = x - (x1 + along * dx);
          const offY = y - (y1 + along * dy);
          if (offX * offX + offY * offY < TOUCHING * TOUCHING) return true;
        }
      }
    }
  }
  return false;
}

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
        throw new Error("unionRegion: feature has invalid or null geometry");
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
    // Turf tests the circle against every vertex of a feature, so test
    // only the part around the circle. The padding keeps the cut's own
    // edges off the circle, also off a zone of radius 0.
    const pad = Math.max(cBbox[2] - cBbox[0], cBbox[3] - cBbox[1]) * 0.05 || 1e-9;
    const around: BBox = [cBbox[0] - pad, cBbox[1] - pad, cBbox[2] + pad, cBbox[3] + pad];
    const onCircle = turf.coordAll(circle)[0];
    const circleRings = polygonsOf(circle.geometry).flat();
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
        // Most zones lie well inside most regions.
        if (turf.booleanPointInPolygon(onCircle, feature)) {
          intersectsAnyFeature = true;
          break;
        }
        const nearby = partInBox(feature.geometry, around);
        if (!nearby.length) continue;
        // Cutting moves an edge by a rounding error. That decides
        // the answer only where the zone touches the feature's edge,
        // so there the whole feature is tested.
        const nearbyRings = nearby.flat();
        const touching =
          hasVertexOnEdge(circleRings, nearbyRings) || hasVertexOnEdge(nearbyRings, circleRings);
        if (turf.booleanIntersects(circle, touching ? feature : turf.multiPolygon(nearby))) {
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
