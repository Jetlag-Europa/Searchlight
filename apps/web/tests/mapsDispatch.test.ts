import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    validateGameDefinition,
    type GameDefinition,
} from "@searchlight/shared";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import * as GeoUtils from "@/maps/geo-utils";
import { evaluateMeasuringOperator } from "@/maps/questions/operators/measuring";
import { hiderMode, mapGeoJSON } from "@/lib/context";
import {
    setActiveGameDefinition,
    compiledGameAtom,
} from "@/game-definition/store";
import {
    resolveCompiledQuestion,
    hiderifyQuestion,
    determinePlanningPolygon,
    adjustMapGeoDataForQuestion,
} from "@/maps";
import {
    matchingQuestionSchema,
    measuringQuestionSchema,
    tentacleQuestionSchema,
} from "@/maps/schema";
import { boundary, gridAgreement, sampleGrid } from "./questions/oracleCommon";

const rotterdamJson: unknown = JSON.parse(
    readFileSync(
        resolve(
            process.cwd(),
            "../../games/preloaded/rotterdam-2026-09.game.json",
        ),
        "utf8",
    ),
);
const rotterdamValidation = validateGameDefinition(rotterdamJson);
if (!rotterdamValidation.valid)
    throw new Error(JSON.stringify(rotterdamValidation.errors));
// The shared validator checks this imported fixture before it enters the runtime.
const rotterdamDefinition = rotterdamJson as GameDefinition;

vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcBuffer: async (
            fc: FeatureCollection<Point>,
            radius: number,
            unit: turf.Units,
        ) => turf.buffer(fc.features[0], radius, { units: unit }),
        arcDistanceToPoint: async (
            features: FeatureCollection,
            lat: number,
            lng: number,
            unit: turf.Units = "miles",
        ) => {
            const origin = turf.point([lng, lat]);
            let nearest = Infinity;
            turf.flattenEach(features, (feature) => {
                nearest = Math.min(
                    nearest,
                    feature.geometry.type === "Point"
                        ? turf.distance(origin, feature as Feature<Point>, {
                              units: unit,
                          })
                        : turf.pointToLineDistance(
                              origin,
                              feature as Feature<LineString>,
                              { units: unit },
                          ),
                );
            });
            return nearest;
        },
    };
});

describe("maps dispatch and hider regression suite", () => {
    const playArea: FeatureCollection<Polygon> = {
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                geometry: {
                    type: "Polygon",
                    coordinates: [
                        [
                            [139.5, 35.5],
                            [140.0, 35.5],
                            [140.0, 36.0],
                            [139.5, 36.0],
                            [139.5, 35.5],
                        ],
                    ],
                },
                properties: {},
            },
        ],
    };

    const multiFeatureGameDef = {
        id: "tokyo-features",
        name: "Tokyo Features",
        serverId: "home-games",
        map: { center: [139.75, 35.68] as [number, number], playArea },
        hidingZones: {
            radius: 400,
            unit: "meters" as const,
            features: { type: "FeatureCollection" as const, features: [] },
        },
        radars: [300, 500],
        thermometer: true,
        features: [
            {
                name: "Shrines",
                enabledFor: ["matching", "measuring", "tentacle"],
                data: turf.featureCollection([
                    turf.point([139.7, 35.65], { name: "Meiji Shrine" }),
                    turf.point([139.72, 35.66], { name: "Nezu Shrine" }),
                ]),
            },
            {
                name: "Duplicates",
                enabledFor: ["matching"],
                data: {
                    type: "FeatureCollection" as const,
                    features: [
                        {
                            type: "Feature" as const,
                            id: "station-west",
                            geometry: {
                                type: "Point" as const,
                                coordinates: [139.6, 35.65],
                            },
                            properties: { name: "Central Station" },
                        },
                        {
                            type: "Feature" as const,
                            id: "station-east",
                            geometry: {
                                type: "Point" as const,
                                coordinates: [139.8, 35.65],
                            },
                            properties: { name: "Central Station" },
                        },
                    ],
                },
            },
            {
                name: "Districts",
                enabledFor: ["measuring"],
                data: {
                    type: "FeatureCollection" as const,
                    features: [
                        {
                            type: "Feature" as const,
                            id: "district-exclave",
                            geometry: {
                                type: "MultiPolygon" as const,
                                coordinates: [
                                    [
                                        [
                                            [139.6, 35.6],
                                            [139.65, 35.6],
                                            [139.65, 35.65],
                                            [139.6, 35.65],
                                            [139.6, 35.6],
                                        ],
                                    ],
                                    [
                                        [
                                            [139.66, 35.6],
                                            [139.7, 35.6],
                                            [139.7, 35.65],
                                            [139.66, 35.65],
                                            [139.66, 35.6],
                                        ],
                                    ],
                                ],
                            },
                            properties: { name: "District Exclave" },
                        },
                    ],
                },
            },
            {
                name: "MultiLine Shore",
                enabledFor: ["measuring"],
                data: {
                    type: "FeatureCollection" as const,
                    features: [
                        {
                            type: "Feature" as const,
                            geometry: {
                                type: "MultiLineString" as const,
                                coordinates: [
                                    [
                                        [139.55, 35.55],
                                        [139.75, 35.55],
                                    ],
                                    [
                                        [139.76, 35.55],
                                        [139.95, 35.55],
                                    ],
                                ],
                            },
                            properties: { name: "Shore" },
                        },
                    ],
                },
            },
        ],
    };

    beforeEach(() => {
        setActiveGameDefinition(multiFeatureGameDef as any);
    });

    afterEach(() => {
        hiderMode.set(false);
        setActiveGameDefinition(null);
    });

    it("resolves only canonical identifiers in their declared family", () => {
        const compiled = compiledGameAtom.get()!;
        expect(
            resolveCompiledQuestion(
                { id: "measuring", data: { type: "measuring-shrines" } },
                compiled,
            )?.id,
        ).toBe("measuring-shrines");
        expect(
            resolveCompiledQuestion(
                { id: "tentacles", data: { locationType: "tentacle-shrines" } },
                compiled,
            )?.id,
        ).toBe("tentacle-shrines");
        expect(
            resolveCompiledQuestion(
                { id: "matching", data: { type: "matching-shrines" } },
                compiled,
            )?.id,
        ).toBe("matching-shrines");
        for (const type of [
            "shrines",
            "Shrines",
            "matching-shrines",
            "milan-municipio",
        ]) {
            expect(
                resolveCompiledQuestion(
                    { id: "measuring", data: { type } },
                    compiled,
                ),
            ).toBeUndefined();
        }
    });

    it("rejects unsupported game questions without fetching fallback data", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            await expect(
                adjustMapGeoDataForQuestion(
                    {
                        id: "matching",
                        data: {
                            type: "milan-municipio",
                            lat: 35.65,
                            lng: 139.7,
                            same: true,
                        },
                    },
                    playArea,
                ),
            ).rejects.toThrow("not supported");
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("routes radius and thermometer to their handlers and planning under compiled game", async () => {
        hiderMode.set({ latitude: 35.65, longitude: 139.7 });

        const radiusQ: any = {
            id: "radius",
            data: {
                lat: 35.6501,
                lng: 139.7001,
                radius: 500,
                unit: "meters",
                drag: true,
            },
        };
        const rResult = await hiderifyQuestion(radiusQ);
        expect(rResult?.id === "radius" && rResult.data.within).toBe(true);

        const rPoly = await determinePlanningPolygon(radiusQ, true);
        expect(rPoly).toBeDefined();

        const thermoQ: any = {
            id: "thermometer",
            data: {
                latA: 35.65,
                lngA: 139.7,
                latB: 35.67,
                lngB: 139.72,
                drag: true,
            },
        };
        const tResult = await hiderifyQuestion(thermoQ);
        expect(
            tResult?.id === "thermometer" &&
                typeof tResult.data.warmer === "boolean",
        ).toBe(true);

        const tPoly = await determinePlanningPolygon(thermoQ, true);
        expect(tPoly).toBeDefined();
    });

    // Player-drawn questions, west and east of the play area's middle.
    const west = turf.point([139.6, 35.65], { name: "West" });
    const east = turf.point([139.9, 35.65], { name: "East" });
    const inside = (region: unknown, lng: number, lat: number) =>
        turf
            .flatten(region as FeatureCollection<Polygon | MultiPolygon>)
            .features.some((feature) =>
                turf.booleanPointInPolygon(turf.point([lng, lat]), feature),
            );
    // ArcGIS's geodesic buffer needs browser WASM: buffer the targets by the
    // seeker's distance to the nearest of them.
    const turfBufferToPoint = async (
        features: FeatureCollection,
        lat: number,
        lng: number,
    ) => {
        const seeker = turf.point([lng, lat]);
        let distance = Infinity;
        turf.featureEach(turf.explode(features), (vertex) => {
            distance = Math.min(distance, turf.distance(seeker, vertex));
        });
        return turf.buffer(features, distance)!.features[0] as Feature<
            Polygon | MultiPolygon
        >;
    };

    it("answers player-drawn custom questions with their own handlers", async () => {
        const customPoints = {
            id: "matching" as const,
            key: 20,
            data: matchingQuestionSchema.parse({
                type: "custom-points",
                geo: [west, east],
                lat: 35.65,
                lng: 139.62,
                same: true,
                drag: true,
            }),
        };
        const matched = await adjustMapGeoDataForQuestion(
            customPoints,
            playArea,
        );
        expect(inside(matched, 139.65, 35.7)).toBe(true);
        expect(inside(matched, 139.85, 35.7)).toBe(false);

        const customZone = {
            id: "matching" as const,
            key: 21,
            data: matchingQuestionSchema.parse({
                type: "custom-zone",
                geo: turf.bboxPolygon([139.5, 35.5, 139.75, 36.0]),
                lat: 35.65,
                lng: 139.62,
                same: false,
                drag: true,
            }),
        };
        const zoned = await adjustMapGeoDataForQuestion(customZone, playArea);
        expect(inside(zoned, 139.6, 35.7)).toBe(false);
        expect(inside(zoned, 139.9, 35.7)).toBe(true);

        const customTentacle = {
            id: "tentacles" as const,
            key: 22,
            data: tentacleQuestionSchema.parse({
                locationType: "custom",
                places: [west, east],
                location: west,
                radius: 30,
                unit: "kilometers",
                lat: 35.65,
                lng: 139.62,
                drag: true,
            }),
        };
        const tentacled = await adjustMapGeoDataForQuestion(
            customTentacle,
            playArea,
        );
        expect(inside(tentacled, 139.58, 35.65)).toBe(true);
        expect(inside(tentacled, 139.85, 35.65)).toBe(false);

        const customMeasure = {
            id: "measuring" as const,
            key: 23,
            data: measuringQuestionSchema.parse({
                type: "custom-measure",
                geo: turf.featureCollection([west]),
                lat: 35.65,
                lng: 139.62,
                hiderCloser: true,
                drag: true,
            }),
        };
        const bufferSpy = vi
            .spyOn(GeoUtils, "arcBufferToPoint")
            .mockImplementation(turfBufferToPoint);
        try {
            const measured = await adjustMapGeoDataForQuestion(
                customMeasure,
                playArea,
            );
            expect(inside(measured, 139.6, 35.655)).toBe(true);
            expect(inside(measured, 139.65, 35.65)).toBe(false);
        } finally {
            bufferSpy.mockRestore();
        }

        // Planning mode draws the unanswered questions' outlines.
        for (const question of [customZone, customTentacle]) {
            const outline = (await determinePlanningPolygon(question, true)) as
                | Feature
                | FeatureCollection;
            expect(
                turf.flatten(outline as never).features.length,
            ).toBeGreaterThan(0);
        }

        // The hider is nearest the other point.
        mapGeoJSON.set(playArea);
        hiderMode.set({ latitude: 35.65, longitude: 139.95 });
        try {
            await hiderifyQuestion(customPoints);
            expect(customPoints.data.same).toBe(false);
        } finally {
            mapGeoJSON.set(null);
        }
    });

    it("eliminates nothing for custom questions with nothing drawn yet", async () => {
        // As Add Question creates them: no geometry at all.
        const blank = [
            {
                id: "matching" as const,
                key: 30,
                data: matchingQuestionSchema.parse({
                    type: "custom-zone",
                    lat: 35.65,
                    lng: 139.62,
                }),
            },
            {
                id: "matching" as const,
                key: 31,
                data: matchingQuestionSchema.parse({
                    type: "custom-points",
                    lat: 35.65,
                    lng: 139.62,
                }),
            },
            {
                id: "matching" as const,
                key: 32,
                data: matchingQuestionSchema.parse({
                    type: "custom-zone",
                    geo: turf.featureCollection([]),
                    lat: 35.65,
                    lng: 139.62,
                }),
            },
            {
                id: "measuring" as const,
                key: 33,
                data: measuringQuestionSchema.parse({
                    type: "custom-measure",
                    lat: 35.65,
                    lng: 139.62,
                }),
            },
            {
                id: "tentacles" as const,
                key: 34,
                data: tentacleQuestionSchema.parse({
                    locationType: "custom",
                    places: [],
                    location: west,
                    lat: 35.65,
                    lng: 139.62,
                }),
            },
        ];
        // Within the tentacle's radius: nothing to answer with.
        mapGeoJSON.set(playArea);
        hiderMode.set({ latitude: 35.66, longitude: 139.63 });
        try {
            for (const question of blank) {
                expect(
                    await adjustMapGeoDataForQuestion(question, playArea),
                ).toBe(playArea);
                if (question.id !== "tentacles") {
                    expect(
                        await determinePlanningPolygon(question as never, true),
                    ).toBeFalsy();
                }
                const before = JSON.stringify(question.data);
                await hiderifyQuestion(question as never);
                expect(JSON.stringify(question.data)).toBe(before);
            }

            // A blank custom tentacle, as "Add Tentacles" makes one, is
            // answered "Not Within": it removes the seeker's circle.
            const blankTentacle = {
                id: "tentacles" as const,
                key: 35,
                data: tentacleQuestionSchema.parse({
                    locationType: "custom",
                    places: [],
                    radius: 10,
                    unit: "kilometers",
                    lat: 35.65,
                    lng: 139.62,
                }),
            };
            expect(blankTentacle.data.location).toBe(false);
            const region = await adjustMapGeoDataForQuestion(
                blankTentacle,
                playArea,
            );
            expect(inside(region, 139.62, 35.65)).toBe(false);
            expect(inside(region, 139.9, 35.9)).toBe(true);
            await hiderifyQuestion(blankTentacle);
            expect(blankTentacle.data.location).toBe(false);
        } finally {
            mapGeoJSON.set(null);
        }
    });

    it("tentacle hider produces Feature<Point> and parses schema (or false if out of range)", async () => {
        hiderMode.set({ latitude: 35.651, longitude: 139.701 });

        const tentacleQ: any = {
            id: "tentacles",
            data: {
                lat: 35.65,
                lng: 139.7,
                radius: 15,
                unit: "miles",
                locationType: "tentacle-shrines",
                drag: true,
            },
        };

        const inRange = await hiderifyQuestion(tentacleQ);
        expect(
            inRange?.id === "tentacles" &&
                inRange.data.location &&
                inRange.data.location.type,
        ).toBe("Feature");
        expect(
            inRange?.id === "tentacles" &&
                inRange.data.location &&
                inRange.data.location.geometry.type,
        ).toBe("Point");
        expect(tentacleQuestionSchema.safeParse(inRange?.data).success).toBe(
            true,
        );

        hiderMode.set({ latitude: 37.0, longitude: 141.0 });
        const outOfRange = await hiderifyQuestion(tentacleQ);
        expect(outOfRange?.id === "tentacles" && outOfRange.data.location).toBe(
            false,
        );
        expect(tentacleQuestionSchema.safeParse(outOfRange?.data).success).toBe(
            true,
        );
    });

    it("matching hider compares point identity by coordinate/id, not duplicate display name", async () => {
        hiderMode.set({ latitude: 35.65, longitude: 139.8 }); // At east station

        const matchingQ: any = {
            id: "matching",
            data: {
                lat: 35.65,
                lng: 139.6,
                type: "matching-duplicates",
                drag: true,
            }, // At west station
        };
        await hiderifyQuestion(matchingQ);
        expect(matchingQ.data.same).toBe(false); // Different points despite same name

        hiderMode.set({ latitude: 35.6501, longitude: 139.6001 });
        await hiderifyQuestion(matchingQ);
        expect(matchingQ.data.same).toBe(true);
    });

    it("measuring boundary distances flatten MultiPolygon and MultiLineString without mutating datasets", async () => {
        const compiled = compiledGameAtom.get()!;
        const dataset = (questionId: string) =>
            compiled.datasets[
                compiled.questionMap.get(questionId)!.evaluator.source!
                    .datasetId!
            ];
        const dsDistrictBefore = JSON.stringify(
            dataset("measuring-districts"),
        );
        const dsShoreBefore = JSON.stringify(
            dataset("measuring-multiline-shore"),
        );

        hiderMode.set({ latitude: 35.62, longitude: 139.68 });
        const exclaveQ: any = {
            id: "measuring",
            data: {
                lat: 35.62,
                lng: 139.62,
                type: "measuring-districts",
                drag: true,
            },
        };
        await hiderifyQuestion(exclaveQ);
        expect(typeof exclaveQ.data.hiderCloser).toBe("boolean");
        expect(JSON.stringify(dataset("measuring-districts"))).toBe(
            dsDistrictBefore,
        );

        hiderMode.set({ latitude: 35.56, longitude: 139.85 });
        const shoreQ: any = {
            id: "measuring",
            data: {
                lat: 35.6,
                lng: 139.65,
                type: "measuring-multiline-shore",
                drag: true,
            },
        };
        await hiderifyQuestion(shoreQ);
        expect(shoreQ.data.hiderCloser).toBe(true);
        expect(JSON.stringify(dataset("measuring-multiline-shore"))).toBe(
            dsShoreBefore,
        );
    });

    it("loads every shipped Rotterdam hiding zone with decoded display names", () => {
        setActiveGameDefinition(rotterdamDefinition);
        const compiled = compiledGameAtom.get()!;
        // Upstream prose says 206, but its authoritative KML contains 155 points.
        expect(compiled.hidingZones.stations).toHaveLength(155);
        expect(
            compiled.hidingZones.stations?.map((station) => station.name),
        ).toContain("'s-Gravelandseweg");
        for (const station of compiled.hidingZones.stations!) {
            expect(
                compiled.hidingZones.getRadius(station.id, station.tier),
            ).toEqual({
                value: 300,
                unit: "meters",
            });
        }
    });

    it("answers NS station matching and measuring independently of the hiding-zone stops", async () => {
        setActiveGameDefinition(rotterdamDefinition);
        const matchingQ = {
            id: "matching" as const,
            key: 0,
            data: matchingQuestionSchema.parse({
                lat: 51.927,
                lng: 4.47,
                type: "matching-ns-station",
                drag: true,
            }),
        };
        const measuringQ = {
            id: "measuring" as const,
            key: 1,
            data: measuringQuestionSchema.parse({
                lat: 51.927,
                lng: 4.47,
                type: "measuring-ns-station",
                drag: true,
            }),
        };

        // Both players' nearest NS station is Centraal; the hider is almost on it.
        hiderMode.set({ latitude: 51.925157, longitude: 4.469329 });
        await hiderifyQuestion(matchingQ);
        await hiderifyQuestion(measuringQ);
        expect(matchingQ.data.same).toBe(true);
        expect(measuringQ.data.hiderCloser).toBe(true);

        // A different nearest NS station can still be closer than the seeker's.
        hiderMode.set({ latitude: 51.922035, longitude: 4.408743 }); // Schiedam Centrum
        await hiderifyQuestion(matchingQ);
        await hiderifyQuestion(measuringQ);
        expect(matchingQ.data.same).toBe(false);
        expect(measuringQ.data.hiderCloser).toBe(true);

        hiderMode.set({ latitude: 51.925, longitude: 4.475 });
        await hiderifyQuestion(measuringQ);
        expect(measuringQ.data.hiderCloser).toBe(false);
    });

    it("filters Rotterdam by every municipality boundary, not only the seeker's municipality", async () => {
        setActiveGameDefinition(rotterdamDefinition);
        const lines = turf.flatten(
            rotterdamDefinition.features!.find(
                (feature) => feature.name === "Municipality Boundary",
            )!.data as FeatureCollection<LineString | MultiLineString>,
        ) as FeatureCollection<LineString>;
        const nearestDistance = (point: Feature<Point>) =>
            Math.min(
                ...lines.features.map((line) =>
                    turf.pointToLineDistance(point, line, {
                        units: "kilometers",
                    }),
                ),
            );
        const seeker = turf.point([4.58, 51.93]); // Capelle aan den IJssel
        const seekerDistance = nearestDistance(seeker);
        // A collapsed source arc yields NaN and silently poisons every distance.
        for (const line of lines.features) {
            expect(
                Number.isFinite(turf.pointToLineDistance(seeker, line)),
            ).toBe(true);
        }
        const base = boundary(4.49, 51.88, 4.67, 51.98);
        const points = sampleGrid(base, 14);
        const municipalities = rotterdamDefinition.features!.find(
            (feature) => feature.name === "Municipality",
        )!.data as FeatureCollection<Polygon>;
        const capelle = municipalities.features.find(
            (feature) => feature.properties?.name === "Capelle aan den IJssel",
        )!;
        const ownBoundary = turf.polygonToLine(capelle) as Feature<LineString>;
        const ownDistance = turf.pointToLineDistance(seeker, ownBoundary, {
            units: "kilometers",
        });
        // This scenario must distinguish all-border and seeker-scoped filtering.
        expect(
            points.filter(
                (point) =>
                    nearestDistance(point) <= seekerDistance !==
                    turf.pointToLineDistance(point, ownBoundary, {
                        units: "kilometers",
                    }) <=
                        ownDistance,
            ).length,
        ).toBeGreaterThan(50);

        // ArcGIS geodesic buffers require browser WASM. Use actual segment
        // distances here, not distance to vertices (wrong for long border arcs).
        const bufferSpy = vi
            .spyOn(GeoUtils, "arcBufferToPoint")
            .mockImplementation(async (features, lat, lng) => {
                const origin = turf.point([lng, lat]);
                let distance = Infinity;
                turf.flattenEach(features, (feature) => {
                    distance = Math.min(
                        distance,
                        turf.pointToLineDistance(
                            origin,
                            feature as Feature<LineString>,
                            { units: "kilometers" },
                        ),
                    );
                });
                return turf.buffer(
                    turf.multiLineString(
                        (features.features as Feature<LineString>[]).map(
                            (line) => line.geometry.coordinates,
                        ),
                    ),
                    distance,
                    { units: "kilometers" },
                )!;
            });
        try {
            for (const hiderCloser of [true, false]) {
                const compiled = compiledGameAtom.get()!;
                const mask = await evaluateMeasuringOperator({
                    evaluator: compiled.questionMap.get(
                        "measuring-municipality-boundary",
                    )!.evaluator,
                    datasets: compiled.datasets,
                    data: { lat: 51.93, lng: 4.58, hiderCloser },
                    mapGeoData: turf.featureCollection([base]),
                });
                // The measuring operator returns polygonal GeoJSON even when its shared input type is broad.
                const region =
                    mask && mask.type === "FeatureCollection"
                        ? GeoUtils.safeUnion(
                              mask as FeatureCollection<Polygon | MultiPolygon>,
                          )
                        : (mask ?? null);
                const result = gridAgreement(region, points, (point) => {
                    const distance = nearestDistance(point);
                    if (
                        Math.abs(distance - seekerDistance) <=
                        seekerDistance * 0.08
                    )
                        return "ambiguous";
                    return distance <= seekerDistance === hiderCloser
                        ? "survives"
                        : "eliminated";
                });
                expect(result.failures).toEqual([]);
                expect(result.survives).toBeGreaterThan(10);
                expect(result.eliminated).toBeGreaterThan(10);
            }
        } finally {
            bufferSpy.mockRestore();
        }
    }, 120_000);
});
