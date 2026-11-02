import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
    Position,
} from "geojson";

import { domainBoxes, geoSpatialVoronoiSafe } from "./voronoi";

type Region = Feature<Polygon | MultiPolygon>;

export interface LineVoronoiRequest {
    kind: "lineVoronoi";
    /** Every part of a layer's lines, tagged with the feature it belongs to. */
    lines: { featureOrdinal: number; line: Feature<LineString> }[];
    domain: BBox;
}

// Nearest-line regions are approximated by the Voronoi cells of points sampled
// along each line, so a boundary can be off by up to a sample step. Steps
// follow the closest approach of lines that do not meet, within these bounds.
const MIN_STEP_KM = 0.025;
const MAX_STEP_KM = 0.25;
// Building the partition costs about 0.05–0.15 ms per sample, the more the
// larger the domain is than the lines.
const MAX_SAMPLES = 20_000;

/** Approximate gap between two bounding boxes, never more than the true gap. */
function bboxGapKm(a: BBox, b: BBox): number {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
    const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    const lat = Math.max(
        Math.abs(a[1]),
        Math.abs(a[3]),
        Math.abs(b[1]),
        Math.abs(b[3]),
    );
    return Math.hypot(
        dx * 111.32 * Math.cos((lat * Math.PI) / 180),
        dy * 110.57,
    );
}

/** Distance from a few of `from`'s vertices to `to`. */
function vertexDistanceKm(from: Feature<LineString>, to: Feature<LineString>) {
    const coords = from.geometry.coordinates;
    const step = Math.max(1, (coords.length - 1) / 6);
    let distance = Infinity;
    for (let k = 0; k < coords.length; k += step) {
        distance = Math.min(
            distance,
            turf.pointToLineDistance(turf.point(coords[Math.round(k)]), to, {
                units: "kilometers",
            }),
        );
    }
    return distance;
}

export function lineSampleStep(lines: LineVoronoiRequest["lines"]): number {
    const boxes = lines.map(({ line }) => turf.bbox(line));
    // Above this separation the step is MAX_STEP_KM anyway.
    let separation = 3 * MAX_STEP_KM;
    for (let i = 0; i < lines.length && separation > 3 * MIN_STEP_KM; i++) {
        for (let j = i + 1; j < lines.length; j++) {
            if (lines[i].featureOrdinal === lines[j].featureOrdinal) continue;
            if (bboxGapKm(boxes[i], boxes[j]) >= separation) continue;
            const first = lines[i].line;
            const second = lines[j].line;
            const gap = Math.min(
                vertexDistanceKm(first, second),
                vertexDistanceKm(second, first),
            );
            // Lines that cross or touch have a straight bisector where they
            // meet, which samples at any step approximate to within a step.
            // Only lines that run close without meeting need finer samples.
            if (
                gap < separation &&
                gap > 1e-6 &&
                !turf.lineIntersect(first, second).features.length
            ) {
                separation = gap;
            }
        }
    }
    let length = 0;
    for (const { line } of lines) {
        length += turf.length(line, { units: "kilometers" });
    }
    return Math.max(
        MIN_STEP_KM,
        Math.min(MAX_STEP_KM, separation / 3),
        length / MAX_SAMPLES,
    );
}

/** Evenly spaced positions along a line, both ends included. */
function samplePositions(coords: Position[], stepKm: number): Position[] {
    const lengths = [0];
    for (let i = 1; i < coords.length; i++) {
        lengths.push(lengths[i - 1] + turf.distance(coords[i - 1], coords[i]));
    }
    const total = lengths[lengths.length - 1];
    const steps = Math.max(2, Math.ceil(total / stepKm));
    const positions: Position[] = [];
    let segment = 1;
    for (let k = 0; k <= steps; k++) {
        const target = (total * k) / steps;
        while (segment < coords.length - 1 && lengths[segment] < target) {
            segment++;
        }
        const span = lengths[segment] - lengths[segment - 1];
        const t = span > 0 ? (target - lengths[segment - 1]) / span : 0;
        const [x0, y0] = coords[segment - 1];
        const [x1, y1] = coords[segment];
        positions.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    return positions;
}

/** The parts of a cell inside the boxes. */
function clipCell(cell: Region, boxes: BBox[]): Region[] {
    const [west, south, east, north] = turf.bbox(cell);
    const parts: Region[] = [];
    for (const box of boxes) {
        if (
            west > box[2] ||
            east < box[0] ||
            south > box[3] ||
            north < box[1]
        ) {
            continue;
        }
        if (
            west >= box[0] &&
            east <= box[2] &&
            south >= box[1] &&
            north <= box[3]
        ) {
            parts.push(turf.feature(cell.geometry));
            continue;
        }
        // A cell is convex on the sphere, and near enough so in lon/lat
        // within the domain, which suits this quick clip.
        const clipped = turf.bboxClip(cell, box).geometry as
            | Polygon
            | MultiPolygon;
        const polygons = (
            clipped.type === "Polygon"
                ? [clipped.coordinates]
                : clipped.coordinates
        ).filter((rings) => rings.length);
        if (polygons.length) parts.push(turf.multiPolygon(polygons));
    }
    return parts;
}

/**
 * Partition the domain by nearest line. The result holds the Voronoi cells of
 * each line feature's samples clipped to the domain, indexed by feature
 * ordinal; each feature's region is the union of its cells. Samples along a
 * line have long, thin cells that reach far outside the domain, which would
 * make that union slow.
 */
export function calculateLineVoronoi({
    lines,
    domain,
}: LineVoronoiRequest): Region[][] {
    const step = lineSampleStep(lines);
    const samples: Feature<Point>[] = [];
    for (const { featureOrdinal, line } of lines) {
        for (const position of samplePositions(
            line.geometry.coordinates,
            step,
        )) {
            samples.push(turf.point(position, { featureOrdinal }));
        }
    }
    const boxes = domainBoxes(domain);
    const cells: Region[][] = [];
    for (const cell of geoSpatialVoronoiSafe(
        turf.featureCollection(samples),
        domain,
    ).features) {
        const site = cell.properties?.site as Feature<Point> | undefined;
        const ordinal = site?.properties?.featureOrdinal as number;
        (cells[ordinal] ??= []).push(...clipCell(cell, boxes));
    }
    return cells;
}
