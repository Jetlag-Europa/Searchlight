import * as turf from "@turf/turf";
import type { BBox, Feature, MultiPolygon, Polygon, Position } from "geojson";

type Region = Feature<Polygon | MultiPolygon>;

/**
 * Overlaps narrower than this, or smaller in area, are rounding between
 * borders traced from the same data: they move a distance to a border by
 * less than the buffers' own tolerance (3 ft at least).
 */
export const HAIRLINE_WIDTH = 0.5;
export const HAIRLINE_AREA = 1;

export interface OverlapPiece {
    /** The regions overlapping, by index in the layer; `first` comes first. */
    first: number;
    second: number;
    /** Square meters. */
    area: number;
    /**
     * About how wide the piece is in meters: twice its area over its
     * perimeter, which is a sliver's width and a round piece's radius.
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

/** A piece of overlap's area, and width as OverlapPiece describes it. */
function measure(piece: Feature<Polygon>) {
    const area = turf.area(piece);
    const perimeter = turf.length(turf.polygonToLine(piece), {
        units: "meters",
    });
    return { area, width: perimeter ? (2 * area) / perimeter : 0 };
}

const isHairline = ({ area, width }: { area: number; width: number }) =>
    area < HAIRLINE_AREA || width < HAIRLINE_WIDTH;

/** The pieces where two regions overlap by more than a hairline. */
function realOverlaps(a: Region, b: Region): Feature<Polygon>[] {
    const overlap = turf.intersect(turf.featureCollection([a, b]));
    if (!overlap) return [];
    return turf
        .flatten(overlap)
        .features.filter((piece) => !isHairline(measure(piece)));
}

/** Where the layer's regions overlap, and which are covered entirely. */
export function findRegionOverlaps({
    regions,
}: Omit<RegionOverlapsRequest, "kind">): RegionOverlaps {
    const boxes = regions.map((region) => turf.bbox(region));
    const pieces: OverlapPiece[] = [];
    const hidden: RegionOverlaps["hidden"] = [];
    let hairlines = 0;
    for (let second = 1; second < regions.length; second++) {
        let covered = 0;
        const by: number[] = [];
        for (let first = 0; first < second; first++) {
            if (!boxesMeet(boxes[first], boxes[second])) continue;
            const overlap = turf.intersect(
                turf.featureCollection([regions[first], regions[second]]),
            );
            if (!overlap) continue;
            for (const piece of turf.flatten(overlap).features) {
                const { area, width } = measure(piece);
                if (isHairline({ area, width })) {
                    hairlines++;
                    continue;
                }
                covered += area;
                if (!by.includes(first)) by.push(first);
                pieces.push({
                    first,
                    second,
                    area,
                    width,
                    geometry: piece.geometry,
                });
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
    const box = turf.bbox(left);
    for (let earlier = 0; earlier < index && left; earlier++) {
        if (!boxesMeet(turf.bbox(regions[earlier]), box)) continue;
        if (!realOverlaps(left, regions[earlier]).length) continue;
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
