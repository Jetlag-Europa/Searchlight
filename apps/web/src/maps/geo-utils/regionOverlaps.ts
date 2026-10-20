import * as turf from "@turf/turf";
import type { BBox, Feature, MultiPolygon, Polygon, Position } from "geojson";

type Region = Feature<Polygon | MultiPolygon>;

/**
 * Overlaps reaching less than this far into a region are rounding between
 * borders traced from the same data: they move a distance to a border by
 * less than the buffers' own tolerance (3 ft at least). check-game.mjs
 * flags a layer marked noOverlaps by the same measure.
 */
export const HAIRLINE_WIDTH = 0.5;
/** What may be left of a region before it counts as lying inside others. */
export const HAIRLINE_AREA = 1;

const METERS_PER_DEGREE = (6371008.8 * Math.PI) / 180;

export interface OverlapPiece {
    /** The regions overlapping, by index in the layer; `first` comes first. */
    first: number;
    second: number;
    /** Square meters. */
    area: number;
    /**
     * How far the piece reaches into the regions in meters: the furthest
     * any of its corners, or middles of its edges, lies from the border of
     * the region it reaches into. A sliver's width, a spike's length.
     */
    width: number;
    geometry: Polygon;
}

export interface RegionOverlaps {
    /** Overlaps wider than a hairline, in layer order. */
    pieces: OverlapPiece[];
    /** Hairline overlaps, which need no fixing. */
    hairlines: number;
    /**
     * Regions lying entirely inside earlier ones: no point is ever in them,
     * as the first region holding a point wins.
     */
    hidden: { region: number; by: number[] }[];
}

export interface RegionOverlapsRequest {
    kind: "regionOverlaps";
    regions: Region[];
}

export interface RemoveRegionOverlapsRequest {
    kind: "removeRegionOverlaps";
    regions: Region[];
}

const boxesMeet = (a: BBox, b: BBox) =>
    a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * A region's box from its coordinates. Turf otherwise trusts a bbox member
 * the file carries, which may be stale, rounded or 3D.
 */
const boxOf = (region: Region): BBox => turf.bbox(region, { recompute: true });

/**
 * The part of a region inside a box, or null if none is. Where the region
 * reaches past a side and back, the clip joins the two along that side.
 */
function clipToBox(region: Region, box: BBox): Region | null {
    // A polygon clips to a polygon.
    const { geometry } = turf.bboxClip(region, box) as Region;
    const polygons = (
        geometry.type === "Polygon"
            ? [geometry.coordinates]
            : geometry.coordinates
    )
        .map((polygon) => polygon.filter((ring) => ring.length >= 4))
        .filter((polygon) => polygon.length);
    return polygons.length ? turf.multiPolygon(polygons) : null;
}

type Edge = [Position, Position];

/** Meters from a point to the nearest of the edges, measured flat around it. */
function distanceToEdges(pt: Position, edges: Iterable<Edge>) {
    const k = Math.cos((pt[1] * Math.PI) / 180);
    const toXY = ([x, y]: Position) => [
        (x - pt[0]) * k * METERS_PER_DEGREE,
        (y - pt[1]) * METERS_PER_DEGREE,
    ];
    let nearest = Infinity;
    for (const [from, to] of edges) {
        const [ax, ay] = toXY(from);
        const [bx, by] = toXY(to);
        const dx = bx - ax;
        const dy = by - ay;
        const t =
            dx || dy
                ? Math.max(
                      0,
                      Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)),
                  )
                : 0;
        nearest = Math.min(nearest, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return nearest;
}

/**
 * A region's border edges filed under the grid cells they pass through,
 * the cells about as wide as an edge is long, so the edges nearest a point
 * are found by looking in the cells around it.
 */
interface EdgeGrid {
    edges: Edge[];
    /** Degrees, across and up. */
    cell: number;
    cells: Map<string, Edge[]>;
}

const edgeGrids = new WeakMap<Region, EdgeGrid>();

function edgeGrid(region: Region): EdgeGrid {
    const known = edgeGrids.get(region);
    if (known) return known;
    const rings =
        region.geometry.type === "Polygon"
            ? region.geometry.coordinates
            : region.geometry.coordinates.flat();
    const edges = rings.flatMap((ring) =>
        ring.slice(1).map((pt, i): Edge => [ring[i], pt]),
    );
    const lengths = edges.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
    const cell = Math.max(
        lengths.reduce((sum, length) => sum + length, 0) / edges.length,
        1e-7,
    );
    const cells = new Map<string, Edge[]>();
    edges.forEach((edge, e) => {
        const [a, b] = edge;
        // Points half a cell apart along the edge land in every cell it
        // crosses, but for corners it only clips.
        const steps = Math.max(Math.ceil(lengths[e] / (cell / 2)), 1);
        const keys = new Set<string>();
        for (let i = 0; i <= steps; i++) {
            const x = a[0] + ((b[0] - a[0]) * i) / steps;
            const y = a[1] + ((b[1] - a[1]) * i) / steps;
            keys.add(`${Math.floor(x / cell)},${Math.floor(y / cell)}`);
        }
        for (const key of keys) {
            const filed = cells.get(key);
            if (filed) filed.push(edge);
            else cells.set(key, [edge]);
        }
    });
    const grid = { edges, cell, cells };
    edgeGrids.set(region, grid);
    return grid;
}

/** Meters from a point to the nearest edge of a region's border. */
function distanceToBorder(pt: Position, region: Region): number {
    const { edges, cell, cells } = edgeGrid(region);
    const k = Math.cos((pt[1] * Math.PI) / 180);
    const cx = Math.floor(pt[0] / cell);
    const cy = Math.floor(pt[1] / cell);
    let nearest = Infinity;
    for (let r = 0; ; r++) {
        // Once the cells around would hold more than every edge, look at
        // every edge.
        if ((2 * r + 1) ** 2 > edges.length) {
            return distanceToEdges(pt, edges);
        }
        for (let x = cx - r; x <= cx + r; x++) {
            for (let y = cy - r; y <= cy + r; y++) {
                if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) < r) continue;
                const filed = cells.get(`${x},${y}`);
                if (filed) {
                    nearest = Math.min(nearest, distanceToEdges(pt, filed));
                }
            }
        }
        // The cells looked in hold every edge passing within r cells of the
        // point, less some clipping a corner of the outermost ring.
        if (nearest <= (r - 1) * cell * k * METERS_PER_DEGREE) {
            return nearest;
        }
    }
}

/**
 * How far a piece of two regions' overlap reaches into them, as
 * OverlapPiece's width. Each point of the piece's outline is on one
 * region's border, so the further of its distances to the two borders is
 * how deep it lies inside the other.
 */
function reach(piece: Polygon, regions: [Region, Region]): number {
    let deepest = 0;
    for (const ring of piece.coordinates) {
        ring.forEach((pt, i) => {
            const points = i
                ? [pt, ring[i - 1].map((v, j) => (v + pt[j]) / 2)]
                : [pt];
            for (const point of points) {
                for (const region of regions) {
                    deepest = Math.max(
                        deepest,
                        distanceToBorder(point, region),
                    );
                }
            }
        });
    }
    return deepest;
}

/** The pieces where two regions overlap, measured as OverlapPiece is. */
function overlapPieces(a: Region, b: Region) {
    // Two regions can only overlap where their boxes do, and clipping both
    // to that first leaves the intersection far fewer vertices to work
    // through. A side a clip joins along is the other region's outermost
    // line, so the join can't run through it and make an overlap.
    const [ax0, ay0, ax1, ay1] = boxOf(a);
    const [bx0, by0, bx1, by1] = boxOf(b);
    const box: BBox = [
        Math.max(ax0, bx0),
        Math.max(ay0, by0),
        Math.min(ax1, bx1),
        Math.min(ay1, by1),
    ];
    const clippedA = clipToBox(a, box);
    const clippedB = clipToBox(b, box);
    if (!clippedA || !clippedB) return [];
    const overlap = turf.intersect(
        turf.featureCollection([clippedA, clippedB]),
    );
    if (!overlap) return [];
    return turf.flatten(overlap).features.map((piece) => ({
        area: turf.area(piece),
        // To the whole regions' borders: the box's sides aren't borders.
        width: reach(piece.geometry, [a, b]),
        geometry: piece.geometry,
    }));
}

const isHairline = ({ width }: { width: number }) => width < HAIRLINE_WIDTH;

/** Where the layer's regions overlap, and which are covered entirely. */
export function findRegionOverlaps({
    regions,
}: Omit<RegionOverlapsRequest, "kind">): RegionOverlaps {
    const boxes = regions.map(boxOf);
    const pieces: OverlapPiece[] = [];
    const hidden: RegionOverlaps["hidden"] = [];
    let hairlines = 0;
    for (let second = 1; second < regions.length; second++) {
        let covered = 0;
        const by: number[] = [];
        for (let first = 0; first < second; first++) {
            if (!boxesMeet(boxes[first], boxes[second])) continue;
            for (const piece of overlapPieces(
                regions[first],
                regions[second],
            )) {
                if (isHairline(piece)) {
                    hairlines++;
                    continue;
                }
                covered += piece.area;
                if (!by.includes(first)) by.push(first);
                pieces.push({ first, second, ...piece });
            }
        }
        // The overlaps add up to at least the ground they cover together
        // (earlier regions may overlap each other too), so a region with
        // more than a hairline's area left over can't be covered.
        if (turf.area(regions[second]) - covered >= HAIRLINE_AREA) continue;
        const left = removeOverlapsOf(regions, second);
        if (!left || turf.area(left) < HAIRLINE_AREA) {
            hidden.push({ region: second, by });
        }
    }
    return { pieces, hairlines, hidden };
}

/**
 * A region less every earlier region it overlaps by more than a hairline,
 * or null when nothing is left. A region that only touches its earlier
 * neighbours, or overlaps them by hairlines, comes back as it was.
 */
function removeOverlapsOf(regions: Region[], index: number): Region | null {
    let left: Region | null = regions[index];
    const box = boxOf(left);
    for (let earlier = 0; earlier < index && left; earlier++) {
        if (!boxesMeet(boxOf(regions[earlier]), box)) continue;
        if (overlapPieces(left, regions[earlier]).every(isHairline)) continue;
        left = turf.difference(
            turf.featureCollection([left, regions[earlier]]),
        );
    }
    return left;
}

/** The most decimals any coordinate in the regions carries. */
function precision(regions: Region[]): number {
    let decimals = 0;
    for (const position of turf.coordAll(turf.featureCollection(regions))) {
        for (const value of position) {
            // As written in the file: 0.0000001 prints as 1e-7.
            const [digits, exponent] = String(value).split("e");
            const dot = digits.indexOf(".");
            const places =
                (dot >= 0 ? digits.length - dot - 1 : 0) -
                Number(exponent ?? 0);
            decimals = Math.max(decimals, places);
        }
    }
    return decimals;
}

/**
 * A ring rounded to `decimals`, less the vertices rounding made repeat the
 * one before (a zero-length edge trips Turf's distances), or null once
 * fewer than three corners are left.
 */
function roundRing(ring: Position[], decimals: number): Position[] | null {
    const scale = 10 ** decimals;
    const rounded: Position[] = [];
    for (const position of ring) {
        const next = position.map((n) => Math.round(n * scale) / scale);
        const last = rounded[rounded.length - 1];
        if (last && last[0] === next[0] && last[1] === next[1]) continue;
        rounded.push(next);
    }
    // Rings close on their first vertex.
    return rounded.length >= 4 ? rounded : null;
}

/** A polygon's rounded rings; null if its outer ring collapses. */
function roundPolygon(
    rings: Position[][],
    decimals: number,
): Position[][] | null {
    const [outer, ...holes] = rings.map((ring) => roundRing(ring, decimals));
    if (!outer) return null;
    return [outer, ...holes.filter((hole): hole is Position[] => !!hole)];
}

/** The geometry rounded, or null if rounding would leave nothing. */
function roundGeometry(
    geometry: Polygon | MultiPolygon,
    decimals: number,
): Polygon | MultiPolygon | null {
    const polygons = (
        geometry.type === "Polygon"
            ? [geometry.coordinates]
            : geometry.coordinates
    )
        .map((polygon) => roundPolygon(polygon, decimals))
        .filter((polygon): polygon is Position[][] => !!polygon);
    if (!polygons.length) return null;
    return polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons };
}

/**
 * The regions with every overlap given to the first region in the layer, as
 * the app already decides which region a point is in: each region less the
 * regions before it that it overlaps by more than a hairline. Ids and
 * properties are kept. New vertices are rounded to the layer's precision,
 * but to no fewer than 6 decimals (about 0.1 m), so a border moves by at
 * most a few centimetres. Throws if a region would vanish.
 */
export function removeRegionOverlaps({
    regions,
}: Omit<RemoveRegionOverlapsRequest, "kind">): Region[] {
    const decimals = Math.min(Math.max(precision(regions), 6), 15);
    return regions.map((region, index) => {
        const left = removeOverlapsOf(regions, index);
        if (!left || turf.area(left) < HAIRLINE_AREA) {
            throw new Error(
                `Region ${index + 1} lies entirely inside earlier regions`,
            );
        }
        if (left === region) return region;
        const cleaned: Region = {
            ...region,
            geometry: roundGeometry(left.geometry, decimals) ?? left.geometry,
        };
        // A bbox member would describe the old geometry.
        delete cleaned.bbox;
        return cleaned;
    });
}

/**
 * A layer marked noOverlaps with `regions` as its features, the mark written
 * before the data so it stays in sight in the file.
 */
export function markNoOverlaps<
    L extends { data: { features: unknown[] }; noOverlaps?: boolean },
>(layer: L, regions: Region[]): L {
    const marked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(layer)) {
        if (key === "noOverlaps") continue;
        if (key === "data") {
            marked.noOverlaps = true;
            marked.data = { ...layer.data, features: regions };
        } else {
            marked[key] = value;
        }
    }
    return marked as L;
}
