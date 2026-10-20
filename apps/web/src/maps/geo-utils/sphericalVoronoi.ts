import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
    Position,
} from "geojson";
import { orient3d } from "robust-predicates";

type Vector = [number, number, number];

type LonLat = [number, number];

/**
 * How far, in radians, a drawn segment may stray from its arc, given its
 * middle and half its length.
 */
type Tolerance = (middle: LonLat, halfLength: number) => number;

/**
 * A cell's corners, counterclockwise seen from outside the sphere.
 * neighbours[k] is the site across the edge from corner k to corner k + 1.
 */
interface Cell {
    corners: Vector[];
    neighbours: number[];
}

const RADIANS = Math.PI / 180;
const DEGREES = 180 / Math.PI;
// turf's Earth radius, in metres.
const EARTH_RADIUS = 6371008.8;

// Cell edges are great-circle arcs, drawn as straight lon/lat segments that
// stray at most this many metres from the arc inside the domain...
const FINE_TOLERANCE = 1;
// ...and outside it, at most this fraction of their distance from it, where
// that is more.
const TOLERANCE_GROWTH = 0.001;
const FINE = FINE_TOLERANCE / EARTH_RADIUS;
// The longest arc drawn as one segment, in radians (about 640 km).
const MAX_STEP = 0.1;
// Within this many radians of a pole a great circle's lon/lat trace bends
// sharply, so an edge passing that close is split where it is closest.
const POLE_ZONE = 0.1;
// Corners and edges within this many radians (about 6 cm) of a pole are moved
// onto it, so the cells there meet at the pole.
const POLE_SNAP = 1e-8;
// Sites within this many radians (about 0.06 mm) of each other count as one:
// the circumcentre of a triangle with two such sites is mostly rounding error.
const MERGE_DISTANCE = 1e-11;
// Corners within this many radians (about 6 mm) of each other are made one.
// Nearly cocircular sites, such as samples along a line, give corners that
// should coincide but that rounding scatters, out of order round a cell, and
// polygon clipping fails on the tiny loops that leaves.
const CORNER_SNAP = 1e-9;

const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vector, b: Vector): Vector => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
];
const neg = (v: Vector): Vector => [-v[0], -v[1], -v[2]];
const cross = (a: Vector, b: Vector): Vector => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const same = (a: Vector, b: Vector) =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const isPole = (v: Vector) => v[0] === 0 && v[1] === 0;

function normalize(v: Vector): Vector {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
}

function snapToPole(v: Vector): Vector {
    return Math.hypot(v[0], v[1]) < POLE_SNAP ? [0, 0, Math.sign(v[2])] : v;
}

function toVector(lon: number, lat: number): Vector {
    if (Math.abs(lat) >= 90) return [0, 0, Math.sign(lat)];
    const cosLat = Math.cos(lat * RADIANS);
    return [
        cosLat * Math.cos(lon * RADIANS),
        cosLat * Math.sin(lon * RADIANS),
        Math.sin(lat * RADIANS),
    ];
}

function toLonLat(v: Vector): LonLat {
    return [
        Math.atan2(v[1], v[0]) * DEGREES,
        Math.atan2(v[2], Math.hypot(v[0], v[1])) * DEGREES,
    ];
}

/** Unit normal of the great circle bisecting sites a and b, on a's side. */
const bisector = (a: Vector, b: Vector) => normalize(sub(a, b));

/** Turns to add to longitude `to` to reach it the short way from `from`. */
function turnsBetween(from: number, to: number): number {
    const step = to - from;
    return step > 180 ? -1 : step < -180 ? 1 : 0;
}

/** Union-find over 0..n - 1, each group known by its lowest member. */
function groups(n: number) {
    const parent = Array.from({ length: n }, (_, i) => i);
    const root = (i: number) => {
        while (parent[i] !== i) i = parent[i] = parent[parent[i]];
        return i;
    };
    const join = (i: number, j: number) => {
        const [a, b] = [root(i), root(j)];
        parent[Math.max(a, b)] = Math.min(a, b);
    };
    return { root, join };
}

/**
 * Each site's unit vector, or null for a site that is not finite or that
 * repeats an earlier one: the same point, possibly written another way (at
 * longitude 180 and -180, or at a pole with any longitude), or one within
 * MERGE_DISTANCE of it.
 */
export function distinctSites(points: Feature<Point>[]): (Vector | null)[] {
    const sites = points.map(({ geometry }) => {
        const [lon, lat] = geometry.coordinates;
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
        return toVector(lon - 360 * Math.round(lon / 360), lat);
    });
    // Sweep the sites in order along a skew axis, grouping each with the
    // later ones close to it; a group keeps its first site.
    const position = sites.map((v) =>
        v ? 0.6 * v[0] + 0.48 * v[1] + 0.64 * v[2] : 0,
    );
    const order = sites
        .flatMap((v, i) => (v ? [i] : []))
        .sort((i, j) => position[i] - position[j]);
    const { root, join } = groups(sites.length);
    for (let a = 0; a < order.length; a++) {
        const i = order[a];
        for (let b = a + 1; b < order.length; b++) {
            const j = order[b];
            if (position[j] - position[i] > MERGE_DISTANCE) break;
            const gap = sub(sites[i]!, sites[j]!);
            if (Math.hypot(gap[0], gap[1], gap[2]) <= MERGE_DISTANCE)
                join(i, j);
        }
    }
    return sites.map((v, i) => (root(i) === i ? v : null));
}

/** Deterministic PRNG, so callers that replace Math.random are unaffected. */
function lcg(seed: number) {
    let state = seed >>> 0 || 1;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

interface Hull {
    /** Each face's three sites, counterclockwise seen from outside. */
    faces: number[];
    /** adjacent[3f + k] is the face across f's edge from corner k to k + 1. */
    adjacent: number[];
    alive: boolean[];
}

/**
 * The convex hull of the sites' unit vectors, or null when they are all
 * coplanar. Its faces are the spherical Delaunay triangles. Sites are added
 * in shuffled order, each pending site waiting on one face it sees, and every
 * visibility test is Shewchuk's exact orient3d. A site that rounding leaves
 * inside the hull, which takes another site within a few centimetres, gets
 * no face.
 */
function convexHull(ids: number[], sites: Vector[]): Hull | null {
    // Negative when d is above face (a, b, c), counterclockwise from above.
    const orient = (a: number, b: number, c: number, d: number) => {
        const [p, q, r, s] = [sites[a], sites[b], sites[c], sites[d]];
        // Spelled out: spreading the vectors makes large builds twice as slow.
        return orient3d(
            p[0],
            p[1],
            p[2],
            q[0],
            q[1],
            q[2],
            r[0],
            r[1],
            r[2],
            s[0],
            s[1],
            s[2],
        );
    };

    // Start from a tetrahedron of well-spread sites.
    const i0 = ids[0];
    let i1 = i0;
    let best = 0;
    for (const i of ids) {
        const gap = sub(sites[i], sites[i0]);
        if (dot(gap, gap) > best) [i1, best] = [i, dot(gap, gap)];
    }
    let i2 = i0;
    best = 0;
    const axis = sub(sites[i1], sites[i0]);
    for (const i of ids) {
        const normal = cross(axis, sub(sites[i], sites[i0]));
        if (dot(normal, normal) > best) [i2, best] = [i, dot(normal, normal)];
    }
    if (best === 0) return null;
    let i3 = -1;
    best = 0;
    for (const i of ids) {
        const volume = Math.abs(orient(i0, i1, i2, i));
        if (volume > best) [i3, best] = [i, volume];
    }
    if (i3 < 0) return null;
    // Put i3 below face (i0, i1, i2).
    if (orient(i0, i1, i2, i3) < 0) [i1, i2] = [i2, i1];
    const faces = [i0, i1, i2, i0, i3, i1, i1, i3, i2, i2, i3, i0];
    const adjacent = [1, 2, 3, 3, 2, 0, 1, 3, 0, 2, 1, 0];
    const alive = [true, true, true, true];
    const pending: (number[] | undefined)[] = [];
    const mark = [0, 0, 0, 0];
    const sees = (f: number, site: number) =>
        orient(faces[3 * f], faces[3 * f + 1], faces[3 * f + 2], site) < 0;

    const waitingFace = new Int32Array(sites.length).fill(-1);
    const added = new Uint8Array(sites.length);
    added[i0] = added[i1] = added[i2] = added[i3] = 1;
    const wait = (site: number, candidates: number[]) => {
        waitingFace[site] = -1;
        for (const f of candidates) {
            if (!sees(f, site)) continue;
            waitingFace[site] = f;
            (pending[f] ??= []).push(site);
            return;
        }
    };
    for (const i of ids) if (!added[i]) wait(i, [0, 1, 2, 3]);

    const order = ids.slice();
    const random = lcg(0x9e3779b9 ^ ids.length);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }

    // mark[f] === stamp: f is visible from the site being added;
    // stamp + 1: it is not.
    let stamp = 0;
    const visible: number[] = [];
    const horizon: number[] = []; // (u, v, face beyond) per horizon edge
    const created: number[] = [];
    const faceFrom = new Int32Array(sites.length);
    for (const p of order) {
        if (added[p] || waitingFace[p] < 0) continue;
        added[p] = 1;
        stamp += 2;
        visible.length = horizon.length = created.length = 0;
        visible.push(waitingFace[p]);
        mark[waitingFace[p]] = stamp;
        for (let s = 0; s < visible.length; s++) {
            const f = visible[s];
            for (let k = 0; k < 3; k++) {
                const g = adjacent[3 * f + k];
                if (mark[g] !== stamp && mark[g] !== stamp + 1) {
                    mark[g] = sees(g, p) ? stamp : stamp + 1;
                    if (mark[g] === stamp) visible.push(g);
                }
                if (mark[g] === stamp + 1) {
                    horizon.push(
                        faces[3 * f + k],
                        faces[3 * f + ((k + 1) % 3)],
                        g,
                    );
                }
            }
        }
        // Cone the horizon to p.
        for (let h = 0; h < horizon.length; h += 3) {
            const [u, v, g] = [horizon[h], horizon[h + 1], horizon[h + 2]];
            const f = alive.length;
            faces.push(u, v, p);
            adjacent.push(g, -1, -1);
            alive.push(true);
            mark.push(0);
            for (let k = 0; k < 3; k++) {
                if (faces[3 * g + k] === v) adjacent[3 * g + k] = f;
            }
            faceFrom[u] = f;
            created.push(f);
        }
        for (const f of created) {
            const next = faceFrom[faces[3 * f + 1]];
            adjacent[3 * f + 1] = next;
            adjacent[3 * next + 2] = f;
        }
        for (const f of visible) {
            alive[f] = false;
            for (const site of pending[f] ?? []) {
                if (!added[site]) wait(site, created);
            }
            pending[f] = undefined;
        }
    }
    return { faces, adjacent, alive };
}

/** Each site's cell, from the faces around it in the hull. */
function hullCells({ faces, adjacent, alive }: Hull, sites: Vector[]) {
    // A face's outward normal is the centre of its empty circumcircle.
    const centres: Vector[] = [];
    const faceAt = new Int32Array(sites.length).fill(-1);
    alive.forEach((isAlive, f) => {
        if (!isAlive) return;
        const [a, b, c] = faces.slice(3 * f, 3 * f + 3);
        centres[f] = snapToPole(
            normalize(cross(sub(sites[b], sites[a]), sub(sites[c], sites[a]))),
        );
        faceAt[a] = faceAt[b] = faceAt[c] = f;
    });
    // Collapse shorter edges onto one face's centre, so every cell at the
    // corner gets the same point.
    const { root, join } = groups(alive.length);
    alive.forEach((isAlive, f) => {
        for (let k = 0; isAlive && k < 3; k++) {
            const gap = sub(centres[f], centres[adjacent[3 * f + k]]);
            if (Math.hypot(gap[0], gap[1], gap[2]) < CORNER_SNAP) {
                join(f, adjacent[3 * f + k]);
            }
        }
    });
    alive.forEach((isAlive, f) => {
        if (isAlive) centres[f] = centres[root(f)];
    });
    const cells: Cell[] = [];
    faceAt.forEach((start, i) => {
        if (start < 0) return;
        // Walk counterclockwise round the site, from each face to the one
        // across its edge from the previous corner to the site.
        const corners: Vector[] = [];
        const neighbours: number[] = [];
        let f = start;
        do {
            const k = faces.indexOf(i, 3 * f) - 3 * f;
            const previous = 3 * f + ((k + 2) % 3);
            corners.push(centres[f]);
            neighbours.push(faces[previous]);
            f = adjacent[previous];
        } while (f !== start && corners.length <= alive.length);
        cells[i] = { corners, neighbours };
    });
    return cells;
}

/** Orients a cell counterclockwise round its site. */
function orientCell(site: Vector, cell: Cell): Cell {
    const { corners, neighbours } = cell;
    let turn = 0;
    corners.forEach((corner, k) => {
        turn += dot(site, cross(corner, corners[(k + 1) % corners.length]));
    });
    if (turn > 0) return cell;
    return {
        corners: [corners[0], ...corners.slice(1).reverse()],
        neighbours: neighbours.slice().reverse(),
    };
}

/** Two sites split the sphere into hemispheres along their bisector. */
function hemispheres(i: number, j: number, sites: Vector[]) {
    const g = bisector(sites[i], sites[j]);
    // Corners every 90 degrees along the bisector, from its point nearest
    // the north pole.
    let top: Vector = [-g[2] * g[0], -g[2] * g[1], 1 - g[2] * g[2]];
    top =
        dot(top, top) > 1e-12 ? normalize(top) : normalize(cross(g, [1, 0, 0]));
    const side = cross(g, top);
    const corners = [top, side, neg(top), neg(side)].map(snapToPole);
    const cells: Cell[] = [];
    cells[i] = { corners, neighbours: [j, j, j, j] };
    cells[j] = { corners: corners.slice().reverse(), neighbours: [i, i, i, i] };
    return cells;
}

/**
 * Cells of three or more sites on one circle, with normal n. Every bisector
 * passes through +n and -n, so each cell is the lune between the bisectors
 * with its neighbours along the circle.
 */
function coplanarCells(ids: number[], sites: Vector[]) {
    // The circle's normal, from three well-spread sites.
    const p0 = sites[ids[0]];
    const spread = (v: Vector) => dot(v, v);
    const far = ids.reduce((best, i) =>
        spread(sub(sites[i], p0)) > spread(sub(sites[best], p0)) ? i : best,
    );
    let n: Vector = [0, 0, 0];
    for (const i of ids) {
        const normal = cross(sub(sites[far], p0), sub(sites[i], p0));
        if (spread(normal) > spread(n)) n = normal;
    }
    n = normalize(n);
    // Order the sites round the circle.
    const u = normalize(sub(p0, n.map((x) => x * dot(p0, n)) as Vector));
    const w = cross(n, u);
    const angle = (i: number) => Math.atan2(dot(sites[i], w), dot(sites[i], u));
    const ring = ids.slice().sort((i, j) => angle(i) - angle(j));
    const count = ring.length;
    // The corner between consecutive sites k and k + 1, on their circle.
    const between = ring.map((i, k) => {
        const j = ring[(k + 1) % count];
        const end = angle(j) > angle(i) ? angle(j) : angle(j) + 2 * Math.PI;
        const [cos, sin] = [
            Math.cos((angle(i) + end) / 2),
            Math.sin((angle(i) + end) / 2),
        ];
        const middle: Vector = [
            cos * u[0] + sin * w[0],
            cos * u[1] + sin * w[1],
            cos * u[2] + sin * w[2],
        ];
        // Exactly on the bisector; the midpoint only picks the sign.
        const corner = normalize(cross(n, bisector(sites[j], sites[i])));
        return snapToPole(dot(corner, middle) < 0 ? neg(corner) : corner);
    });
    const [top, bottom] = [snapToPole(n), snapToPole(neg(n))];
    const cells: Cell[] = [];
    ring.forEach((i, k) => {
        const next = ring[(k + 1) % count];
        const previous = ring[(k + count - 1) % count];
        cells[i] = orientCell(sites[i], {
            corners: [
                top,
                between[k],
                bottom,
                between[(k + count - 1) % count],
            ],
            neighbours: [next, next, previous, previous],
        });
    });
    return cells;
}

/** Angle to the box, nearly exactly at the distances that matter. */
function angleToBox([lon, lat]: LonLat, [west, south, east, north]: BBox) {
    const near = lon + 360 * Math.round(((west + east) / 2 - lon) / 360);
    const dLon = (near - Math.min(Math.max(near, west), east)) * RADIANS;
    const nearLat = Math.min(Math.max(lat, south), north);
    const dLat = (lat - nearLat) * RADIANS;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat * RADIANS) *
            Math.cos(nearLat * RADIANS) *
            Math.sin(dLon / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How far, in radians, the lon/lat segment from p to q strays from the great
 * circle with normal g.
 */
function stray([lon0, lat0]: LonLat, [lon1, lat1]: LonLat, g: Vector) {
    const span = lon1 + 360 * turnsBetween(lon0, lon1) - lon0;
    // Great circles are S-shaped across the equator in lon/lat, so the
    // segment is measured at several points, not only its middle.
    let most = 0;
    for (let k = 1; k < 6; k++) {
        const point = toVector(
            lon0 + (k / 6) * span,
            lat0 + (k / 6) * (lat1 - lat0),
        );
        most = Math.max(most, Math.abs(dot(point, g)));
    }
    return most;
}

/**
 * Points strictly between corners a and b on the bisector great circle with
 * unit normal g, travelling with +g on the left, so the lon/lat segments
 * through them stay within tolerance of the arc.
 */
function edgePoints(a: Vector, b: Vector, g: Vector, toleranceAt: Tolerance) {
    // An edge to a pole runs along a meridian, which is straight in lon/lat.
    if (same(a, b) || isPole(a) || isPole(b)) return [];
    // A lon/lat segment of length L at latitude φ strays from the great
    // circle by at most about 1.09 tan(φ) L² / 8, so a short edge away from
    // the poles needs no points.
    const gap = sub(a, b);
    const length = Math.hypot(gap[0], gap[1], gap[2]);
    const slope = Math.max(
        Math.abs(a[2]) / Math.hypot(a[0], a[1]),
        Math.abs(b[2]) / Math.hypot(b[0], b[1]),
    );
    if (length < 0.01 && slope < 10 && 1.1 * slope * length ** 2 < 4 * FINE) {
        return [];
    }
    const x = normalize(sub(a, g.map((c) => c * dot(a, g)) as Vector));
    const y = cross(g, x);
    const angleOf = (v: Vector) => {
        const angle = Math.atan2(dot(v, y), dot(v, x));
        return angle < 0 ? angle + 2 * Math.PI : angle;
    };
    const end = angleOf(b);
    // Rounding can put b just behind a on a very short edge.
    if (end > Math.PI + 0.5) return [];
    const along = (angle: number): Vector => {
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
        return [
            cos * x[0] + sin * y[0],
            cos * x[1] + sin * y[1],
            cos * x[2] + sin * y[2],
        ];
    };
    // Points along the arc, with their angle from a.
    type Stop = [angle: number, point: Vector, lonLat: LonLat];
    const stop = (angle: number, point: Vector): Stop => [
        angle,
        point,
        toLonLat(point),
    ];
    const stops = [stop(0, a)];
    if (Math.abs(g[2]) < Math.sin(POLE_ZONE)) {
        // The points nearest the poles, or the poles themselves when the
        // edge passes within POLE_SNAP of them.
        const top = normalize([-g[2] * g[0], -g[2] * g[1], 1 - g[2] * g[2]]);
        for (const nearest of [top, neg(top)]) {
            const angle = angleOf(nearest);
            if (angle > 0 && angle < end) {
                stops.push(
                    stop(
                        angle,
                        Math.abs(g[2]) < POLE_SNAP
                            ? [0, 0, Math.sign(nearest[2])]
                            : nearest,
                    ),
                );
            }
        }
    }
    stops.sort((s, t) => s[0] - t[0]);
    stops.push(stop(end, b));

    const points: Vector[] = [];
    const refine = (p: Stop, q: Stop) => {
        const length = q[0] - p[0];
        // A segment to a pole runs along a meridian.
        if (isPole(p[1]) || isPole(q[1]) || length < 1e-9) return;
        // Judged for the point of the segment nearest the domain, which is
        // within half its length of the middle.
        const middle = toLonLat(along(p[0] + length / 2));
        const excess = stray(p[2], q[2], g) / toleranceAt(middle, length / 2);
        // A chord strays from its arc with the square of its length, so a
        // segment is split into as many parts as should each fit.
        const parts = Math.max(
            Math.ceil(length / MAX_STEP),
            Math.min(8, Math.ceil(Math.sqrt(excess))),
        );
        if (parts < 2) return;
        let from = p;
        for (let k = 1; k <= parts; k++) {
            const angle = p[0] + (k / parts) * length;
            const to = k < parts ? stop(angle, along(angle)) : q;
            refine(from, to);
            if (k < parts) points.push(to[1]);
            from = to;
        }
    };
    for (let k = 1; k < stops.length; k++) {
        if (k > 1) points.push(stops[k - 1][1]);
        refine(stops[k - 1], stops[k]);
    }
    return points;
}

/** The cell's boundary, with points close enough to draw it in lon/lat. */
function cellBoundary(
    i: number,
    { corners, neighbours }: Cell,
    sites: Vector[],
    tolerance: Tolerance,
) {
    const boundary: Vector[] = [];
    corners.forEach((a, k) => {
        const b = corners[(k + 1) % corners.length];
        const j = neighbours[k];
        // Worked out from the lower site's side, so both cells get the same
        // points and the drawn cells neither overlap nor leave gaps.
        const g = bisector(sites[Math.min(i, j)], sites[Math.max(i, j)]);
        const points =
            i < j
                ? edgePoints(a, b, g, tolerance)
                : edgePoints(b, a, g, tolerance).reverse();
        for (const v of [a, ...points]) {
            if (!boundary.length || !same(boundary[boundary.length - 1], v)) {
                boundary.push(v);
            }
        }
    });
    while (
        boundary.length > 1 &&
        same(boundary[0], boundary[boundary.length - 1])
    ) {
        boundary.pop();
    }
    return boundary;
}

/** A boundary point in lon/lat, kept continuous by adding turns to lon. */
interface RingPoint {
    lon: number;
    lat: number;
    turns: number;
}

/** The point's longitude as it lies in the ring shifted by `shift` turns. */
const lonIn = (p: RingPoint, shift: number) => p.lon + 360 * (p.turns - shift);

/** Latitude where the lon/lat segment from p to q crosses the antimeridian. */
function crossingLat(p: RingPoint, q: RingPoint) {
    if (p.lat === q.lat) return p.lat;
    // From the eastern end whichever way the segment runs, so neighbouring
    // cells cut their shared edge at the same point.
    const [east, west] = p.lon > 0 ? [p, q] : [q, p];
    const t = (180 - east.lon) / (180 - east.lon + (west.lon + 180));
    return east.lat + t * (west.lat - east.lat);
}

/** A closed GeoJSON ring, or null when it has fewer than three points. */
function closeRing(coordinates: Position[]): Position[] | null {
    const ring = coordinates.filter(
        (c, k) =>
            k === 0 ||
            c[0] !== coordinates[k - 1][0] ||
            c[1] !== coordinates[k - 1][1],
    );
    while (
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1]
    ) {
        ring.pop();
    }
    return ring.length < 3 ? null : [...ring, ring[0]];
}

function polygon(rings: (Position[] | null)[]): Polygon | MultiPolygon | null {
    const parts = rings.filter((ring) => ring !== null);
    if (!parts.length) return null;
    if (parts.length === 1) return { type: "Polygon", coordinates: parts };
    return { type: "MultiPolygon", coordinates: parts.map((ring) => [ring]) };
}

/**
 * The cell as a lon/lat polygon, counterclockwise as RFC 7946 asks. A cell is
 * an intersection of hemispheres, so it is convex: it holds at most one pole,
 * and its boundary crosses the antimeridian at most twice, or once if it
 * holds a pole.
 */
function cellGeometry(boundary: Vector[]): Polygon | MultiPolygon | null {
    const start = boundary.findIndex((v) => !isPole(v));
    if (start < 0) return null;
    const ring: RingPoint[] = [];
    for (let k = 0; k < boundary.length; k++) {
        const v = boundary[(start + k) % boundary.length];
        const last = ring[ring.length - 1];
        if (!isPole(v)) {
            const [lon, lat] = toLonLat(v);
            const turns = last ? last.turns + turnsBetween(last.lon, lon) : 0;
            ring.push({ lon, lat, turns });
            continue;
        }
        // At a pole corner the boundary arrives along one meridian and leaves
        // along another. In lon/lat it runs along the pole between them,
        // through the cell's angle at the pole: westwards at the north pole,
        // eastwards at the south pole.
        const [next] = toLonLat(boundary[(start + k + 1) % boundary.length]);
        const north = v[2] > 0;
        const angle =
            (((north ? last.lon - next : next - last.lon) % 360) + 360) % 360;
        const end = lonIn(last, 0) + (north ? -angle : angle);
        ring.push({ lon: last.lon, lat: north ? 90 : -90, turns: last.turns });
        ring.push({
            lon: next,
            lat: north ? 90 : -90,
            turns: Math.round((end - next) / 360),
        });
    }
    const count = ring.length;
    const first = ring[0];
    const last = ring[count - 1];
    // Turns round a pole inside the cell: 1 for the north pole, -1 for south.
    const winding = last.turns + turnsBetween(last.lon, first.lon);
    const at = (p: RingPoint, shift: number): Position => [
        Math.min(180, Math.max(-180, lonIn(p, shift))),
        p.lat,
    ];

    if (winding === 0) {
        let [west, east] = [Infinity, -Infinity];
        for (const p of ring) {
            west = Math.min(west, lonIn(p, 0));
            east = Math.max(east, lonIn(p, 0));
        }
        const shift = Math.floor((west + 180) / 360);
        if (east - 360 * shift <= 180) {
            return polygon([closeRing(ring.map((p) => at(p, shift)))]);
        }
        // Cut where the boundary crosses the antimeridian.
        const western: Position[] = [];
        const eastern: Position[] = [];
        ring.forEach((p, k) => {
            const q = ring[(k + 1) % count];
            const lon = lonIn(p, shift);
            if (lon <= 180) western.push(at(p, shift));
            if (lon >= 180) eastern.push(at(p, shift + 1));
            if ((lon - 180) * (lonIn(q, shift) - 180) < 0) {
                const lat = crossingLat(p, q);
                western.push([180, lat]);
                eastern.push([-180, lat]);
            }
        });
        return polygon([closeRing(western), closeRing(eastern)]);
    }
    if (Math.abs(winding) !== 1) return null;

    // Cut where the boundary crosses the antimeridian, and close the ring
    // along the pole.
    const edge = 180 * winding;
    const shift =
        winding > 0
            ? Math.floor((first.lon + 180) / 360)
            : Math.ceil((first.lon - 180) / 360);
    const lonAt = (k: number) =>
        k < count ? lonIn(ring[k], shift) : lonIn(first, shift - winding);
    let k = 0;
    while (k < count - 1 && winding * (lonAt(k + 1) - edge) < 0) k++;
    const q = ring[(k + 1) % count];
    const lat = lonAt(k + 1) === edge ? q.lat : crossingLat(ring[k], q);
    return polygon([
        closeRing([
            [-edge, lat],
            ...ring.slice(k + 1).map((p) => at(p, shift + winding)),
            ...ring.slice(0, k + 1).map((p) => at(p, shift)),
            [edge, lat],
            [edge, 90 * winding],
            [-edge, 90 * winding],
        ]),
    ]);
}

const WORLD: Polygon = {
    type: "Polygon",
    coordinates: [
        [
            [-180, -90],
            [180, -90],
            [180, 90],
            [-180, 90],
            [-180, -90],
        ],
    ],
};

/**
 * The spherical Voronoi diagram of the points: one feature per point, in
 * order, whose geometry is the part of the Earth nearer that point than any
 * other, with the point as `properties.site`. A point that repeats an earlier
 * one (see distinctSites) gets a null geometry, and a lone point the world.
 *
 * The cells are exact on the sphere. Drawn as lon/lat polygons, their edges
 * stray at most FINE_TOLERANCE from the true boundary inside `domain`, or
 * everywhere without one, and more the farther outside it they are.
 * Neighbouring cells share their edges point for point, so they neither
 * overlap nor leave gaps.
 */
export const geoSpatialVoronoi = (
    points: FeatureCollection<Point>,
    domain?: BBox,
): FeatureCollection<Polygon | MultiPolygon> => {
    const input = points.features;
    const sites = distinctSites(input);
    const ids = sites.flatMap((site, i) => (site ? [i] : []));
    const vectors = sites as Vector[];
    let cells: Cell[] = [];
    if (ids.length === 2) {
        cells = hemispheres(ids[0], ids[1], vectors);
    } else if (ids.length > 2) {
        const hull = ids.length > 3 ? convexHull(ids, vectors) : null;
        cells = hull ? hullCells(hull, vectors) : coplanarCells(ids, vectors);
    }
    const tolerance: Tolerance = (middle, halfLength) =>
        domain
            ? Math.max(
                  FINE,
                  (angleToBox(middle, domain) - halfLength) * TOLERANCE_GROWTH,
              )
            : FINE;
    const features = input.map((site, i) => {
        const cell = cells[i];
        const geometry =
            ids.length === 1 && sites[i]
                ? WORLD
                : cell
                  ? cellGeometry(cellBoundary(i, cell, vectors, tolerance))
                  : null;
        return { type: "Feature" as const, geometry, properties: { site } };
    });
    // Repeated sites' features keep a null geometry.
    return {
        type: "FeatureCollection",
        features,
    } as FeatureCollection<Polygon | MultiPolygon>;
};
