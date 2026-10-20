import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
    Position,
} from "geojson";
import { orient2d, orient3d } from "robust-predicates";

type Vector = [number, number, number];

type LonLat = [number, number];

/**
 * How far, in radians, a drawn segment may stray from its arc for the
 * domain, given its middle and half its length.
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
// A drawn segment is measured at a few points, between which it can stray
// a little further, so it is held to this share of its tolerance.
const STRAY_MARGIN = 0.9;
// The longest arc drawn as one segment, in radians (about 640 km).
const MAX_STEP = 0.1;
// Within this many radians of a pole a great circle's lon/lat trace bends
// sharply, so an edge passing that close is split where it is closest.
const POLE_ZONE = 0.1;
// Sites within this many metres of an earlier one are the same place. Much
// closer sites are numerically fragile: rounding of their unit vectors can
// leave one out of the hull, or move their shared boundary past one of them.
export const MERGE_METRES = 1;
const MERGE_DISTANCE = MERGE_METRES / EARTH_RADIUS;

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
const chord = (a: Vector, b: Vector) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function normalize(v: Vector): Vector {
    const length = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / length, v[1] / length, v[2] / length];
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

/**
 * The change in longitude along the great-circle arc from p to q, which is
 * less than half a turn either way. Near half a turn, as close to a pole,
 * the short way round is a guess, so the sign is taken from which way the
 * arc turns about the polar axis, exactly.
 */
function lonChange(p: Vector, lonP: number, q: Vector, lonQ: number) {
    const step = lonQ - lonP;
    if (Math.abs(step) < 90) return step;
    // Negative when the arc runs east.
    const turn = orient2d(0, 0, p[0], p[1], q[0], q[1]);
    if (turn < 0) return step < 0 ? step + 360 : step;
    if (turn > 0) return step > 0 ? step - 360 : step;
    return step > 180 ? step - 360 : step < -180 ? step + 360 : step;
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
 * Each site's unit vector, or null for a site that is not a valid position
 * or that is within MERGE_METRES of an earlier site kept: the same place,
 * possibly written another way (at longitude 180 and -180, or at a pole with
 * any longitude). A site is only ever merged into a kept one, so merging
 * never chains further than MERGE_METRES.
 */
export function distinctSites(points: Feature<Point>[]): (Vector | null)[] {
    const sites = points.map(({ geometry }) => {
        const [lon, lat] = geometry.coordinates;
        if (!Number.isFinite(lon) || !(Math.abs(lat) <= 90)) return null;
        return toVector(lon - 360 * Math.round(lon / 360), lat);
    });
    // Pairs of sites close together, from a sweep along a skew axis.
    const position = sites.map((v) =>
        v ? 0.6 * v[0] + 0.48 * v[1] + 0.64 * v[2] : 0,
    );
    const order = sites
        .flatMap((v, i) => (v ? [i] : []))
        .sort((i, j) => position[i] - position[j]);
    const later: number[][] = sites.map(() => []);
    for (let a = 0; a < order.length; a++) {
        for (let b = a + 1; b < order.length; b++) {
            const [i, j] = [order[a], order[b]];
            if (position[j] - position[i] > MERGE_DISTANCE) break;
            if (chord(sites[i]!, sites[j]!) > MERGE_DISTANCE) continue;
            later[Math.min(i, j)].push(Math.max(i, j));
        }
    }
    const kept = sites.map((v) => v !== null);
    kept.forEach((isKept, i) => {
        if (isKept) for (const j of later[i]) kept[j] = false;
    });
    return sites.map((v, i) => (kept[i] ? v : null));
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
 * visibility test is Shewchuk's exact orient3d.
 */
function convexHull(sites: Vector[]): Hull | null {
    const ids = sites.map((_, i) => i);
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
        centres[f] = normalize(
            cross(sub(sites[b], sites[a]), sub(sites[c], sites[a])),
        );
        faceAt[a] = faceAt[b] = faceAt[c] = f;
    });
    // Nearly cocircular sites, such as samples along a line, give corners
    // that should coincide but that rounding scatters, so that an edge can
    // run backwards along its bisector, and polygon clipping fails on the
    // tiny loop that leaves. Such an edge is rounding-sized; collapse it onto
    // one corner, until none is left.
    const { root, join } = groups(alive.length);
    for (let collapsed = true; collapsed; ) {
        collapsed = false;
        alive.forEach((isAlive, f) => {
            for (let k = 0; isAlive && k < 3; k++) {
                const g = adjacent[3 * f + k];
                if (root(f) === root(g)) continue;
                // The edge from f's centre to g's has site i on its left and
                // site j on its right.
                const [j, i] = [faces[3 * f + k], faces[3 * f + ((k + 1) % 3)]];
                const turn = cross(centres[root(f)], centres[root(g)]);
                if (dot(sub(sites[i], sites[j]), turn) < 0) {
                    join(f, g);
                    collapsed = true;
                }
            }
        });
    }
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
            if (corners.length === alive.length) {
                throw new Error("Spherical Voronoi: broken hull");
            }
            const k = faces.indexOf(i, 3 * f) - 3 * f;
            const previous = 3 * f + ((k + 2) % 3);
            corners.push(centres[f]);
            neighbours.push(faces[previous]);
            f = adjacent[previous];
        } while (f !== start);
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
function hemispheres(sites: Vector[]): Cell[] {
    const g = bisector(sites[0], sites[1]);
    // Corners every 90 degrees along the bisector, from its point nearest
    // the north pole.
    let top: Vector = [-g[2] * g[0], -g[2] * g[1], 1 - g[2] * g[2]];
    top =
        dot(top, top) > 1e-12 ? normalize(top) : normalize(cross(g, [1, 0, 0]));
    const side = cross(g, top);
    const corners = [top, side, neg(top), neg(side)];
    return [
        { corners, neighbours: [1, 1, 1, 1] },
        { corners: corners.slice().reverse(), neighbours: [0, 0, 0, 0] },
    ];
}

/**
 * Cells of three or more sites on one circle, with normal n. Every bisector
 * passes through +n and -n, so each cell is the lune between the bisectors
 * with its neighbours along the circle.
 */
function coplanarCells(sites: Vector[]) {
    const ids = sites.map((_, i) => i);
    // The circle's normal, from three well-spread sites.
    const p0 = sites[0];
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
        return dot(corner, middle) < 0 ? neg(corner) : corner;
    });
    const [top, bottom] = [n, neg(n)];
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

/**
 * Angle to the box's point of nearest longitude and latitude. That is the
 * nearest point of the box, but for points beyond a corner or over a pole,
 * which it puts a little too far; it is meant for picking a tolerance.
 */
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

/** A point of an edge, with its angle along the edge and its lon/lat. */
type Stop = [angle: number, point: Vector, lonLat: LonLat];

/**
 * How far, in radians, the lon/lat segment from p to q strays from the great
 * circle with normal g.
 */
function stray(
    [, p, [lon0, lat0]]: Stop,
    [, q, [lon1, lat1]]: Stop,
    g: Vector,
) {
    const span = lonChange(p, lon0, q, lon1);
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
 * Points strictly between corners a and b of the edge between sites `low`
 * and `high`, along their bisector with low's side on the left, so that the
 * lon/lat segments through them stay within tolerance of the bisector.
 */
function edgePoints(
    a: Vector,
    b: Vector,
    low: Vector,
    high: Vector,
    toleranceAt: Tolerance,
) {
    if (same(a, b)) return [];
    const g = bisector(low, high);
    if (isPole(a) || isPole(b)) {
        // An edge to a pole runs along a meridian, which is straight in
        // lon/lat. From pole to pole it is half a meridian, and only its
        // bisector says which: mark it where it crosses the equator.
        return isPole(a) && isPole(b) ? [normalize(cross(g, a))] : [];
    }
    // Neither site may end up outside its own drawn cell, so a segment
    // strays at most a quarter of its distance from them, which is at least
    // half their distance apart. Chords stand in for angles, slightly less.
    const apart = chord(low, high) / 2;
    const siteCap = (nearest: number) => Math.max(apart, nearest) / 4;
    // A lon/lat segment of length L at latitude φ strays from the great
    // circle by at most about 1.09 tan(φ) L² / 8, so a short edge away from
    // the poles needs no points.
    const length = chord(a, b);
    const slope = Math.max(
        Math.abs(a[2]) / Math.hypot(a[0], a[1]),
        Math.abs(b[2]) / Math.hypot(b[0], b[1]),
    );
    const cap = siteCap(Math.min(chord(a, low), chord(b, low)) - length / 2);
    if (
        length < 0.01 &&
        slope < 10 &&
        1.1 * slope * length ** 2 < 4 * Math.min(FINE, cap)
    ) {
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
    const stop = (angle: number, point: Vector): Stop => [
        angle,
        point,
        toLonLat(point),
    ];
    const stops = [stop(0, a)];
    if (Math.abs(g[2]) < Math.sin(POLE_ZONE)) {
        // The points nearest the poles: the poles themselves when the edge
        // runs exactly through them.
        const top = normalize([-g[2] * g[0], -g[2] * g[1], 1 - g[2] * g[2]]);
        for (const nearest of [top, neg(top)]) {
            const angle = angleOf(nearest);
            if (angle > 0 && angle < end) stops.push(stop(angle, nearest));
        }
    }
    stops.sort((s, t) => s[0] - t[0]);
    stops.push(stop(end, b));

    const points: Vector[] = [];
    const refine = (p: Stop, q: Stop) => {
        const length = q[0] - p[0];
        // A segment to a pole runs along a meridian.
        if (isPole(p[1]) || isPole(q[1]) || length < 1e-9) return;
        // Judged for the point of the segment nearest the domain or the
        // sites, which is within half its length of the middle.
        const middle = along(p[0] + length / 2);
        const tolerance = Math.min(
            toleranceAt(toLonLat(middle), length / 2),
            siteCap(chord(middle, low) - length / 2),
        );
        const excess = stray(p, q, g) / (STRAY_MARGIN * tolerance);
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
        const [low, high] = i < j ? [sites[i], sites[j]] : [sites[j], sites[i]];
        const points =
            i < j
                ? edgePoints(a, b, low, high, tolerance)
                : edgePoints(b, a, low, high, tolerance).reverse();
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
    // The last point off the poles, and its turns from the first.
    let [from, fromLon, turns] = [boundary[start], 0, 0];
    const turnsTo = (v: Vector, lon: number) =>
        turns +
        Math.round((fromLon + lonChange(from, fromLon, v, lon) - lon) / 360);
    for (let k = 0; k < boundary.length; k++) {
        const v = boundary[(start + k) % boundary.length];
        if (!isPole(v)) {
            const [lon, lat] = toLonLat(v);
            if (k > 0) turns = turnsTo(v, lon);
            [from, fromLon] = [v, lon];
            ring.push({ lon, lat, turns });
            continue;
        }
        // At a pole corner the boundary arrives along one meridian and leaves
        // along another. In lon/lat it runs along the pole between them,
        // through the cell's angle at the pole: westwards at the north pole,
        // eastwards at the south pole. Poles are never adjacent: an edge
        // between them has a point on the equator.
        const after = boundary[(start + k + 1) % boundary.length];
        if (isPole(after)) throw new Error("Spherical Voronoi: pole to pole");
        const [next] = toLonLat(after);
        const north = v[2] > 0;
        const angle =
            (((north ? fromLon - next : next - fromLon) % 360) + 360) % 360;
        const end = fromLon + 360 * turns + (north ? -angle : angle);
        ring.push({ lon: fromLon, lat: north ? 90 : -90, turns });
        // The point after the pole carries on from there, at no change.
        [from, fromLon, turns] = [after, next, Math.round((end - next) / 360)];
        ring.push({ lon: next, lat: north ? 90 : -90, turns });
    }
    const count = ring.length;
    const first = ring[0];
    // Turns round a pole inside the cell: 1 for the north pole, -1 for south.
    const winding = turnsTo(boundary[start], first.lon);
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
 * other, with the point as `properties.site`. A point that is not a valid
 * position, or that is within MERGE_METRES of an earlier point (see
 * distinctSites), gets a null geometry; a lone point gets the world.
 *
 * The cells are exact on the sphere. Drawn as lon/lat polygons, their edges
 * stray at most FINE_TOLERANCE from the true boundary inside `domain`, or
 * everywhere without one, and more the farther outside it they are, but
 * never by a quarter of their distance from their sites, so every site lies
 * inside its own drawn cell. Neighbouring cells share their edges point for
 * point, so they neither overlap nor leave gaps.
 */
export const geoSpatialVoronoi = (
    points: FeatureCollection<Point>,
    domain?: BBox,
): FeatureCollection<Polygon | MultiPolygon> => {
    // The distinct sites, in input order, and where each came from.
    const ids: number[] = [];
    const sites: Vector[] = [];
    distinctSites(points.features).forEach((site, i) => {
        if (!site) return;
        ids.push(i);
        sites.push(site);
    });
    let cells: Cell[] = [];
    if (sites.length === 2) {
        cells = hemispheres(sites);
    } else if (sites.length > 2) {
        // Three sites always lie in one plane, so their hull is flat.
        const hull = sites.length > 3 ? convexHull(sites) : null;
        cells = hull ? hullCells(hull, sites) : coplanarCells(sites);
    }
    const tolerance: Tolerance = (middle, halfLength) =>
        domain
            ? Math.max(
                  FINE,
                  (angleToBox(middle, domain) - halfLength) * TOLERANCE_GROWTH,
              )
            : FINE;
    const geometries = new Map<number, Polygon | MultiPolygon | null>();
    ids.forEach((id, k) => {
        geometries.set(
            id,
            sites.length === 1
                ? WORLD
                : cells[k]
                  ? cellGeometry(cellBoundary(k, cells[k], sites, tolerance))
                  : null,
        );
    });
    // Features without a cell keep a null geometry.
    return {
        type: "FeatureCollection",
        features: points.features.map((site, i) => ({
            type: "Feature",
            geometry: geometries.get(i) ?? null,
            properties: { site },
        })),
    } as FeatureCollection<Polygon | MultiPolygon>;
};
