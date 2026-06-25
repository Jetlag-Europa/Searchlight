import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";

/**
 * Failure aid only — never the gate. When a grid-oracle test finds disagreeing
 * points, this dumps a standalone SVG (no browser, no deps) so a human can see
 * *why* a point disagreed: the base boundary, the computed mask, the POIs/sites,
 * an optional hider, and the offending points (red = expected survive but masked
 * out, blue = expected eliminate but kept).
 *
 * Simple linear lng/lat → viewBox scale (fine for the small, low-latitude
 * scenarios the harness uses). Output goes to `apps/web/test-results/<name>.svg`.
 */

export interface DebugLayers {
    base: Feature<Polygon | MultiPolygon>;
    mask?: Feature<Polygon | MultiPolygon> | null;
    sites?: Feature<Point>[];
    hider?: [number, number]; // [lng, lat]
    /** Points that disagreed, each tagged with how. */
    bad?: { coord: [number, number]; kind: "missing" | "extra" }[];
}

const W = 800;
const PAD = 20;

export function renderDebugSVG(name: string, layers: DebugLayers): string {
    const [minX, minY, maxX, maxY] = turf.bbox(layers.base);
    const dx = maxX - minX || 1e-6;
    const dy = maxY - minY || 1e-6;
    const H = Math.max(1, Math.round((W * dy) / dx));

    const sx = (lng: number) => PAD + ((lng - minX) / dx) * (W - 2 * PAD);
    // SVG y grows downward; flip so north is up.
    const sy = (lat: number) => PAD + ((maxY - lat) / dy) * (H - 2 * PAD);

    const ringPath = (coords: number[][]) =>
        coords
            .map(
                (c, i) =>
                    `${i === 0 ? "M" : "L"}${sx(c[0]).toFixed(1)},${sy(c[1]).toFixed(1)}`,
            )
            .join(" ") + " Z";

    const polyPaths = (f: Feature<Polygon | MultiPolygon>): string[] => {
        const out: string[] = [];
        const geom = f.geometry;
        const polys =
            geom.type === "Polygon"
                ? [geom.coordinates]
                : (geom.coordinates as number[][][][]);
        for (const poly of polys) for (const ring of poly) out.push(ringPath(ring));
        return out;
    };

    const parts: string[] = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    );
    parts.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
    for (const d of polyPaths(layers.base))
        parts.push(`<path d="${d}" fill="#eee" stroke="#999" stroke-width="1"/>`);
    if (layers.mask)
        for (const d of polyPaths(layers.mask))
            parts.push(
                `<path d="${d}" fill="#3a7bd5" fill-opacity="0.35" stroke="#1f4e9c" stroke-width="1.5"/>`,
            );
    for (const s of layers.sites ?? []) {
        const [lng, lat] = s.geometry.coordinates;
        const label = String(s.properties?.name ?? "");
        parts.push(
            `<circle cx="${sx(lng).toFixed(1)}" cy="${sy(lat).toFixed(1)}" r="4" fill="#222"/>`,
        );
        if (label)
            parts.push(
                `<text x="${(sx(lng) + 6).toFixed(1)}" y="${(sy(lat) - 6).toFixed(1)}" font-size="12" fill="#222">${label}</text>`,
            );
    }
    if (layers.hider) {
        const [lng, lat] = layers.hider;
        parts.push(
            `<circle cx="${sx(lng).toFixed(1)}" cy="${sy(lat).toFixed(1)}" r="6" fill="none" stroke="#e67e22" stroke-width="2.5"/>`,
        );
    }
    for (const b of layers.bad ?? []) {
        const [lng, lat] = b.coord;
        const color = b.kind === "missing" ? "#e74c3c" : "#2980b9";
        parts.push(
            `<circle cx="${sx(lng).toFixed(1)}" cy="${sy(lat).toFixed(1)}" r="3" fill="${color}"/>`,
        );
    }
    parts.push("</svg>");
    const svg = parts.join("\n");

    const out = resolve(
        __dirname,
        "..",
        "..",
        "test-results",
        `${name}.svg`,
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, svg);
    return out;
}

/** Convenience: parse the `failures` strings from `gridAgreement` back into
 *  tagged coordinates for the SVG. */
export function failuresToBad(
    failures: string[],
): { coord: [number, number]; kind: "missing" | "extra" }[] {
    return failures.map((f) => {
        const kind = f.includes("masked out") ? "missing" : "extra";
        const m = f.match(/(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        const coord: [number, number] = m
            ? [parseFloat(m[1]), parseFloat(m[2])]
            : [0, 0];
        return { coord, kind };
    });
}

export type { FeatureCollection };
