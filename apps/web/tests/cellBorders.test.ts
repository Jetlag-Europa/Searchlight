import * as turf from "@turf/turf";
import type { Position } from "geojson";
import { describe, expect, it } from "vitest";

import {
    calculateCellBorders,
    clipLinesToArea,
} from "@/maps/geo-utils/cellBorders";

const square = turf.featureCollection([turf.bboxPolygon([-1, -1, 1, 1])]);

const planarLength = (paths: Position[][]) =>
    paths.reduce(
        (total, path) =>
            total +
            path
                .slice(1)
                .reduce(
                    (sum, point, i) =>
                        sum +
                        Math.hypot(
                            point[0] - path[i][0],
                            point[1] - path[i][1],
                        ),
                    0,
                ),
        0,
    );

describe("clipping lines to an area", () => {
    it("keeps only the parts inside, cutting where lines cross the edge", () => {
        const kept = clipLinesToArea(
            [
                [
                    [-3, 0],
                    [3, 0],
                ],
                [
                    [2, 2],
                    [3, 3],
                ],
            ],
            square,
        );
        expect(kept).toEqual([
            [
                [-1, 0],
                [1, 0],
            ],
        ]);
    });

    it("splits a line that leaves and re-enters, and skips holes", () => {
        const holed = turf.featureCollection([
            turf.polygon([
                [
                    [-2, -1],
                    [2, -1],
                    [2, 1],
                    [-2, 1],
                    [-2, -1],
                ],
                [
                    [-1, -0.5],
                    [1, -0.5],
                    [1, 0.5],
                    [-1, 0.5],
                    [-1, -0.5],
                ].reverse(),
            ]),
        ]);
        const kept = clipLinesToArea(
            [
                [
                    [-3, 0],
                    [0, 0],
                    [3, 0],
                ],
            ],
            holed,
        );
        expect(kept).toHaveLength(2);
        expect(planarLength(kept)).toBeCloseTo(2);
    });

    it("leaves out lines along the edge, keeping what goes inside from it", () => {
        const kept = clipLinesToArea(
            [
                [
                    [-1, -1],
                    [1, -1],
                    [1, 3],
                ],
                [
                    [-1, 1],
                    [1, 1],
                    [0, 0],
                ],
            ],
            square,
        );
        expect(kept).toEqual([
            [
                [1, 1],
                [0, 0],
            ],
        ]);
    });

    it("tests the side again after a crossing at a segment's very end", () => {
        const kept = clipLinesToArea(
            [
                [
                    [0, 0.5],
                    [0, -1 - 1e-10],
                    [0, -1.01],
                    [3, -3],
                    [3, -5],
                ],
            ],
            square,
        );
        expect(planarLength(kept)).toBeCloseTo(1.5);
    });
});

describe("cell borders", () => {
    it("draws each border between cells once, only within the area", () => {
        const cells = [
            turf.bboxPolygon([-2, -2, 0, 0]),
            turf.bboxPolygon([0, -2, 2, 0]),
            turf.bboxPolygon([-2, 0, 0, 2]),
            turf.bboxPolygon([0, 0, 2, 2]),
        ];
        const borders = calculateCellBorders({
            kind: "cellBorders",
            cells,
            area: square,
        });
        // The cross where the four cells meet, each arm once.
        expect(planarLength(borders!.geometry.coordinates)).toBeCloseTo(4);
        for (const path of borders!.geometry.coordinates) {
            for (const [x, y] of path) {
                expect(Math.abs(x) <= 1 && Math.abs(y) <= 1).toBe(true);
            }
        }
    });

    it("doesn't redraw the area's edge where regions share it", () => {
        // Two regions tiling the area exactly, slanted so that midpoints
        // along the shared edge round to either side.
        const area = turf.featureCollection([
            turf.polygon([
                [
                    [0, 0],
                    [3, 0.1],
                    [3.3, 2.7],
                    [0.1, 3],
                    [0, 0],
                ],
            ]),
        ]);
        const cells = [
            turf.polygon([
                [
                    [0, 0],
                    [3, 0.1],
                    [3.3, 2.7],
                    [0, 0],
                ],
            ]),
            turf.polygon([
                [
                    [0, 0],
                    [3.3, 2.7],
                    [0.1, 3],
                    [0, 0],
                ],
            ]),
        ];
        const borders = calculateCellBorders({
            kind: "cellBorders",
            cells,
            area,
        });
        expect(borders!.geometry.coordinates).toEqual([
            [
                [3.3, 2.7],
                [0, 0],
            ],
        ]);
    });

    it("leaves out region borders traced just inside the area's edge", () => {
        const off = 1e-5;
        const cells = [
            turf.bboxPolygon([-1 + off, -1 + off, 0, 1 - off]),
            turf.bboxPolygon([0, -1 + off, 1 - off, 1 - off]),
        ];
        const borders = calculateCellBorders({
            kind: "cellBorders",
            cells,
            area: square,
        });
        for (const path of borders!.geometry.coordinates) {
            for (const [x] of path) expect(x).toBe(0);
        }
    });

    it("skips a zero-length edge left on its own", () => {
        // The second cell's repeated corner is cut off between edges the
        // first cell already drew, leaving a line of one repeated point.
        const cells = [
            turf.bboxPolygon([-2, -2, 0, 0]),
            turf.polygon([
                [
                    [0, -2],
                    [0, 0],
                    [0, 0],
                    [-2, 0],
                    [0, -2],
                ],
            ]),
        ];
        const borders = calculateCellBorders({
            kind: "cellBorders",
            cells,
            area: square,
        });
        for (const path of borders!.geometry.coordinates) {
            expect(new Set(path.map(String)).size).toBeGreaterThan(1);
        }
    });

    it("simplifies finely drawn borders", () => {
        const steps = 1000;
        const wiggly = turf.polygon([
            [
                ...Array.from(
                    { length: steps + 1 },
                    (_, i): Position => [
                        -2 + (4 * i) / steps,
                        1e-7 * Math.sin(i),
                    ],
                ),
                [2, 2],
                [-2, 2],
                [-2, 0],
            ],
        ]);
        const borders = calculateCellBorders({
            kind: "cellBorders",
            cells: [wiggly],
            area: square,
        });
        const points = borders!.geometry.coordinates.flat().length;
        expect(points).toBeLessThan(20);
    });

    it("has none without cells or an area", () => {
        expect(
            calculateCellBorders({
                kind: "cellBorders",
                cells: [],
                area: square,
            }),
        ).toBeNull();
        expect(
            calculateCellBorders({
                kind: "cellBorders",
                cells: [turf.bboxPolygon([5, 5, 6, 6])],
                area: square,
            }),
        ).toBeNull();
    });
});
