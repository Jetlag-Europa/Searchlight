import * as turf from "@turf/turf";
import type {
    BBox,
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
    Position,
} from "geojson";

import {
    distinctSites,
    geoSpatialVoronoi,
    MERGE_METRES,
} from "./sphericalVoronoi";

export { geoSpatialVoronoi };

function to3D(lng: number, lat: number): [number, number, number] {
    const radLng = (lng * Math.PI) / 180;
    const radLat = (lat * Math.PI) / 180;
    return [
        Math.cos(radLat) * Math.cos(radLng),
        Math.cos(radLat) * Math.sin(radLng),
        Math.sin(radLat),
    ];
}

function dot(
    v1: [number, number, number],
    v2: [number, number, number],
): number {
    return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

function clipConvexPoly(
    poly: [number, number][],
    A: number,
    B: number,
    C: number,
): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const prev = poly[(i + poly.length - 1) % poly.length];
        const dCur = A * cur[0] + B * cur[1] + C;
        const dPrev = A * prev[0] + B * prev[1] + C;

        if (dCur >= 0) {
            if (dPrev < 0) {
                const t = dPrev / (dPrev - dCur);
                out.push([
                    prev[0] + t * (cur[0] - prev[0]),
                    prev[1] + t * (cur[1] - prev[1]),
                ]);
            }
            out.push(cur);
        } else if (dPrev >= 0) {
            const t = dPrev / (dPrev - dCur);
            out.push([
                prev[0] + t * (cur[0] - prev[0]),
                prev[1] + t * (cur[1] - prev[1]),
            ]);
        }
    }
    return out;
}

function buildGnomonicCells(
    sites: Feature<Point>[],
    rawBbox: BBox,
): FeatureCollection<Polygon | MultiPolygon> {
    const sites3D = sites.map((f) =>
        to3D(f.geometry.coordinates[0], f.geometry.coordinates[1]),
    );

    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const s of sites3D) {
        sumX += s[0];
        sumY += s[1];
        sumZ += s[2];
    }
    const norm = Math.hypot(sumX, sumY, sumZ) || 1;
    const center3D: [number, number, number] = [
        sumX / norm,
        sumY / norm,
        sumZ / norm,
    ];
    const centerLng = (Math.atan2(center3D[1], center3D[0]) * 180) / Math.PI;

    const east: [number, number, number] = [
        -Math.sin((centerLng * Math.PI) / 180),
        Math.cos((centerLng * Math.PI) / 180),
        0,
    ];
    const north: [number, number, number] = [
        center3D[1] * east[2] - center3D[2] * east[1],
        center3D[2] * east[0] - center3D[0] * east[2],
        center3D[0] * east[1] - center3D[1] * east[0],
    ];

    function projectUV(lng: number, lat: number): [number, number] | null {
        const X = to3D(lng, lat);
        const denom = dot(X, center3D);
        if (denom <= 0.01) return null;
        const scale = 1 / denom;
        return [dot(X, east) * scale, dot(X, north) * scale];
    }

    function unprojectUV(u: number, v: number): [number, number] {
        const X: [number, number, number] = [
            center3D[0] + u * east[0] + v * north[0],
            center3D[1] + u * east[1] + v * north[1],
            center3D[2] + u * east[2] + v * north[2],
        ];
        const len = Math.hypot(X[0], X[1], X[2]);
        const lat = (Math.asin(X[2] / len) * 180) / Math.PI;
        const lng = (Math.atan2(X[1], X[0]) * 180) / Math.PI;
        return [lng, lat];
    }

    const fallbackBbox = rawBbox;

    const steps = 30;
    const baseUV: [number, number][] = [];
    for (let s = 0; s < steps; s++) {
        const lng =
            fallbackBbox[0] + ((fallbackBbox[2] - fallbackBbox[0]) * s) / steps;
        const uv = projectUV(lng, fallbackBbox[1]);
        if (uv) baseUV.push(uv);
    }
    for (let s = 0; s < steps; s++) {
        const lat =
            fallbackBbox[1] + ((fallbackBbox[3] - fallbackBbox[1]) * s) / steps;
        const uv = projectUV(fallbackBbox[2], lat);
        if (uv) baseUV.push(uv);
    }
    for (let s = 0; s < steps; s++) {
        const lng =
            fallbackBbox[2] - ((fallbackBbox[2] - fallbackBbox[0]) * s) / steps;
        const uv = projectUV(lng, fallbackBbox[3]);
        if (uv) baseUV.push(uv);
    }
    for (let s = 0; s < steps; s++) {
        const lat =
            fallbackBbox[3] - ((fallbackBbox[3] - fallbackBbox[1]) * s) / steps;
        const uv = projectUV(fallbackBbox[0], lat);
        if (uv) baseUV.push(uv);
    }

    const cells: Feature<Polygon | MultiPolygon>[] = [];
    for (let i = 0; i < sites.length; i++) {
        let poly = baseUV;
        for (let j = 0; j < sites.length; j++) {
            if (i === j) continue;
            const diff: [number, number, number] = [
                sites3D[i][0] - sites3D[j][0],
                sites3D[i][1] - sites3D[j][1],
                sites3D[i][2] - sites3D[j][2],
            ];
            const A = dot(diff, east);
            const B = dot(diff, north);
            const C = dot(diff, center3D);
            poly = clipConvexPoly(poly, A, B, C);
        }
        if (poly.length >= 3) {
            const ring: [number, number][] = [];
            const edgeSteps = 20;
            for (let e = 0; e < poly.length; e++) {
                const p1 = poly[e];
                const p2 = poly[(e + 1) % poly.length];
                for (let s = 0; s < edgeSteps; s++) {
                    const u = p1[0] + ((p2[0] - p1[0]) * s) / edgeSteps;
                    const v = p1[1] + ((p2[1] - p1[1]) * s) / edgeSteps;
                    ring.push(unprojectUV(u, v));
                }
            }
            ring.push(ring[0]);
            cells.push(turf.polygon([ring], { site: sites[i] }));
        }
    }
    return turf.featureCollection(cells);
}
/** The domain as boxes within longitudes -180 to 180. */
export function domainBoxes([west, south, east, north]: BBox): BBox[] {
    if (east - west >= 360) return [[-180, south, 180, north]];
    const start = west - 360 * Math.floor((west + 180) / 360);
    const end = start + (east - west);
    return end <= 180
        ? [[start, south, end, north]]
        : [
              [start, south, 180, north],
              [-180, south, end - 360, north],
          ];
}

/**
 * One cell per distinct site, with the source site as `properties.site`.
 * Sites within MERGE_METRES of an earlier one are the same place and get no
 * cell of their own (see distinctSites), so consumers should find a site's
 * cell with cellOfSite. The cells are geoSpatialVoronoi's, drawn finely
 * inside `fallbackBbox`, and are kept when every site has a cell and lies
 * inside it, which they are drawn to ensure. A builder bug can still break
 * that, as merging genuine half-turn edges once did; the cells then fall
 * back to a planar approximation over `fallbackBbox`, gnomonic for a
 * regional domain and Mercator, with errors of up to kilometres, for a
 * world-scale one.
 */
export const geoSpatialVoronoiSafe = (
    points: FeatureCollection<Point>,
    fallbackBbox: BBox,
): FeatureCollection<Polygon | MultiPolygon> => {
    const distinct = distinctSites(points.features);
    const sites = points.features.filter((_, i) => distinct[i]);
    if (!sites.length) return turf.featureCollection([]);
    if (sites.length === 1) {
        const boxes = domainBoxes(fallbackBbox).map(
            (box) => turf.bboxPolygon(box).geometry.coordinates,
        );
        // The whole domain, drawn within longitudes -180 to 180.
        const cell: Feature<Polygon | MultiPolygon> =
            boxes.length === 1
                ? turf.polygon(boxes[0], { site: sites[0] })
                : turf.multiPolygon(boxes, { site: sites[0] });
        return turf.featureCollection([cell]);
    }
    const distinctPoints =
        sites.length === points.features.length
            ? points
            : turf.featureCollection(sites);
    try {
        const spherical = geoSpatialVoronoi(distinctPoints, fallbackBbox);
        // Every distinct site has a cell, with the site inside it.
        const cells = spherical.features.filter(
            (feature): feature is Feature<Polygon | MultiPolygon> => {
                const site = (
                    feature.properties as { site?: Feature<Point> } | undefined
                )?.site;
                if (!site || !feature.geometry) return false;
                // Cells are drawn within longitudes -180 to 180.
                const [lon, lat] = site.geometry.coordinates;
                return turf.booleanPointInPolygon(
                    [lon - 360 * Math.round(lon / 360), lat],
                    feature as Feature<Polygon | MultiPolygon>,
                );
            },
        );
        if (cells.length === sites.length) {
            return turf.featureCollection(cells);
        }
    } catch {
        // Fall back to an approximation below.
    }
    const isWorld = fallbackBbox[0] <= -170 && fallbackBbox[2] >= 170;
    if (!isWorld && sites.length <= 64) {
        try {
            const gnomonic = buildGnomonicCells(sites, fallbackBbox);
            if (gnomonic.features.length === sites.length) {
                return gnomonic;
            }
        } catch {
            // Fall back to planar Voronoi
        }
    }

    const mercPoints = turf.featureCollection(
        distinctPoints.features.map((f) => turf.toMercator(f)),
    );
    const effBbox: BBox = [
        Math.max(-180, fallbackBbox[0]),
        Math.max(-85, fallbackBbox[1]),
        Math.min(180, fallbackBbox[2]),
        Math.min(85, fallbackBbox[3]),
    ];
    const p1 = turf.toMercator(turf.point([effBbox[0], effBbox[1]]));
    const p2 = turf.toMercator(turf.point([effBbox[2], effBbox[3]]));
    let minX = Math.min(p1.geometry.coordinates[0], p2.geometry.coordinates[0]);
    let minY = Math.min(p1.geometry.coordinates[1], p2.geometry.coordinates[1]);
    let maxX = Math.max(p1.geometry.coordinates[0], p2.geometry.coordinates[0]);
    let maxY = Math.max(p1.geometry.coordinates[1], p2.geometry.coordinates[1]);

    for (const pt of mercPoints.features) {
        const [x, y] = pt.geometry.coordinates;
        if (x <= minX) minX = x - 1000;
        if (x >= maxX) maxX = x + 1000;
        if (y <= minY) minY = y - 1000;
        if (y >= maxY) maxY = y + 1000;
    }

    const planar = turf.voronoi(mercPoints, {
        bbox: [minX, minY, maxX, maxY],
    });
    const features: Feature<Polygon | MultiPolygon>[] = [];
    planar.features.forEach((f, i) => {
        if (f?.geometry) {
            const wgs = turf.toWgs84(f);
            wgs.properties = { ...(wgs.properties ?? {}), site: sites[i] };
            features.push(wgs as Feature<Polygon | MultiPolygon>);
        }
    });
    return turf.featureCollection(features);
};

/**
 * The cell of the site at `position`, among geoSpatialVoronoiSafe's: the one
 * whose own site is nearest it. For a site with a cell that is its own; for
 * one merged away it is the cell of the nearest kept site, which need not be
 * the site it was merged into. Undefined when no cell's site is within
 * MERGE_METRES.
 */
export function cellOfSite<C extends Feature>(
    cells: C[],
    position: Position,
): C | undefined {
    let found: C | undefined;
    let nearest = Infinity;
    for (const cell of cells) {
        const site = (cell.properties as { site?: Feature<Point> } | null)
            ?.site;
        if (!site) continue;
        const metres = turf.distance(site, position, { units: "meters" });
        if (metres < nearest) [found, nearest] = [cell, metres];
    }
    // With a micrometre to spare for rounding.
    return nearest <= MERGE_METRES + 1e-6 ? found : undefined;
}
