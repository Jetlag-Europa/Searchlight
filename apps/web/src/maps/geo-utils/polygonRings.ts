import type { Position } from "geojson";

type Ring = Position[];

/** Twice the ring's area, positive when it runs counterclockwise. */
function signedArea(ring: Ring): number {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return sum;
}

/** 1 inside the ring, -1 outside, 0 on its edge. */
function pointInRing([x, y]: Position, ring: Ring): number {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const cross = (xj - xi) * (y - yi) - (yj - yi) * (x - xi);
        if (
            cross === 0 &&
            Math.min(xi, xj) <= x &&
            x <= Math.max(xi, xj) &&
            Math.min(yi, yj) <= y &&
            y <= Math.max(yi, yj)
        ) {
            return 0;
        }
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside ? 1 : -1;
}

interface Bounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

function bounds(ring: Ring): Bounds {
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const [x, y] of ring) {
        west = Math.min(west, x);
        south = Math.min(south, y);
        east = Math.max(east, x);
        north = Math.max(north, y);
    }
    return { west, south, east, north };
}

/**
 * An ArcGIS polygon's rings as GeoJSON MultiPolygon coordinates. ArcGIS runs
 * outer rings clockwise and holes counterclockwise, and lists them in no
 * particular nesting. Each hole belongs to the smallest outer ring around
 * it: a buffer of a region with an enclave, such as Brussels inside Flemish
 * Brabant, has the enclave's band as an outer ring inside the hole of the
 * band around the region, and the enclave's middle as a hole inside that.
 * Giving the hole to the first outer ring around it instead, as Terraformer
 * does, fills the enclave in.
 */
export function ringsToMultiPolygon(rings: Ring[]): Position[][][] {
    const outers: { ring: Ring; area: number; bounds: Bounds }[] = [];
    const holes: { ring: Ring; area: number; bounds: Bounds }[] = [];
    for (const ring of rings) {
        if (ring.length < 4) continue;
        const area = signedArea(ring);
        if (area === 0) continue;
        (area < 0 ? outers : holes).push({
            ring,
            area: Math.abs(area),
            bounds: bounds(ring),
        });
    }
    // GeoJSON runs outer rings counterclockwise and holes clockwise.
    const polygons = outers.map(({ ring }) => [[...ring].reverse()]);
    for (const hole of holes) {
        let owner = -1;
        let ownerArea = Infinity;
        outers.forEach((outer, index) => {
            if (outer.area <= hole.area || outer.area >= ownerArea) return;
            const b = outer.bounds;
            const h = hole.bounds;
            if (
                h.west < b.west ||
                h.east > b.east ||
                h.south < b.south ||
                h.north > b.north
            ) {
                return;
            }
            // A hole may touch its outer ring at a vertex, so the first of
            // its vertices off that ring decides.
            for (const vertex of hole.ring) {
                const side = pointInRing(vertex, outer.ring);
                if (side === 0) continue;
                if (side === 1) {
                    owner = index;
                    ownerArea = outer.area;
                }
                return;
            }
        });
        if (owner >= 0) polygons[owner].push([...hole.ring].reverse());
    }
    return polygons;
}
