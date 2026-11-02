import * as turf from "@turf/turf";
import type { Feature, Point, Polygon, MultiPolygon } from "geojson";

/**
 * Shared scaffolding for the question oracles (lifted out of `tentacleOracle.ts`
 * in Phase 2 so radius / thermometer / matching / measuring can reuse it).
 *
 * The unifying idea: every question's `adjustPer*` returns a mask polygon, and
 * each scenario is checked against an **independent oracle** — a verdict for each
 * sample point computed a second, simpler way. A point is `ambiguous` when it
 * sits on a decision boundary where the real algorithm and the oracle can
 * legitimately disagree by a sliver (radius edge, Voronoi/bisector edge, each
 * drawn as a polygon); callers skip those and assert only on points
 * with a clear answer.
 */

export type OracleVerdict = "survives" | "eliminated" | "ambiguous";

export type Rect = Feature<Polygon>;

/** A rectangular game boundary from [minLng, minLat, maxLng, maxLat]. */
export function boundary(
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
): Rect {
    return turf.polygon([
        [
            [minLng, minLat],
            [maxLng, minLat],
            [maxLng, maxLat],
            [minLng, maxLat],
            [minLng, minLat],
        ],
    ]);
}

/** A regular grid of sample points covering a feature's bounding box. */
export function sampleGrid(
    area: Feature<Polygon | MultiPolygon>,
    steps: number,
): Feature<Point>[] {
    const [minX, minY, maxX, maxY] = turf.bbox(area);
    const pts: Feature<Point>[] = [];
    for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
            const lng = minX + ((maxX - minX) * i) / steps;
            const lat = minY + ((maxY - minY) * j) / steps;
            pts.push(turf.point([lng, lat]));
        }
    }
    return pts;
}

export interface GridResult {
    survives: number;
    eliminated: number;
    ambiguous: number;
    failures: string[];
}

/**
 * Compare a computed `mask` against an oracle `verdict` over a grid of points.
 * A `survives` point must be inside the mask; an `eliminated` point must be
 * outside; `ambiguous` points are skipped. Returns counts (so a test can prove
 * the scenario was non-vacuous) plus a list of mismatch descriptions.
 */
export function gridAgreement(
    mask: Feature<Polygon | MultiPolygon> | null,
    points: Feature<Point>[],
    verdict: (pt: Feature<Point>) => OracleVerdict,
): GridResult {
    let survives = 0;
    let eliminated = 0;
    let ambiguous = 0;
    const failures: string[] = [];

    for (const pt of points) {
        const v = verdict(pt);
        if (v === "ambiguous") {
            ambiguous++;
            continue;
        }
        const inMask = mask !== null && turf.booleanPointInPolygon(pt, mask);
        if (v === "survives") {
            survives++;
            if (!inMask)
                failures.push(
                    `expected SURVIVE but masked out: ${pt.geometry.coordinates}`,
                );
        } else {
            eliminated++;
            if (inMask)
                failures.push(
                    `expected ELIMINATE but kept: ${pt.geometry.coordinates}`,
                );
        }
    }

    return { survives, eliminated, ambiguous, failures };
}
