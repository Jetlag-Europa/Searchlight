import * as turf from "@turf/turf";
import {
    validateGameDefinition,
    type GameDefinition,
} from "@searchlight/shared";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GeoUtils from "@/maps/geo-utils";
import type * as Voronoi from "@/maps/geo-utils/voronoi";

// Spy where both the main thread and the geometry worker's line partition
// import the tessellation from.
vi.mock("@/maps/geo-utils/voronoi", async (importActual) => {
    const actual = await importActual<typeof Voronoi>();
    return {
        ...actual,
        geoSpatialVoronoiSafe: vi.fn(actual.geoSpatialVoronoiSafe),
    };
});

vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcDistanceToPoint: vi.fn(
            async (
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
        ),
        // ArcGIS uses browser WASM. Keep actual segment distances and buffering in
        // this integration test, rather than replacing the constraint with a box.
        arcBufferToPoint: vi.fn(
            async (features: FeatureCollection, lat: number, lng: number) => {
                const origin = turf.point([lng, lat]);
                let distance = Infinity;
                turf.flattenEach(features, (feature) => {
                    distance = Math.min(
                        distance,
                        feature.geometry.type === "Point"
                            ? turf.distance(origin, feature as Feature<Point>)
                            : turf.pointToLineDistance(
                                  origin,
                                  feature as Feature<LineString>,
                              ),
                    );
                });
                const buffered = turf.buffer(features, distance, {
                    units: "kilometers",
                });
                if (!buffered) throw new Error("No test buffer");
                return actual.safeUnion(buffered);
            },
        ),
        arcBuffer: vi.fn(
            async (
                features: FeatureCollection,
                distance: number,
                unit = "miles",
            ) => {
                const buffered = turf.buffer(features, distance, {
                    units: unit as turf.Units,
                });
                if (!buffered) throw new Error("No test buffer");
                return actual.safeUnion(buffered);
            },
        ),
    };
});

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { hiderMode, mapGeoJSON, showAllMatchingCells } from "@/lib/context";
import {
    adjustMapGeoDataForQuestion,
    applyQuestionsToMapGeoData,
    determinePlanningPolygon,
    hiderifyQuestion,
} from "@/maps";
import {
    arcBufferToPoint,
    arcDistanceToPoint,
    geoSpatialVoronoiSafe,
} from "@/maps/geo-utils";
import {
    matchingQuestionSchema,
    measuringQuestionSchema,
    tentacleQuestionSchema,
} from "@/maps/schema";
import { PLANNING_CONTEXT } from "@/maps/questions/operators/geometry";
import { evaluateTentacleOperator } from "@/maps/questions/operators/tentacle";

const playArea = turf.featureCollection([
    turf.bboxPolygon([-0.08, -0.08, 0.08, 0.08]),
]);
const sites = turf.featureCollection([
    turf.point([-0.04, 0], { name: "West" }, { id: "west" }),
    turf.point([0.04, 0], { name: "East" }, { id: "east" }),
    turf.point([0, 0.04], { name: "North" }, { id: "north" }),
]);
const fixture = {
    id: "compiled-geometry",
    name: "Compiled Geometry",
    serverId: "home-games",
    hidingZones: {
        radius: 400,
        unit: "meters",
        features: turf.featureCollection([]),
    },
    map: { center: [0, 0], playArea },
    features: [
        {
            name: "Sites",
            enabledFor: ["matching", "measuring", "tentacle"],
            data: sites,
        },
        {
            name: "Rails",
            enabledFor: ["matching", "measuring"],
            data: turf.featureCollection([
                turf.multiLineString([
                    [
                        [-0.02, -0.04],
                        [-0.02, 0.04],
                    ],
                    [
                        [0.02, -0.04],
                        [0.02, 0.04],
                    ],
                ]),
                turf.multiLineString([
                    [
                        [0, -0.04],
                        [0, 0.04],
                    ],
                ]),
            ]),
        },
        {
            name: "Districts",
            enabledFor: ["matching", "measuring"],
            data: turf.featureCollection([
                turf.multiPolygon([
                    turf.bboxPolygon([-0.06, -0.04, -0.03, 0.04]).geometry
                        .coordinates,
                    turf.bboxPolygon([0.03, -0.04, 0.06, 0.04]).geometry
                        .coordinates,
                ]),
                turf.multiPolygon([
                    turf.bboxPolygon([-0.01, -0.04, 0.01, 0.04]).geometry
                        .coordinates,
                ]),
            ]),
        },
    ],
};
const validation = validateGameDefinition(fixture);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
// Validated Turf fixtures use GeoJSON's wider coordinate-array types.
const definition = fixture as unknown as GameDefinition;

function expectLineAt(
    preview: Feature | FeatureCollection | null | undefined | false,
    position: [number, number],
) {
    expect(preview).toBeTruthy();
    const lines = turf.flatten(preview as Feature | FeatureCollection);
    expect(
        lines.features.every(
            (feature) => feature.geometry.type === "LineString",
        ),
    ).toBe(true);
    const distance = Math.min(
        ...lines.features.map((line) =>
            turf.pointToLineDistance(
                turf.point(position),
                line as Feature<LineString>,
                { method: "planar" },
            ),
        ),
    );
    expect(distance).toBeLessThan(0.02);
}

beforeEach(() => {
    vi.clearAllMocks();
    setActiveGameDefinition(structuredClone(definition));
});
afterEach(() => setActiveGameDefinition(null));

describe("compiled planning and evaluation geometry", () => {
    it("previews point matching boundaries and reuses tessellation when answers or remaining area change", async () => {
        const question = {
            id: "matching" as const,
            key: 1,
            data: matchingQuestionSchema.parse({
                type: "matching-sites",
                lat: 0,
                lng: -0.04,
                drag: true,
                same: true,
            }),
        };
        const preview = await determinePlanningPolygon(question, true);
        expectLineAt(preview, [0, -0.02]);
        const same = await adjustMapGeoDataForQuestion(question, playArea);
        expect(turf.booleanPointInPolygon(sites.features[0], same)).toBe(true);
        expect(turf.booleanPointInPolygon(sites.features[1], same)).toBe(false);
        question.data.same = false;
        const different = await adjustMapGeoDataForQuestion(
            question,
            turf.featureCollection([
                turf.bboxPolygon([-0.06, -0.03, 0.06, 0.03]),
            ]),
        );
        expect(turf.booleanPointInPolygon(sites.features[0], different)).toBe(
            false,
        );
        expect(turf.booleanPointInPolygon(sites.features[1], different)).toBe(
            true,
        );
        expect(geoSpatialVoronoiSafe).toHaveBeenCalledTimes(1);
    });

    it("previews line matching and treats separate parts of one MultiLineString as one answer", async () => {
        const question = {
            id: "matching" as const,
            key: 2,
            data: matchingQuestionSchema.parse({
                type: "matching-rails",
                lat: 0,
                lng: -0.019,
                drag: true,
                same: true,
            }),
        };
        const preview = await determinePlanningPolygon(question, true);
        expectLineAt(preview, [-0.01, 0]);
        const result = await adjustMapGeoDataForQuestion(question, playArea);
        expect(
            turf.booleanPointInPolygon(turf.point([-0.019, 0]), result),
        ).toBe(true);
        expect(turf.booleanPointInPolygon(turf.point([0.019, 0]), result)).toBe(
            true,
        );
        expect(turf.booleanPointInPolygon(turf.point([0, 0]), result)).toBe(
            false,
        );
        expect(geoSpatialVoronoiSafe).toHaveBeenCalledTimes(1);
    });

    it("previews all parts of a containing polygon, and outside all regions remains a matching category", async () => {
        const question = {
            id: "matching" as const,
            key: 3,
            data: matchingQuestionSchema.parse({
                type: "matching-districts",
                lat: 0,
                lng: -0.04,
                drag: true,
                same: true,
            }),
        };
        const preview = await determinePlanningPolygon(question, true);
        expectLineAt(preview, [-0.03, 0]);
        expectLineAt(preview, [0.03, 0]);
        const same = await adjustMapGeoDataForQuestion(question, playArea);
        expect(turf.booleanPointInPolygon(turf.point([0.04, 0]), same)).toBe(
            true,
        );
        expect(turf.booleanPointInPolygon(turf.point([0, 0]), same)).toBe(
            false,
        );
        question.data.lng = 0.07;
        const outside = await adjustMapGeoDataForQuestion(question, playArea);
        expect(turf.booleanPointInPolygon(turf.point([0.07, 0]), outside)).toBe(
            true,
        );
        expect(turf.booleanPointInPolygon(turf.point([0.04, 0]), outside)).toBe(
            false,
        );
        question.data.same = false;
        const inside = await adjustMapGeoDataForQuestion(question, playArea);
        expect(turf.booleanPointInPolygon(turf.point([0.07, 0]), inside)).toBe(
            false,
        );
        expect(turf.booleanPointInPolygon(turf.point([0.04, 0]), inside)).toBe(
            true,
        );
    });

    it.each([
        {
            type: "measuring-sites",
            lng: -0.03,
            close: [-0.039, 0],
            far: [0, 0],
        },
        {
            type: "measuring-rails",
            lng: -0.03,
            close: [0.021, 0],
            far: [-0.06, 0],
        },
        {
            type: "measuring-districts",
            lng: -0.055,
            close: [-0.059, 0],
            far: [0, 0],
        },
    ])(
        "previews $type as the evaluated distance threshold, not a filled polygon",
        async ({ type, lng, close, far }) => {
            const question = {
                id: "measuring" as const,
                key: 4,
                data: measuringQuestionSchema.parse({
                    type,
                    lat: 0,
                    lng,
                    drag: true,
                    hiderCloser: true,
                }),
            };
            const preview = await determinePlanningPolygon(question, true);
            expectLineAt(preview, [lng, 0]);
            const closer = await adjustMapGeoDataForQuestion(
                question,
                playArea,
            );
            expect(turf.booleanPointInPolygon(turf.point(close), closer)).toBe(
                true,
            );
            expect(turf.booleanPointInPolygon(turf.point(far), closer)).toBe(
                false,
            );
            question.data.hiderCloser = false;
            const farther = await adjustMapGeoDataForQuestion(
                question,
                playArea,
            );
            expect(turf.booleanPointInPolygon(turf.point(close), farther)).toBe(
                false,
            );
            expect(turf.booleanPointInPolygon(turf.point(far), farther)).toBe(
                true,
            );
        },
    );

    it("previews tentacle partitions clipped to the radius and reuses them across selected locations", async () => {
        const question = {
            id: "tentacles" as const,
            key: 5,
            data: tentacleQuestionSchema.parse({
                locationType: "tentacle-sites",
                lat: 0,
                lng: 0,
                radius: 5,
                unit: "kilometers",
                drag: true,
                location: sites.features[0],
            }),
        };
        const preview = await determinePlanningPolygon(question, true);
        expectLineAt(preview, [0, -0.02]);
        if (!preview) throw new Error("Expected tentacle preview");
        turf.coordEach(preview, (coordinate) => {
            expect(
                turf.distance(turf.point([0, 0]), turf.point(coordinate)),
            ).toBeLessThanOrEqual(5.001);
        });
        const compiled = compiledGameAtom.get()!;
        const evaluator = compiled.questionMap.get("tentacle-sites")!.evaluator;
        for (const location of [sites.features[0], sites.features[1]]) {
            const region = (await evaluateTentacleOperator({
                evaluator,
                datasets: compiled.datasets,
                data: {
                    lat: 0,
                    lng: 0,
                    radius: 5,
                    unit: "kilometers",
                    location,
                },
                mapGeoData: playArea,
            })) as Feature<Polygon | MultiPolygon>;
            expect(turf.booleanPointInPolygon(location, region)).toBe(true);
            expect(turf.booleanPointInPolygon(sites.features[2], region)).toBe(
                false,
            );
            expect(
                turf.booleanPointInPolygon(turf.point([-0.07, 0]), region),
            ).toBe(false);
        }
        expect(geoSpatialVoronoiSafe).toHaveBeenCalledTimes(1);
    });

    it("plans and evaluates measuring from one buffer, exact over the boundary and superseded per question", async () => {
        mapGeoJSON.set(playArea);
        try {
            const question = {
                id: "measuring" as const,
                key: 7,
                data: measuringQuestionSchema.parse({
                    type: "measuring-rails",
                    lat: 0,
                    lng: -0.03,
                    drag: true,
                }),
            };
            await determinePlanningPolygon(question, true);
            await adjustMapGeoDataForQuestion(question, playArea);
            expect(vi.mocked(arcBufferToPoint)).toHaveBeenCalledTimes(1);
            expect(vi.mocked(arcBufferToPoint).mock.calls[0][3]).toEqual({
                within: [-0.1, -0.1, 0.1, 0.1],
                supersede: "question:7",
            });
        } finally {
            mapGeoJSON.set(null);
        }
    });

    it.each(["measuring-sites", "measuring-rails"])(
        "answers %s in hider mode with the geodetic distance the map is buffered by",
        async (type) => {
            const question = {
                id: "measuring" as const,
                key: 5,
                data: measuringQuestionSchema.parse({
                    type,
                    lat: 0,
                    lng: -0.03,
                    drag: true,
                }),
            };
            // By Turf's metric the hider, beside West and the rail at
            // -0.02, is nearer than the seeker; the answer must follow the
            // geodetic distances instead.
            vi.mocked(arcDistanceToPoint)
                .mockResolvedValueOnce(0.5)
                .mockResolvedValueOnce(0.4);
            hiderMode.set({ latitude: 0, longitude: -0.0399 });
            try {
                await hiderifyQuestion(question);
            } finally {
                hiderMode.set(false);
            }
            expect(question.data.hiderCloser).toBe(false);
            expect(
                vi
                    .mocked(arcDistanceToPoint)
                    .mock.calls.map(([, lat, lng]) => [lat, lng]),
            ).toEqual([
                [0, -0.0399],
                [0, -0.03],
            ]);
        },
    );

    it("holds every question while no game definition is loaded", async () => {
        const question = {
            id: "matching" as const,
            key: 8,
            data: matchingQuestionSchema.parse({
                type: "matching-sites",
                lat: 0,
                lng: -0.04,
                drag: true,
                same: true,
            }),
        };
        // A generic question, once answered live from OSM.
        const generic = {
            id: "matching" as const,
            key: 9,
            data: {
                type: "airport",
                lat: 0,
                lng: -0.04,
                drag: true,
                same: true,
            },
        } as any;
        setActiveGameDefinition(null);
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        try {
            hiderMode.set({ latitude: 0, longitude: 0.04 });
            for (const pending of [question, generic]) {
                expect(
                    await adjustMapGeoDataForQuestion(pending, playArea),
                ).toBe(playArea);
                expect(
                    await determinePlanningPolygon(pending, true),
                ).toBeUndefined();
                await hiderifyQuestion(pending);
                expect(pending.data.same).toBe(true);
            }
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
            hiderMode.set(false);
        }
    });

    it("does not render disabled planning questions or crash when constraints eliminate the entire map", async () => {
        const question = {
            id: "matching" as const,
            key: 6,
            data: matchingQuestionSchema.parse({
                type: "matching-sites",
                lat: 0,
                lng: -0.04,
                drag: true,
                enabled: false,
                same: true,
            }),
        };
        const preview = vi.fn();
        await applyQuestionsToMapGeoData([question], playArea, true, preview);
        expect(preview).not.toHaveBeenCalled();
        expect(await determinePlanningPolygon(question, true)).toBeUndefined();
        question.data.enabled = true;
        question.data.drag = false;
        const result = await applyQuestionsToMapGeoData(
            [question],
            turf.featureCollection([
                turf.bboxPolygon([0.035, -0.005, 0.045, 0.005]),
            ]),
            false,
        );
        expect(result).toEqual(turf.featureCollection([]));
    });
});

describe("planning with every matching cell shown", () => {
    beforeEach(() => {
        mapGeoJSON.set(playArea);
        showAllMatchingCells.set(true);
    });
    afterEach(() => {
        showAllMatchingCells.set(false);
        mapGeoJSON.set(null);
    });

    const planned = async (type: string, key: number, extra = {}) =>
        (await determinePlanningPolygon(
            {
                id: "matching" as const,
                key,
                data: matchingQuestionSchema.parse({
                    type,
                    lat: 0,
                    lng: -0.04,
                    drag: true,
                    same: true,
                    ...extra,
                }),
            },
            true,
        )) as FeatureCollection;
    const contextOf = (preview: FeatureCollection) =>
        preview.features.filter(
            (feature) => feature.properties?.[PLANNING_CONTEXT],
        );
    const ownOf = (preview: FeatureCollection) =>
        turf.featureCollection(
            preview.features.filter(
                (feature) => !feature.properties?.[PLANNING_CONTEXT],
            ),
        );
    const distanceTo = (lines: Feature[], position: [number, number]) =>
        Math.min(
            ...turf
                .flatten(turf.featureCollection(lines))
                .features.map((line) =>
                    turf.pointToLineDistance(
                        turf.point(position),
                        line as Feature<LineString>,
                    ),
                ),
        );

    it("draws the other points' cells within the play area, from the seeker's own tessellation", async () => {
        const preview = await planned("matching-sites", 40);
        const context = contextOf(preview);
        expect(context).toHaveLength(1);
        // East and North meet on y = x, away from the seeker's cell.
        expect(distanceTo(context, [0.03, 0.03])).toBeLessThan(0.02);
        expect(
            distanceTo(ownOf(preview).features, [0.03, 0.03]),
        ).toBeGreaterThan(1);
        // Only borders between cells: the play area's edge isn't redrawn.
        expect(distanceTo(context, [0.08, -0.05])).toBeGreaterThan(1);
        turf.coordEach(context[0], ([x, y]) => {
            expect(Math.abs(x)).toBeLessThanOrEqual(0.08 + 1e-9);
            expect(Math.abs(y)).toBeLessThanOrEqual(0.08 + 1e-9);
        });
        expectLineAt(ownOf(preview), [0, -0.02]);
        expect(geoSpatialVoronoiSafe).toHaveBeenCalledTimes(1);
    });

    it("draws every region's border", async () => {
        const preview = await planned("matching-districts", 41);
        const context = contextOf(preview);
        expect(context).toHaveLength(1);
        expect(distanceTo(context, [0.01, 0])).toBeLessThan(0.02);
        expect(distanceTo(context, [0.06, 0])).toBeLessThan(0.02);
    });

    it("draws custom points' cells", async () => {
        const preview = await planned("custom-points", 42, {
            geo: [
                turf.point([-0.04, 0]),
                turf.point([0.04, 0]),
                turf.point([0, 0.04]),
            ],
        });
        const context = contextOf(preview);
        expect(context).toHaveLength(1);
        expect(distanceTo(context, [0.03, 0.03])).toBeLessThan(0.02);
    });

    it("still shows the seeker's cell when the other cells' borders fail", async () => {
        const voronoi = vi.mocked(geoSpatialVoronoiSafe);
        const build = voronoi.getMockImplementation()!;
        // The seeker's cell builds first, then the borders' cells.
        voronoi.mockImplementationOnce(build).mockImplementationOnce(() => {
            throw new Error("No cells");
        });
        const preview = await planned("custom-points", 45, {
            geo: [
                turf.point([-0.04, 0.01]),
                turf.point([0.04, 0.01]),
                turf.point([0, 0.05]),
            ],
        });
        expect(voronoi).toHaveBeenCalledTimes(2);
        expect(
            contextOf(turf.featureCollection(turf.flatten(preview).features)),
        ).toHaveLength(0);
        expectLineAt(preview, [0, -0.02]);
    });

    it("leaves line layers, and planning with the setting off, as they were", async () => {
        expect(contextOf(await planned("matching-rails", 43))).toHaveLength(0);
        showAllMatchingCells.set(false);
        const preview = await planned("matching-sites", 44);
        expect(
            turf
                .flatten(preview)
                .features.some(
                    (feature) => feature.properties?.[PLANNING_CONTEXT],
                ),
        ).toBe(false);
    });
});
