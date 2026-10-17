import type { GameDefinition } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";
import {
    checkGameQuality,
    formatFileSize,
    summarizeLayers,
} from "@/game-definition/inspect";

const square = (w: number, s: number, e: number, n: number) => [
    [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ],
];
const point = (id: string, lng: number, lat: number) => ({
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { name: id },
});
const region = (id: string, w: number, s: number, e: number, n: number) => ({
    type: "Feature",
    id,
    geometry: { type: "Polygon", coordinates: square(w, s, e, n) },
    properties: { name: id },
});
const collection = <T>(features: T[]) => ({
    type: "FeatureCollection",
    features,
});

function game() {
    return {
        id: "testville-2026",
        name: "Testville 12-10",
        serverId: "home-games",
        map: {
            center: [10.5, 50.5],
            bounds: [9.9, 49.9, 11.1, 51.1],
            playArea: collection([region("area", 10, 50, 11, 51)]),
        },
        hidingZones: {
            radius: 400,
            features: collection([
                point("north", 10.5, 50.8),
                point("south", 10.5, 50.2),
            ]),
        },
        radars: [400],
        thermometer: true,
        features: [
            {
                name: "Museum",
                enabledFor: ["matching", "measuring", "tentacle"],
                data: collection([
                    point("a", 10.2, 50.2),
                    point("b", 10.8, 50.8),
                ]),
            },
            {
                name: "District",
                enabledFor: ["matching", "measuring"],
                data: collection([
                    region("west", 10, 50, 10.5, 51),
                    region("east", 10.5, 50, 11, 51),
                ]),
            },
            {
                name: "River",
                enabledFor: ["measuring"],
                data: collection([
                    {
                        type: "Feature",
                        geometry: {
                            type: "LineString",
                            coordinates: [
                                [10, 50.5],
                                [11, 50.5],
                            ],
                        },
                        properties: { name: "River" },
                    },
                ]),
            },
        ],
    };
}

describe("summarizeLayers", () => {
    it("lists each layer's geometry, size and the questions built on it", () => {
        const compiled = compileGameDefinition(
            game() as unknown as GameDefinition,
        );
        expect(summarizeLayers(compiled)).toEqual([
            {
                index: 0,
                name: "Museum",
                geometry: "points",
                featureCount: 2,
                questions: ["matching", "measuring", "tentacle"],
            },
            {
                index: 1,
                name: "District",
                geometry: "polygons",
                featureCount: 2,
                questions: ["matching", "measuring"],
            },
            {
                index: 2,
                name: "River",
                geometry: "lines",
                featureCount: 1,
                questions: ["measuring"],
            },
        ]);
    });

    it("tells layers apart when their names share a slug", () => {
        const def = game();
        def.features[1].name = "Museum!";
        def.features[1].data = collection([]) as any;
        const layers = summarizeLayers(
            compileGameDefinition(def as unknown as GameDefinition),
        );
        expect(layers[0].questions).toEqual([
            "matching",
            "measuring",
            "tentacle",
        ]);
        expect(layers[1]).toMatchObject({ geometry: "empty", featureCount: 0 });
    });
});

describe("checkGameQuality", () => {
    it("has nothing to say about a clean game", async () => {
        expect(await checkGameQuality(game())).toEqual([]);
    });

    it("marks the warnings --strict fails on", async () => {
        const def = game();
        // A zone outside the play area (strict) and a single-site
        // tentacle (not strict).
        def.hidingZones.features.features.push(point("away", 12, 52));
        def.features[0].data.features.pop();
        const issues = await checkGameQuality(def);
        expect(
            issues.map(({ level, code, strict }) => ({ level, code, strict })),
        ).toEqual(
            expect.arrayContaining([
                {
                    level: "warning",
                    code: "zones-outside-play-area",
                    strict: true,
                },
                {
                    level: "warning",
                    code: "single-feature-tentacle",
                    strict: false,
                },
            ]),
        );
    });

    it("passes notes and the file size through", async () => {
        const def: Record<string, unknown> = game();
        delete def.thermometer;
        const issues = await checkGameQuality(def, 11 * 1024 * 1024);
        expect(issues.map((i) => [i.level, i.code])).toEqual([
            ["warning", "large-file"],
            ["note", "no-thermometer"],
        ]);
    });
});

describe("formatFileSize", () => {
    it("rounds to a readable unit", () => {
        expect(formatFileSize(512)).toBe("512 B");
        expect(formatFileSize(747615)).toBe("730 KB");
        expect(formatFileSize(6555743)).toBe("6.3 MB");
    });
});
