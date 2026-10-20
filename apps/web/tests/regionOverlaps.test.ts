import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Point, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import {
    findRegionOverlaps,
    removeRegionOverlaps,
} from "@/maps/geo-utils/regionOverlaps";

type Region = Feature<Polygon | MultiPolygon>;

const belgium = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../games/preloaded/belgium-2026.game.json"),
        "utf8",
    ),
);

// Boxes around Brussels's latitude, in degrees.
const box = (
    west: number,
    east: number,
    name: string,
    south = 50,
    north = 51,
) =>
    turf.bboxPolygon([west, south, east, north], {
        properties: { name },
        id: name,
    }) as Region;

describe("findRegionOverlaps", () => {
    it("reports neighbours that share a border exactly as clean", () => {
        const overlaps = findRegionOverlaps({
            regions: [box(0, 1, "a"), box(1, 2, "b")],
        });
        expect(overlaps.pieces).toEqual([]);
        expect(overlaps.hidden).toEqual([]);
    });

    it("measures a sliver between neighbours", () => {
        // 0.001° of longitude at 50.5° is about 71 m.
        const overlaps = findRegionOverlaps({
            regions: [box(0, 1.001, "a"), box(1, 2, "b")],
        });
        expect(overlaps.pieces).toHaveLength(1);
        const [piece] = overlaps.pieces;
        expect(piece).toMatchObject({ first: 0, second: 1 });
        expect(piece.width).toBeGreaterThan(65);
        expect(piece.width).toBeLessThan(75);
        expect(piece.area / 1e6).toBeCloseTo(111 * 0.071, 0);
    });

    it("ignores hairline overlaps", () => {
        // About 7 cm.
        const overlaps = findRegionOverlaps({
            regions: [box(0, 1.000001, "a"), box(1, 2, "b")],
        });
        expect(overlaps.pieces).toEqual([]);
        expect(overlaps.hairlines).toBe(1);
    });

    it("measures a spike by how far it reaches, however small", () => {
        // A corner of b 1 m into a, on a 1.6 m base: 0.8 m², and on
        // average under 0.4 m wide.
        const meter = 1 / (111_195 * Math.cos((50.5 * Math.PI) / 180));
        const b = turf.polygon(
            [
                [
                    [1, 50],
                    [2, 50],
                    [2, 51],
                    [1, 51],
                    [1, 50.5 + 0.8 / 111_195],
                    [1 - meter, 50.5],
                    [1, 50.5 - 0.8 / 111_195],
                    [1, 50],
                ],
            ],
            { name: "b" },
        ) as Region;
        const overlaps = findRegionOverlaps({ regions: [box(0, 1, "a"), b] });
        expect(overlaps.pieces).toHaveLength(1);
        expect(overlaps.pieces[0].area).toBeLessThan(1);
        expect(overlaps.pieces[0].width).toBeCloseTo(1, 1);
    });

    it("finds a region entirely inside an earlier one", () => {
        const overlaps = findRegionOverlaps({
            regions: [box(0, 2, "outer"), box(0.5, 1, "inner", 50.2, 50.4)],
        });
        expect(overlaps.hidden).toEqual([{ region: 1, by: [0] }]);
    });
});

describe("removeRegionOverlaps", () => {
    it("gives the overlap to the first region and keeps ids and properties", () => {
        const [a, b] = removeRegionOverlaps({
            regions: [box(0, 1.001, "a"), box(1, 2, "b")],
        });
        expect(a).toEqual(box(0, 1.001, "a"));
        expect(b.id).toBe("b");
        expect(b.properties).toEqual({ name: "b" });
        expect(turf.bbox(b)[0]).toBeCloseTo(1.001, 6);
        expect(findRegionOverlaps({ regions: [a, b] }).pieces).toEqual([]);
    });

    it("leaves regions that only touch, or overlap by hairlines, as they were", () => {
        const regions = [
            box(0, 1.001, "a"),
            box(1, 2, "b"),
            // A hairline (about 7 cm) into b.
            box(1.999999, 3, "c"),
        ];
        const [a, b, c] = removeRegionOverlaps({ regions });
        expect(a).toBe(regions[0]);
        expect(b).not.toBe(regions[1]);
        expect(c).toBe(regions[2]);
    });

    it("rounds new corners to 6 decimals in a coarser layer", () => {
        // Four decimals is an 11 m grid; the new corners land between.
        const a = turf.polygon(
            [
                [
                    [0, 0],
                    [1.00005, 0.5],
                    [0, 1],
                    [0, 0],
                ],
            ],
            { name: "a" },
        ) as Region;
        const b = box(1, 2, "b", 0, 1);
        const [, cleaned] = removeRegionOverlaps({ regions: [a, b] });
        const xs = turf.coordAll(cleaned).map(([x]) => x);
        expect(xs.some((x) => x > 1 && x < 1.0001)).toBe(true);
        for (const x of xs) {
            expect(Math.round(x * 1e6) / 1e6).toBe(x);
        }
        expect(findRegionOverlaps({ regions: [a, cleaned] }).pieces).toEqual(
            [],
        );
    });

    it("agrees with the check on what lies entirely inside", () => {
        // A 10 x 25 m region less than a square meter of which sticks out.
        const inner = box(0.5, 0.50014, "inner", 50.5, 50.50009);
        const almost = box(0.4, 0.5001395, "outer", 50.4, 50.6);
        const regions = [almost, inner];
        const { hidden } = findRegionOverlaps({ regions });
        expect(hidden).toEqual([{ region: 1, by: [0] }]);
        expect(() => removeRegionOverlaps({ regions })).toThrow(
            /lies entirely inside/,
        );
    });

    it("refuses to empty a region", () => {
        expect(() =>
            removeRegionOverlaps({
                regions: [box(0, 2, "outer"), box(0.5, 1, "inner", 50.2, 50.4)],
            }),
        ).toThrow(/Region 2 lies entirely inside/);
    });

    it("cleans overlapping provinces without moving any hiding zone", () => {
        // Belgium's provinces, each grown by 30 m into its neighbours.
        const provinces = (
            belgium.features.find(
                (layer: { name: string }) => layer.name === "Province",
            ).data.features as Region[]
        ).map(
            (province) =>
                ({
                    ...turf.buffer(province, 30, { units: "meters" })!,
                    properties: province.properties,
                }) as Region,
        );
        const before = findRegionOverlaps({ regions: provinces });
        expect(before.pieces.length).toBeGreaterThan(10);

        const cleaned = removeRegionOverlaps({ regions: provinces });
        expect(findRegionOverlaps({ regions: cleaned }).pieces).toEqual([]);

        // Matching answers stay: each zone is in the same first province.
        const owner = (regions: Region[], point: Feature<Point>) =>
            regions.findIndex((region) =>
                turf.booleanPointInPolygon(point, region),
            );
        for (const zone of belgium.hidingZones.features.features) {
            expect(owner(cleaned, zone)).toBe(owner(provinces, zone));
        }
        // Each overlap is lost once.
        const removed =
            provinces.reduce((sum, region) => sum + turf.area(region), 0) -
            cleaned.reduce((sum, region) => sum + turf.area(region), 0);
        const overlapping = before.pieces.reduce(
            (sum, piece) => sum + piece.area,
            0,
        );
        expect(removed / overlapping).toBeCloseTo(1, 1);
    }, 60_000);
});

describe("preloaded games", () => {
    const dir = resolve(__dirname, "../../../games/preloaded");
    // Overlaps are fixed with `pnpm fix:region-overlaps`.
    it.each(readdirSync(dir).filter((file) => file.endsWith(".game.json")))(
        "%s marks every region layer, which has no overlaps or repeated vertices",
        (file) => {
            const game = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
            for (const layer of game.features ?? []) {
                const regions = layer.data.features as Region[];
                if (
                    !regions.length ||
                    !regions.every((f) => f.geometry.type.endsWith("Polygon"))
                ) {
                    continue;
                }
                expect(layer.noOverlaps, layer.name).toBe(true);
                // Zero-length edges trip Turf's distances.
                const repeats = regions.flatMap((region) =>
                    turf
                        .flatten(turf.polygonToLine(region))
                        .features.flatMap((line) =>
                            line.geometry.coordinates.filter(
                                ([x, y], i, ring) =>
                                    i > 0 &&
                                    x === ring[i - 1][0] &&
                                    y === ring[i - 1][1],
                            ),
                        ),
                );
                expect(repeats, layer.name).toEqual([]);
                expect(
                    findRegionOverlaps({ regions }).pieces,
                    layer.name,
                ).toEqual([]);
            }
        },
        30_000,
    );
});
