import {
    type PlayAreaFeatureCollection,
    validateGameDefinition,
} from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";
import { checkGameQuality } from "@/game-definition/inspect";
import {
    assembleGameDefinition,
    validateCreatorLayers,
} from "@/lib/creator/assemble";
import { buildGameKml, hexToKmlColor } from "@/lib/creator/kml";
import { rectanglePlayArea } from "@/lib/creator/overpass";

describe("assembleGameDefinition", () => {
    const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

    it("produces a valid, compilable, check-game-clean GameDefinition", async () => {
        const def = assembleGameDefinition({
            name: "Zurich Casual",
            size: "medium",
            unit: "meters",
            hidingRadius: 400,
            tierOverrides: { Outer: 600, Unused: 900 },
            radars: [250, 400, 800],
            thermometer: true,
            playArea,
            stations: [
                {
                    uid: "1",
                    name: "Central",
                    lng: 8.540123456,
                    lat: 47.377987654,
                    enabled: true,
                },
                {
                    uid: "2",
                    name: "Central",
                    lng: 8.56,
                    lat: 47.39,
                    enabled: true,
                    tier: "Outer",
                },
                {
                    uid: "3",
                    name: "Disabled Stop",
                    lng: 8.52,
                    lat: 47.36,
                    enabled: false,
                },
            ],
            layers: [
                {
                    id: "museum",
                    name: "Museum",
                    osmFilter: '["tourism"="museum"]',
                    enabledFor: ["matching", "measuring", "tentacle"],
                    color: "#e11d48",
                    selected: true,
                    notableOnly: false,
                    fetched: true,
                    items: [
                        {
                            uid: "m1",
                            name: "Art & Craft",
                            lng: 8.545,
                            lat: 47.37,
                            enabled: true,
                        },
                        {
                            uid: "m2",
                            name: "Science Hall",
                            lng: 8.555,
                            lat: 47.38,
                            enabled: true,
                        },
                        {
                            uid: "m3",
                            name: "Excluded Museum",
                            lng: 8.53,
                            lat: 47.36,
                            enabled: false,
                        },
                    ],
                },
            ],
        });

        expect(validateGameDefinition(def)).toEqual({
            valid: true,
            errors: [],
            warnings: [],
        });
        const compiled = compileGameDefinition(def);
        expect(compiled.hidingZones.features.features).toHaveLength(2);
        expect(def.hidingZones.features.features.map((f) => f.id)).toEqual([
            "central",
            "central-2",
        ]);
        // Only referenced tiers are emitted.
        expect(def.hidingZones.tierOverrides).toEqual({ Outer: 600 });
        expect(def.features?.[0].data.features).toHaveLength(2);

        const issues = await checkGameQuality(def);
        expect(issues.filter((i) => i.level === "error" || i.strict)).toEqual(
            [],
        );
    });

    it("flags empty-slug and colliding question IDs while allowing distinct question kinds", () => {
        const errors = validateCreatorLayers([
            { name: "博物館", selected: true, enabledFor: ["matching"] },
            { name: "Cafe", selected: true, enabledFor: ["matching"] },
            { name: "Café", selected: true, enabledFor: ["matching"] },
            { name: "博物館", selected: false, enabledFor: ["matching"] }, // unselected layers ignored
        ]);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toContain("ASCII");
        expect(errors[1]).toContain("collides");

        // Distinct question kinds with the same slug are valid in Searchlight.
        expect(
            validateCreatorLayers([
                { name: "Café", selected: true, enabledFor: ["matching"] },
                { name: "Cafe", selected: true, enabledFor: ["measuring"] },
            ]),
        ).toEqual([]);
    });

    it("preserves serverId, visibility, polygon hiding zones, and per-zone properties on round-trip", () => {
        const def = assembleGameDefinition({
            name: "Gated Game",
            id: "gated-game",
            size: "small",
            unit: "meters",
            hidingRadius: 400,
            tierOverrides: { "1": 900 },
            radars: true,
            thermometer: true,
            playArea,
            preservedMetadata: {
                serverId: "server-123",
                visibility: {
                    kind: "discord-role",
                    guildId: "123456789012345678",
                    roleId: "987654321098765432",
                },
            },
            stations: [
                // Newly added station prepended at index 0 whose slug collides with both
                // the loaded point zone ("permanent") and polygon zone ("poly-zone").
                {
                    uid: "st-new-1",
                    name: "Permanent",
                    lng: 8.545,
                    lat: 47.375,
                    tier: "DisplayOnly",
                    enabled: true,
                },
                {
                    uid: "st-new-2",
                    name: "Poly Zone",
                    lng: 8.546,
                    lat: 47.376,
                    enabled: true,
                },
                {
                    uid: "st-1",
                    name: "Gare",
                    lng: 8.54,
                    lat: 47.37,
                    tier: "1",
                    enabled: true,
                    originalId: "permanent",
                    originalProperties: {
                        name: "Gare",
                        tier: 1,
                        radius: 900,
                    },
                },
            ],
            extraHidingZones: [
                {
                    type: "Feature",
                    id: "poly-zone",
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            [
                                [8.51, 47.36],
                                [8.52, 47.36],
                                [8.52, 47.37],
                                [8.51, 47.37],
                                [8.51, 47.36],
                            ],
                        ],
                    },
                    properties: { name: "Polygon Zone" },
                },
            ],
            layers: [],
            geometryLayers: [
                {
                    id: "g-1",
                    name: "Library",
                    family: "points",
                    enabledFor: ["matching"],
                    color: "#2563eb",
                    selected: true,
                    sourceLabel: "Loaded .game.json",
                    vertexCount: 1,
                    items: [
                        {
                            uid: "f-1",
                            name: "Main",
                            enabled: true,
                            geometry: { type: "Point", coordinates: [8.54, 47.37] },
                            originalId: 91,
                            originalProperties: { name: "Main", code: "UL" },
                        },
                    ],
                },
            ],
        });

        expect(validateGameDefinition(def).valid).toBe(true);
        expect(def.serverId).toBe("server-123");
        expect(def.visibility).toEqual({
            kind: "discord-role",
            guildId: "123456789012345678",
            roleId: "987654321098765432",
        });
        expect(def.radars).toBe(true);
        expect(def.hidingZones.features.features).toHaveLength(4);
        // Newly added stops must get disambiguated IDs without stealing loaded IDs.
        expect(def.hidingZones.features.features.map((f) => f.id)).toEqual([
            "permanent-2",
            "poly-zone-2",
            "permanent",
            "poly-zone",
        ]);
        // Tier without radius override is preserved on the station; numeric tier & radius stay intact.
        expect(def.hidingZones.features.features[0].properties).toMatchObject({
            tier: "DisplayOnly",
        });
        expect(def.hidingZones.features.features[2].properties).toMatchObject({
            tier: 1,
            radius: 900,
        });
        expect(def.hidingZones.features.features[3].geometry.type).toBe(
            "Polygon",
        );
        // Feature layer original ID and extra properties survive round-trip.
        expect(def.features?.[0].data.features[0]).toMatchObject({
            id: 91,
            properties: { name: "Main", code: "UL" },
        });
        // Numeric tier also serializes to KML ExtendedData.
        const kml = buildGameKml(def);
        expect(kml.kml).toContain('<Data name="tier"><value>1</value></Data>');
    });
});

describe("buildGameKml", () => {
    const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

    it("converts hex colors to KML aabbggrr format", () => {
        expect(hexToKmlColor("#2563eb", "ff")).toBe("ffeb6325");
        expect(hexToKmlColor("#112233", "22")).toBe("22332211");
    });

    it("escapes XML, combines POIs by default, optionally emits zone circles, and warns past 10 layers", () => {
        const manyLayers = Array.from({ length: 10 }, (_, idx) => ({
            id: `l-${idx}`,
            name: `Category ${idx + 1}`,
            osmFilter: '["tourism"="museum"]',
            enabledFor: ["matching" as const, "measuring" as const],
            color: "#e11d48",
            selected: true,
            notableOnly: false,
            fetched: true,
            items: [
                {
                    uid: `p-${idx}-1`,
                    name: `Art & Craft <${idx + 1}>`,
                    lng: 8.54 + idx * 0.002,
                    lat: 47.37,
                    enabled: true,
                },
                {
                    uid: `p-${idx}-2`,
                    name: `Hall ${idx + 1}`,
                    lng: 8.55 + idx * 0.002,
                    lat: 47.38,
                    enabled: true,
                },
            ],
        }));

        const def = assembleGameDefinition({
            name: "Zurich & Friends",
            size: "medium",
            unit: "meters",
            hidingRadius: 400,
            tierOverrides: {},
            radars: [400],
            thermometer: true,
            playArea,
            stations: [
                {
                    uid: "s1",
                    name: "Main <HB>\u000b",
                    lng: 8.54,
                    lat: 47.37,
                    enabled: true,
                },
            ],
            layers: manyLayers,
        });

        // Default My Maps-safe mode combines all 10 POI layers into 1 "POIs" folder.
        const combined = buildGameKml(def, {
            combinePoisForMyMaps: true,
            includeHidingZoneCircles: true,
        });
        expect(combined.folderCount).toBe(4); // Play Area, Stations, Hiding Zone Circles, POIs
        expect(combined.myMapsWarnings).toEqual([]);
        expect(combined.kml).toContain("Zurich &amp; Friends");
        expect(combined.kml).toContain("Main &lt;HB&gt;");
        expect(combined.kml).toContain("Art &amp; Craft &lt;1&gt;");
        expect(combined.kml).toContain("<name>Hiding Zone Circles</name>");

        // Separate folders exceed My Maps' 10-layer limit and emit a warning.
        const split = buildGameKml(def, {
            combinePoisForMyMaps: false,
            includeHidingZoneCircles: false,
        });
        expect(split.folderCount).toBe(12); // Play Area + Stations + 10 layers
        expect(split.myMapsWarnings[0]).toContain("at most 10 layers");
    });

    it("handles __proto__ layer names safely, omits HTML descriptions, and outputs CCW KML outer rings", () => {
        const cwPlayArea: PlayAreaFeatureCollection = {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    geometry: {
                        type: "Polygon",
                        // Intentionally clockwise outer ring
                        coordinates: [
                            [
                                [8.5, 47.35],
                                [8.5, 47.42],
                                [8.6, 47.42],
                                [8.6, 47.35],
                                [8.5, 47.35],
                            ],
                        ],
                    },
                    properties: { name: "CW Area" },
                },
            ],
        };
        const def = assembleGameDefinition({
            name: "Proto Safe",
            size: "small",
            unit: "meters",
            hidingRadius: 400,
            tierOverrides: {},
            radars: false,
            thermometer: false,
            playArea: cwPlayArea,
            stations: [
                { uid: "s1", name: "S1", lng: 8.54, lat: 47.37, enabled: true },
            ],
            layers: [
                {
                    id: "p1",
                    name: "__proto__",
                    osmFilter: '["amenity"="cafe"]',
                    enabledFor: ["matching"],
                    color: "#2563eb",
                    selected: true,
                    notableOnly: false,
                    fetched: true,
                    items: [
                        {
                            uid: "i1",
                            name: "<b>Spot</b>",
                            lng: 8.55,
                            lat: 47.38,
                            enabled: true,
                        },
                    ],
                },
            ],
        });

        const res = buildGameKml(def, {
            combinePoisForMyMaps: true,
            layerColors: {},
        });
        expect(res.kml).not.toContain("<description>");
        expect(res.kml).toContain(
            '<Data name="category"><value>__proto__</value></Data>',
        );
        // First two coordinates in Play Area should now be reversed to CCW: (8.5,47.35) -> (8.6,47.35)
        expect(res.kml).toContain("8.5,47.35,0 8.6,47.35,0 8.6,47.42,0");
    });
});
