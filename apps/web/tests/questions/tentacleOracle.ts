import * as turf from "@turf/turf";
import type { Feature, Point, Polygon } from "geojson";

import type { Units } from "@/maps/schema";

import { sampleGrid as sampleGridArea, type OracleVerdict } from "./oracleCommon";

export type { OracleVerdict };

/** Grid over the scenario's base boundary (thin wrapper over the shared helper
 *  so existing tentacle callers can pass a scenario). */
export function sampleGrid(
    s: TentacleScenario,
    steps: number,
): Feature<Point>[] {
    return sampleGridArea(s.base, steps);
}

/**
 * Independent re-derivation of what a tentacle question *should* leave on the
 * map, computed the slow/obvious way so it can be compared against the real
 * `adjustPerTentacle` (which uses Voronoi + intersect).
 *
 * A hiding location at point `p` survives a tentacle question iff ALL hold:
 *   1. `p` is inside the game boundary (`base`).
 *   2. `p` is within `radius` of the seeker (the tentacle circle).
 *   3. among the POIs the question actually considers — those within `radius`
 *      of the seeker, since the app filters custom places to the radius first —
 *      the one nearest to `p` is the question's answer POI.
 *
 * This mirrors the game rule ("the seeker's nearest tentacle target is X, so the
 * hider must be in the region closest to X and within reach") without going
 * through any Voronoi code, so agreement between the two is real evidence.
 */

export interface TentacleScenario {
    seeker: [number, number]; // [lng, lat]
    radius: number;
    unit: Units;
    /** POI sites, each with a unique properties.name. */
    places: Feature<Point>[];
    /** properties.name of the POI the seeker's tentacle points at. */
    answerName: string;
    /** Game boundary polygon. */
    base: Feature<Polygon>;
}

export function sitesWithinRadius(s: TentacleScenario): Feature<Point>[] {
    const seeker = turf.point(s.seeker);
    return s.places.filter(
        (p) => turf.distance(seeker, p, { units: s.unit }) <= s.radius,
    );
}

/** Nearest site to `pt`, or null if no sites. Returns name + the margin to the
 *  runner-up (used to skip points too close to a Voronoi edge to assert safely). */
function nearestSite(
    pt: Feature<Point>,
    sites: Feature<Point>[],
    unit: Units,
): { name: string; margin: number } | null {
    if (sites.length === 0) return null;
    const sorted = sites
        .map((s) => ({
            name: String(s.properties?.name),
            d: turf.distance(pt, s, { units: unit }),
        }))
        .sort((a, b) => a.d - b.d);
    const margin = sorted.length > 1 ? sorted[1].d - sorted[0].d : Infinity;
    return { name: sorted[0].name, margin };
}

/**
 * Expected fate of a point. `ambiguous` means the point sits on (or near) a
 * decision boundary — the radius edge or a Voronoi edge — where floating-point
 * differences between the two algorithms are legitimate; callers skip these so
 * the test asserts only on points with a clear answer.
 */
export function oracleVerdict(
    s: TentacleScenario,
    pt: Feature<Point>,
    edgeMargin: number, // distance (in `unit`) within which we call it ambiguous
): OracleVerdict {
    const seeker = turf.point(s.seeker);
    const distToSeeker = turf.distance(seeker, pt, { units: s.unit });

    // Near the radius edge → ambiguous.
    if (Math.abs(distToSeeker - s.radius) <= edgeMargin) return "ambiguous";

    const inBase = turf.booleanPointInPolygon(pt, s.base);
    const withinRadius = distToSeeker < s.radius;
    if (!inBase || !withinRadius) return "eliminated";

    const sites = sitesWithinRadius(s);
    const nearest = nearestSite(pt, sites, s.unit);
    if (!nearest) return "eliminated"; // answer POI not even in radius
    // Near a Voronoi edge (two sites almost equidistant) → ambiguous.
    if (nearest.margin <= edgeMargin) return "ambiguous";

    return nearest.name === s.answerName ? "survives" : "eliminated";
}
