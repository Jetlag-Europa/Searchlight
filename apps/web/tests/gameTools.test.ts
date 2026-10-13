import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import * as gt from "../public/skills/create-game/game-tools.mjs";

const dir = mkdtempSync(join(tmpdir(), "game-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pin = (properties: Record<string, unknown>, geometry?: unknown) => ({
    type: "Feature",
    geometry: geometry ?? { type: "Point", coordinates: [10, 50] },
    properties,
});

describe("game-tools.mjs", () => {
    it("skips CSV rows without numeric coordinates instead of using [0, 0]", () => {
        const file = join(dir, "zones.csv");
        writeFileSync(
            file,
            "name,lat,lng\nKept,50.1,10.2\nBlank,,\nText,north,10\nZero,0,0\n",
        );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const features = gt.readCsv(file);
            expect(
                features.map((f: any) => [
                    f.properties.name,
                    f.geometry.coordinates,
                ]),
            ).toEqual([
                ["Kept", [10.2, 50.1]],
                ["Zero", [0, 0]],
            ]);
            expect(warn).toHaveBeenCalledWith(
                `${file}: skipped 2 row(s) without a numeric lat and lng`,
            );
        } finally {
            warn.mockRestore();
        }
    });

    it("turns numeric-looking KML radius strings into numbers", () => {
        const [plain, text] = gt.normalize(
            [pin({ name: " A ", radius: " 600 " }), pin({ radius: "big" })],
            { keep: ["name", "radius"] },
        );
        expect(plain.properties).toEqual({ name: "A", radius: 600 });
        expect(text.properties).toEqual({ radius: "big" });
    });

    it("fails clearly on a missing folder or empty input", () => {
        const folders = new Map([["Stations", [pin({ name: "A" })]]]);
        expect(() => gt.normalize(folders.get("Stops"))).toThrow(
            /normalize: expected an array of features, got undefined/,
        );
        expect(() => gt.bbox([])).toThrow("bbox: no features");
        expect(gt.bbox(gt.normalize(folders.get("Stations")))).toEqual([
            10, 50, 10, 50,
        ]);
    });

    it("splits a pin-and-shape placemark, and layer() rejects the mix", () => {
        const placemark = pin(
            { name: "Park" },
            {
                type: "GeometryCollection",
                geometries: [
                    { type: "Point", coordinates: [10, 50] },
                    {
                        type: "Polygon",
                        coordinates: [
                            [
                                [10, 50],
                                [10.1, 50],
                                [10.1, 50.1],
                                [10, 50],
                            ],
                        ],
                    },
                ],
            },
        );
        const features = gt.normalize([placemark]);
        expect(features.map((f: any) => f.geometry.type)).toEqual([
            "Point",
            "Polygon",
        ]);
        expect(() => gt.layer("Park", ["matching"], features)).toThrow(
            /mixes points and polygons/,
        );
        const parks = features.filter((f: any) => f.geometry.type === "Point");
        expect(gt.layer("Park", ["matching"], parks).data.features).toHaveLength(
            1,
        );
    });
});
