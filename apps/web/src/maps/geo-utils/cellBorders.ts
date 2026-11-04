import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
    Position,
} from "geojson";

type Region = Feature<Polygon | MultiPolygon>;

export interface CellBordersRequest {
    kind: "cellBorders";
    /** A partition's cells, or a layer's regions. */
    cells: Region[];
    /** Only the borders within this area are kept. */
    area: FeatureCollection<Polygon | MultiPolygon>;
}

// Borders are only drawn for context, so they may stray from the true ones by
// this fraction of the area's size: about 5 m across a 50 km play area.
const SIMPLIFY_FRACTION = 1e-4;
// Ones running this many times as close along the area's edge are left out.
// Play areas are often traced more coarsely than a game's regions, whose
// outer borders then weave tens of metres either side of the edge.
const EDGE_MARGIN = 3;
// Crossings this close to a segment's ends count as touching them.
const EPSILON = 1e-9;

/**
 * Every edge of the regions' boundaries once, as one MultiLineString: the
 * border two neighbours share is buffered once instead of twice.
 */
export function borderNetwork(regions: Region[]): Feature<MultiLineString> {
    const key = (a: Position, b: Position) => {
        const p = `${a[0]},${a[1]}`;
        const q = `${b[0]},${b[1]}`;
        return p < q ? `${p} ${q}` : `${q} ${p}`;
    };
    const seen = new Set<string>();
    const paths: Position[][] = [];
    for (const region of regions) {
        const lines = turf.flatten(turf.polygonToLine(region))
            .features as Feature<LineString>[];
        for (const line of lines) {
            const ring = line.geometry.coordinates;
            let path: Position[] = [];
            for (let i = 0; i + 1 < ring.length; i++) {
                const edge = key(ring[i], ring[i + 1]);
                if (seen.has(edge)) {
                    if (path.length > 1) paths.push(path);
                    path = [];
                    continue;
                }
                seen.add(edge);
                if (!path.length) path.push(ring[i]);
                path.push(ring[i + 1]);
            }
            if (path.length > 1) paths.push(path);
        }
    }
    return turf.multiLineString(paths);
}

/**
 * The area's edges, bucketed on a grid over its bounding box so a segment
 * is only tested against the edges near it.
 */
function edgeIndex(area: FeatureCollection<Polygon | MultiPolygon>) {
    const edges: [Position, Position][] = [];
    for (const polygon of turf.flatten(area).features) {
        for (const ring of polygon.geometry.coordinates) {
            for (let i = 0; i + 1 < ring.length; i++) {
                edges.push([ring[i], ring[i + 1]]);
            }
        }
    }
    const [minX, minY, maxX, maxY] = turf.bbox(area);
    const size = Math.min(256, Math.max(1, Math.ceil(Math.sqrt(edges.length))));
    const width = (maxX - minX) / size || 1;
    const height = (maxY - minY) / size || 1;
    const column = (x: number) =>
        Math.min(size - 1, Math.max(0, Math.floor((x - minX) / width)));
    const row = (y: number) =>
        Math.min(size - 1, Math.max(0, Math.floor((y - minY) / height)));
    const buckets: number[][] = Array.from({ length: size * size }, () => []);
    edges.forEach(([a, b], index) => {
        for (
            let c = column(Math.min(a[0], b[0]));
            c <= column(Math.max(a[0], b[0]));
            c++
        ) {
            for (
                let r = row(Math.min(a[1], b[1]));
                r <= row(Math.max(a[1], b[1]));
                r++
            ) {
                buckets[r * size + c].push(index);
            }
        }
    });
    const visited = new Int32Array(edges.length);
    let query = 0;

    /** Whether a point is within `range` of an edge of the area. */
    const near = (point: Position, range: number) => {
        const [x, y] = point;
        if (
            x < minX - range ||
            x > maxX + range ||
            y < minY - range ||
            y > maxY + range
        ) {
            return false;
        }
        for (let c = column(x - range); c <= column(x + range); c++) {
            for (let r = row(y - range); r <= row(y + range); r++) {
                for (const index of buckets[r * size + c]) {
                    const [a, b] = edges[index];
                    const ex = b[0] - a[0];
                    const ey = b[1] - a[1];
                    const t = Math.min(
                        1,
                        Math.max(
                            0,
                            ((x - a[0]) * ex + (y - a[1]) * ey) /
                                (ex * ex + ey * ey || 1),
                        ),
                    );
                    if (
                        Math.hypot(x - a[0] - t * ex, y - a[1] - t * ey) <=
                        range
                    ) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    /** Where along p→q, from 0 to 1, it meets an edge of the area. */
    const crossings = (p: Position, q: Position): number[] => {
        const crossings: number[] = [];
        if (
            Math.max(p[0], q[0]) < minX ||
            Math.min(p[0], q[0]) > maxX ||
            Math.max(p[1], q[1]) < minY ||
            Math.min(p[1], q[1]) > maxY
        ) {
            return crossings;
        }
        query++;
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        for (
            let c = column(Math.min(p[0], q[0]));
            c <= column(Math.max(p[0], q[0]));
            c++
        ) {
            for (
                let r = row(Math.min(p[1], q[1]));
                r <= row(Math.max(p[1], q[1]));
                r++
            ) {
                for (const index of buckets[r * size + c]) {
                    if (visited[index] === query) continue;
                    visited[index] = query;
                    const [a, b] = edges[index];
                    const ex = b[0] - a[0];
                    const ey = b[1] - a[1];
                    // Parallel edges, including ones along the segment, are
                    // met where the edges beside them are.
                    const denominator = dx * ey - dy * ex;
                    if (denominator === 0) continue;
                    const ax = a[0] - p[0];
                    const ay = a[1] - p[1];
                    const t = (ax * ey - ay * ex) / denominator;
                    const u = (ax * dy - ay * dx) / denominator;
                    if (t < -EPSILON || t > 1 + EPSILON) continue;
                    if (u < -EPSILON || u > 1 + EPSILON) continue;
                    crossings.push(Math.min(1, Math.max(0, t)));
                }
            }
        }
        return crossings;
    };
    return { near, crossings };
}

/**
 * The parts of the lines inside the area, leaving out any segment that runs
 * along its boundary, within `margin` of it throughout: the area's outline
 * is drawn already, and a layer's regions often trace it, if not exactly.
 */
export function clipLinesToArea(
    paths: Position[][],
    area: FeatureCollection<Polygon | MultiPolygon>,
    margin = 0,
): Position[][] {
    const { near, crossings } = edgeIndex(area);
    const inside = (point: Position) =>
        area.features.some((feature) =>
            turf.booleanPointInPolygon(point, feature, {
                ignoreBoundary: true,
            }),
        );
    const lerp = (p: Position, q: Position, t: number): Position =>
        t === 0
            ? p
            : t === 1
              ? q
              : [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    // A segment exactly on the boundary can still round off it.
    const range = Math.max(margin, 1e-12);
    const alongBoundary = (p: Position, q: Position) =>
        near(lerp(p, q, 0.5), range) && near(p, range) && near(q, range);

    const kept: Position[][] = [];
    for (const path of paths) {
        // The part being followed, empty while outside the area.
        let piece: Position[] = [];
        let within: boolean | undefined;
        const follow = (from: Position, to: Position) => {
            if (!within || alongBoundary(from, to)) {
                if (piece.length > 1) kept.push(piece);
                piece = [];
                return;
            }
            if (!piece.length) piece.push(from);
            piece.push(to);
        };
        for (let i = 0; i + 1 < path.length; i++) {
            const p = path[i];
            const q = path[i + 1];
            const ts = crossings(p, q);
            if (!ts.length) {
                // A segment meeting no edge is on one side throughout.
                within ??= inside(lerp(p, q, 0.5));
                follow(p, q);
                continue;
            }
            // Each part between crossings, and any segment touching an edge,
            // is tested by its own middle: that is robust to an edge meeting
            // the segment at an end or running along it.
            const stops = [0, ...ts.sort((a, b) => a - b), 1];
            let tested = 0;
            for (let k = 0; k + 1 < stops.length; k++) {
                if (stops[k + 1] - stops[k] <= EPSILON) continue;
                within = inside(lerp(p, q, (stops[k] + stops[k + 1]) / 2));
                follow(lerp(p, q, stops[k]), lerp(p, q, stops[k + 1]));
                tested = stops[k + 1];
            }
            // A crossing at the very end leaves the side after it untested:
            // the next segment tests its own.
            if (tested < 1) within = undefined;
        }
        if (piece.length > 1) kept.push(piece);
    }
    return kept;
}

/**
 * Every border between the cells within the area, each once and simplified,
 * or null when none is: what planning shows around the seeker's own cell.
 */
export function calculateCellBorders({
    cells,
    area,
}: CellBordersRequest): Feature<MultiLineString> | null {
    if (!cells.length || !area.features.length) return null;
    const network = borderNetwork(cells);
    const [minX, minY, maxX, maxY] = turf.bbox(area);
    const tolerance = Math.max(maxX - minX, maxY - minY) * SIMPLIFY_FRACTION;
    // Simplify can't take a line of one repeated point, which a cell's
    // zero-length edge would leave.
    const paths = clipLinesToArea(
        network.geometry.coordinates,
        area,
        tolerance * EDGE_MARGIN,
    ).filter((path) =>
        path.some(
            (point) => point[0] !== path[0][0] || point[1] !== path[0][1],
        ),
    );
    if (!paths.length) return null;
    return turf.simplify(turf.multiLineString(paths), {
        tolerance,
        mutate: true,
    });
}
