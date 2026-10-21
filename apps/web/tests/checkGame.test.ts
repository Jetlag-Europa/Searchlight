import type { GameDefinition } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";

import {
    checkGame,
    STRICT_CODES,
} from "../public/skills/create-game/check-game.mjs";

const square = (w: number, s: number, e: number, n: number) => [
    [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ],
];
const point = (id: string, lng: number, lat: number, properties = {}) => ({
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties: { name: id, ...properties },
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

function game(overrides: Record<string, unknown> = {}) {
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
            unit: "meters",
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
        ],
        ...overrides,
    };
}

const codes = (result: ReturnType<typeof checkGame>) =>
    [...result.warnings, ...result.notes].map((issue) => issue.code);

/** A region whose boundary is a circle of `vertices` vertices. */
const round = (
    id: string,
    lng: number,
    lat: number,
    radius: number,
    vertices: number,
) => {
    const ring = Array.from({ length: vertices }, (_, i) => {
        const angle = (2 * Math.PI * i) / vertices;
        return [lng + radius * Math.cos(angle), lat + radius * Math.sin(angle)];
    });
    return {
        type: "Feature",
        id,
        geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
        properties: { name: id },
    };
};
const heavy = (enabledFor: string[], regions: ReturnType<typeof round>[]) =>
    checkGame(
        game({
            features: [
                { name: "District", enabledFor, data: collection(regions) },
            ],
        }),
    );
const heavyIssues = (result: ReturnType<typeof checkGame>) => ({
    warnings: result.warnings.filter((w) => w.code === "heavy-geometry"),
    notes: result.notes.filter((n) => n.code === "heavy-geometry"),
});

describe("check-game.mjs", () => {
    it("passes a clean game and lists its questions", () => {
        const result = checkGame(game());
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.questions.map((q) => q.label)).toEqual([
            "any radius (starts at 400 m)",
            "",
            "Nearest Museum",
            "Distance to Museum",
            "Tentacles: Museum",
        ]);
    });

    it("lists one radar, at any radius, with its presets", () => {
        const radar = (overrides: Record<string, unknown>) =>
            checkGame(game(overrides)).questions.find((q) => q.kind === "radar")
                ?.label;
        expect(radar({ radars: [500, 2000, 500] })).toBe(
            "any radius (presets 500 m, 2 km)",
        );
        expect(radar({ radars: true, unit: "kilometers" })).toBe(
            "any radius (starts at 400 km)",
        );
        expect(radar({ radars: false })).toBeUndefined();
    });

    it("words the radar like the app's Questions offered list", () => {
        for (const overrides of [
            { radars: [400, 600] },
            { radars: [1000] },
            { radars: true, unit: "miles" },
        ]) {
            const def = game(overrides);
            const app = compileGameDefinition(
                def as unknown as GameDefinition,
            ).questionMap.get("radius")?.label;
            const label = checkGame(def).questions.find(
                (q) => q.kind === "radar",
            )?.label;
            expect(app).toBe(`Radar: ${label}`);
        }
    });

    it("rejects out-of-range bounds like the server", () => {
        const def = game();
        def.map.bounds = [-190, 49.9, 11.1, 51.1];
        expect(checkGame(def).errors.map((e) => e.path)).toEqual([
            "/map/bounds",
        ]);
    });

    it("flags undecoded names in zones, layers and features", () => {
        const def = game();
        def.hidingZones.features.features[0].properties.name =
            "<![CDATA[Gare d'Est]]>";
        def.features[0].data.features[0].properties.name = "Art &amp; Craft";
        def.features[0].name = "Mus&#233;e";
        const escaped = checkGame(def).warnings.filter(
            (w) => w.code === "escaped-name",
        );
        expect(escaped.map((w) => w.path)).toEqual([
            "/hidingZones/features",
            '/features/0 "Mus&#233;e"',
            '/features/0 "Mus&#233;e"',
        ]);
    });

    it("flags feature ids repeated within a layer", () => {
        const def = game();
        def.features[0].data.features[1].id = "a";
        expect(codes(checkGame(def))).toContain("duplicate-feature-id");
    });

    it("flags region layers that no hiding zone lies in", () => {
        const def = game({
            features: [
                {
                    name: "Lake",
                    enabledFor: ["matching", "measuring"],
                    data: collection([
                        region("east", 10.6, 50.4, 10.7, 50.6),
                        region("west", 10.3, 50.4, 10.4, 50.6),
                    ]),
                },
            ],
        });
        expect(codes(checkGame(def))).toContain("zones-outside-all-regions");
    });

    it("explains numeric tiers and accepts {value, unit} radii", () => {
        const def = game();
        def.hidingZones = {
            ...def.hidingZones,
            tierOverrides: { "1": 600 },
            features: collection([
                point("north", 10.5, 50.8, { tier: 1 }),
                point("south", 10.5, 50.2, {
                    radius: { value: 1, unit: "kilometers" },
                }),
            ]),
        } as typeof def.hidingZones;
        const result = checkGame(def);
        expect(result.warnings.map((w) => w.code)).toEqual(["tier-not-string"]);
        expect(result.warnings[0].message).toContain("tiers must be strings");
    });

    it("notes plural layer names and single-site tentacles", () => {
        const def = game({
            features: [
                {
                    name: "Districts",
                    enabledFor: ["matching"],
                    data: collection([
                        region("north", 10, 50.5, 11, 51),
                        region("south", 10, 50, 11, 50.5),
                    ]),
                },
                {
                    name: "Zoo",
                    enabledFor: ["measuring", "tentacle"],
                    data: collection([point("zoo", 10.5, 50.5)]),
                },
            ],
        });
        const result = checkGame(def);
        expect(result.warnings.map((w) => w.code)).toEqual([
            "single-feature-tentacle",
        ]);
        expect(result.notes.map((n) => n.code)).toEqual(["plural-layer-name"]);
    });

    it("sizes a game as compact JSON, so indentation doesn't count", () => {
        const MB = 1024 * 1024;
        const sizeIssues = (result: ReturnType<typeof checkGame>) => [
            ...result.errors
                .filter((e) => e.path === "/")
                .map((e) => `error: ${e.message}`),
            ...result.warnings
                .filter((w) =>
                    ["large-file", "formatted-over-limit"].includes(w.code),
                )
                .map((w) => `${w.code}: ${w.message}`),
        ];
        const holding = (bytes: number) => {
            const def = game();
            def.hidingZones.features.features[0] = point("north", 10.5, 50.8, {
                note: "x".repeat(bytes),
            });
            return def;
        };
        // A file indented to 22 MB, holding much less.
        expect(sizeIssues(checkGame(game(), { fileSize: 22 * MB }))).toEqual(
            [],
        );
        expect(sizeIssues(checkGame(holding(11 * MB)))).toEqual([
            "large-file: 11.0 MB as compact JSON; simplify boundaries and drop unused properties (import limit 50 MB)",
        ]);
        // Over the limit even compact: the import refuses it.
        const tooLarge = checkGame(holding(51 * MB), { fileSize: 60 * MB });
        expect(sizeIssues(tooLarge)).toEqual([
            "error: 51.0 MB as compact JSON, over the 50 MB import limit; simplify boundaries and drop unused properties",
        ]);
        // Posted to the API as is, the indentation counts toward its limit.
        expect(sizeIssues(checkGame(game(), { fileSize: 60 * MB }))).toEqual([
            "formatted-over-limit: 60.0 MB as formatted, over the API's 50 MB import limit; post it without indentation (the import page does)",
        ]);
        expect(
            sizeIssues(checkGame(holding(11 * MB), { fileSize: 60 * MB })).map(
                (i) => i.split(":")[0],
            ),
        ).toEqual(["large-file", "formatted-over-limit"]);
    });

    it("counts a game's size in UTF-8 bytes", () => {
        const MB = 1024 * 1024;
        // 5.25M characters, but 11 MB: "é" is 2 bytes, "😀" (a surrogate
        // pair) 4.
        const def = game();
        def.hidingZones.features.features[0] = point("north", 10.5, 50.8, {
            note: "é".repeat(5 * MB) + "😀".repeat(MB / 4),
        });
        const [warning] = checkGame(def).warnings.filter(
            (w) => w.code === "large-file",
        );
        const bytes = new TextEncoder().encode(JSON.stringify(def)).length;
        expect(warning.message).toMatch(
            new RegExp(`^${(bytes / MB).toFixed(1)} MB as compact JSON`),
        );
        expect(bytes / MB).toBeGreaterThan(11);
    });

    it("marks only always-defective warnings as strict", () => {
        const def = game();
        def.map.center = [50.5, 10.5];
        def.features[0].enabledFor = ["matching"];
        def.features[0].data.features.pop();
        const strict = checkGame(def)
            .warnings.filter((w) => STRICT_CODES.has(w.code))
            .map((w) => w.code);
        expect(strict).toEqual([
            "center-outside-play-area",
            "single-feature-matching",
        ]);
    });

    describe("noOverlaps", () => {
        // Two regions side by side; `reach` pushes the first into the second.
        const regions = (reach = 0) =>
            collection([
                region("west", 10, 50, 10.5 + reach, 51),
                region("east", 10.5, 50, 11, 51),
            ]);
        const layer = (noOverlaps: unknown, data = regions()) =>
            game({
                features: [
                    {
                        name: "District",
                        enabledFor: ["matching", "measuring"],
                        noOverlaps,
                        data,
                    },
                ],
            });

        it("must be a boolean", () => {
            expect(checkGame(layer("yes")).errors.map((e) => e.path)).toEqual([
                "/features/0/noOverlaps",
            ]);
        });

        it("passes regions that only share a border", () => {
            const result = checkGame(layer(true));
            expect(result.errors).toEqual([]);
            expect(codes(result)).not.toContain("no-overlaps-overlapping");
        });

        it("fails a marked layer whose regions reach into each other", () => {
            // About 70 m: the west region's eastern corners lie in the east.
            const result = checkGame(layer(true, regions(0.001)));
            const failing = result.warnings.filter((w) =>
                STRICT_CODES.has(w.code),
            );
            expect(failing.map((w) => w.code)).toEqual([
                "no-overlaps-overlapping",
            ]);
            expect(failing[0].message).toMatch(/"west" reaches into "east"/);
        });

        it("ignores hairline overlaps", () => {
            // About 7 cm.
            expect(
                codes(checkGame(layer(true, regions(0.000001)))),
            ).not.toContain("no-overlaps-overlapping");
        });

        it("warns when set on a layer of points", () => {
            const def = game();
            def.features[0] = { ...def.features[0], noOverlaps: true } as never;
            expect(codes(checkGame(def))).toContain("no-overlaps-not-regions");
        });
    });

    describe("heavy geometry", () => {
        it("doesn't count every region of a layer only matched on", () => {
            // 30,000 vertices, but matching clips to one region at a time.
            const regions = Array.from({ length: 30 }, (_, i) =>
                round(
                    `r${i}`,
                    10 + (i % 6) * 0.15,
                    50.1 + Math.floor(i / 6) * 0.15,
                    0.05,
                    1000,
                ),
            );
            expect(heavyIssues(heavy(["matching"], regions))).toEqual({
                warnings: [],
                notes: [],
            });
        });

        it("suggests simplifying a densely traced layer measured to", () => {
            // Vertices about 2 m apart.
            const { warnings, notes } = heavyIssues(
                heavy(
                    ["matching", "measuring"],
                    [
                        round("a", 10.3, 50.5, 0.05, 12000),
                        round("b", 10.7, 50.5, 0.05, 12000),
                    ],
                ),
            );
            expect(notes).toEqual([]);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].message).toMatch(/24002 vertices/);
            expect(warnings[0].message).toMatch(/topology-preserving/);
        });

        it("only notes a heavy layer whose vertices are already far apart", () => {
            // Vertices about 230 m apart.
            const { warnings, notes } = heavyIssues(
                heavy(
                    ["measuring"],
                    [
                        round("a", 10.3, 50.5, 4, 12000),
                        round("b", 10.7, 50.5, 4, 12000),
                    ],
                ),
            );
            expect(warnings).toEqual([]);
            expect(notes).toHaveLength(1);
            expect(notes[0].message).toMatch(/simplifying would remove little/);
        });

        it("names a densely traced region too heavy to match on", () => {
            const { warnings } = heavyIssues(
                heavy(
                    ["matching"],
                    [
                        round("big", 10.3, 50.5, 0.1, 21000),
                        round("small", 10.7, 50.5, 0.1, 100),
                    ],
                ),
            );
            expect(warnings).toHaveLength(1);
            expect(warnings[0].message).toMatch(
                /region "big" alone has 21001 vertices/,
            );
        });

        it("judges a heavy region by its own vertices' spacing", () => {
            // One dense region (vertices under a meter apart) among coarse
            // ones (about 370 m apart) with more vertices in all.
            const coarse = Array.from({ length: 30 }, (_, i) =>
                round(
                    `c${i}`,
                    -20 + (i % 6) * 2.5,
                    40 + Math.floor(i / 6) * 2.5,
                    1,
                    1500,
                ),
            );
            const { warnings, notes } = heavyIssues(
                heavy(
                    ["matching"],
                    [round("dense", 10.5, 50.5, 0.01, 21000), ...coarse],
                ),
            );
            expect(notes).toEqual([]);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].message).toMatch(/region "dense"/);
        });
    });
});
