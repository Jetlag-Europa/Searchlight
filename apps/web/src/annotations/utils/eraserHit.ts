import type * as L from "leaflet";

import type { StrokeFeature } from "@/annotations/types";

interface Point2D {
    x: number;
    y: number;
}

function distSqPointToSegment(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        const ddx = p.x - a.x;
        const ddy = p.y - a.y;
        return ddx * ddx + ddy * ddy;
    }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const ex = p.x - cx;
    const ey = p.y - cy;
    return ex * ex + ey * ey;
}

export function strokeIntersectsErasePoint(
    stroke: StrokeFeature,
    map: L.Map,
    pointerPx: Point2D,
    radiusPx: number,
): boolean {
    const coords = stroke.geometry.coordinates;
    if (coords.length === 0) return false;

    const pts: Point2D[] = coords.map(([lng, lat]) =>
        map.latLngToContainerPoint([lat, lng]),
    );

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    if (
        pointerPx.x < minX - radiusPx ||
        pointerPx.x > maxX + radiusPx ||
        pointerPx.y < minY - radiusPx ||
        pointerPx.y > maxY + radiusPx
    ) {
        return false;
    }

    const radiusSq = radiusPx * radiusPx;
    if (pts.length === 1) {
        const dx = pointerPx.x - pts[0].x;
        const dy = pointerPx.y - pts[0].y;
        return dx * dx + dy * dy <= radiusSq;
    }
    for (let i = 1; i < pts.length; i++) {
        if (distSqPointToSegment(pointerPx, pts[i - 1], pts[i]) <= radiusSq) {
            return true;
        }
    }
    return false;
}
