import { describe, expect, it } from "vitest";

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
const collection = <T,>(features: T[]) => ({
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

describe("check-game.mjs", () => {
    it("passes a clean game and lists its questions", () => {
        const result = checkGame(game());
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.questions.map((q) => q.label)).toEqual([
            "radii 400",
            "",
            "Nearest Museum",
            "Distance to Museum",
            "Tentacles: Museum",
        ]);
    });

    it("accepts the game's date and rules link, and rejects them like the server", () => {
        const ok = checkGame(
            game({
                date: "2026-10-02",
                endDate: "2026-10-03",
                rulesUrl: "https://docs.google.com/document/d/x/edit",
            }),
        );
        expect(ok.errors).toEqual([]);
        const paths = (overrides: Record<string, unknown>) =>
            checkGame(game(overrides)).errors.map((e) => e.path);
        expect(paths({ date: "2026-02-30" })).toEqual(["/date"]);
        expect(paths({ date: "19-09-2026" })).toEqual(["/date"]);
        expect(paths({ endDate: "2026-10-03" })).toEqual(["/endDate"]);
        expect(paths({ date: "2026-10-03", endDate: "2026-10-02" })).toEqual([
            "/endDate",
        ]);
        expect(paths({ rulesUrl: "http://example.com" })).toEqual([
            "/rulesUrl",
        ]);
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
});
