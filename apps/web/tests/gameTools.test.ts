import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGameDefinitionJson } from "@searchlight/shared";
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

    it("builds download URLs from Google My Maps and Docs links", () => {
        expect(
            gt.myMapsKmlUrl("https://www.google.com/maps/d/edit?mid=1vZk1FFBbYBhjQ3B2Zbc0u1huoMV9E5c&usp=sharing"),
        ).toBe("https://www.google.com/maps/d/kml?mid=1vZk1FFBbYBhjQ3B2Zbc0u1huoMV9E5c&forcekml=1");
        expect(
            gt.googleDocTextUrl("https://docs.google.com/document/d/1f_xLPFbmtMv4rvzUYvB5iEAN_3sGy71XM4QKiqYl13A/edit?usp=drivesdk"),
        ).toBe("https://docs.google.com/document/d/1f_xLPFbmtMv4rvzUYvB5iEAN_3sGy71XM4QKiqYl13A/export?format=txt");
        expect(() => gt.myMapsKmlUrl("https://example.com/map")).toThrow(/no map ID/);
    });

    it("decodes names and reads them from another property", () => {
        expect(gt.decodeText("<![CDATA[Gare d'Est]]>")).toBe("Gare d'Est");
        expect(gt.decodeText("Art &amp;amp; Craft &#233;")).toBe("Art & Craft é");
        const [ward, plain] = gt.normalize(
            [pin({ name: "Polygon 82", WD26NM: "Ridgeway &amp; Marsh Lane" }), pin({ name: "Kept" })],
            { name: "WD26NM" },
        );
        expect(ward.properties).toEqual({ name: "Ridgeway & Marsh Lane" });
        expect(plain.properties).toEqual({ name: "Kept" });
    });

    it("merges same-named regions and lines, keeping order", () => {
        const square = (x: number) => ({
            type: "Polygon",
            coordinates: [[[x, 50], [x + 1, 50], [x + 1, 51], [x, 50]]],
        });
        const merged = gt.mergeByName([
            pin({ name: "S60" }, square(0)),
            pin({ name: "S1" }, square(2)),
            pin({ name: "S60" }, square(4)),
            pin({ name: "S60" }, { type: "LineString", coordinates: [[0, 50], [1, 50]] }),
            pin({ name: "Stop" }),
        ]);
        expect(merged.map((f: any) => [f.properties.name, f.geometry.type])).toEqual([
            ["S60", "MultiPolygon"],
            ["S1", "Polygon"],
            ["S60", "LineString"],
            ["Stop", "Point"],
        ]);
        expect(merged[0].geometry.coordinates).toEqual([square(0).coordinates, square(4).coordinates]);
    });

    it("groups by a property and measures drawn circles", () => {
        const groups = gt.groupBy([pin({ styleUrl: "#a" }), pin({ styleUrl: "#b" }), pin({ styleUrl: "#a" })], "styleUrl");
        expect([...groups].map(([k, v]) => [k, v.length])).toEqual([["#a", 2], ["#b", 1]]);
        // 250 m circle around Sheffield station, 64 segments.
        const [lng, lat] = [-1.4625, 53.3781];
        const ring = Array.from({ length: 65 }, (_, i) => {
            const a = (i % 64) * (2 * Math.PI / 64);
            return [lng + (250 * Math.sin(a)) / (111320 * Math.cos(lat * Math.PI / 180)), lat + (250 * Math.cos(a)) / 111132];
        });
        expect(gt.circleRadius(pin({}, { type: "Polygon", coordinates: [ring] }))).toBeCloseTo(250, -1);
        expect(gt.circleRadius(pin({}, { type: "LineString", coordinates: ring }))).toBeCloseTo(250, -1);
        expect(() => gt.circleRadius(pin({}))).toThrow(/expected a Polygon/);
    });

    it("formats a game file as the app's downloads do", () => {
        const geometry = {
            type: "MultiPolygon",
            coordinates: [
                [[[0, 50], [1, 50], [1, 51], [0, 50]]],
                [[[4.5, 50.25], [5, 50], [5, 51], [4.5, 50.25]]],
            ],
        };
        for (const game of [
            { name: "Areas", features: [pin({ name: "S60" }, geometry), pin({ name: "Stop" })] },
            { properties: { coordinates: "52.1 N, 4.3 E" }, geometry: { coordinates: [["a", 1]] } },
            { note: "\u0000[1,2]\u0000", geometry: { coordinates: [1, 2] } },
            { "\u0000[1]\u0000": 1, geometry: { coordinates: [1, 2] } },
        ]) {
            expect(gt.formatGame(game)).toBe(formatGameDefinitionJson(game));
            expect(gt.formatGame(game, "\t")).toBe(formatGameDefinitionJson(game, "\t"));
        }
        expect(gt.formatGame({ geometry })).toContain(
            `"coordinates": ${JSON.stringify(geometry.coordinates)}`,
        );
    });
});
