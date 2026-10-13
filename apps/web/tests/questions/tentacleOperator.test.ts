import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    Point,
    Polygon,
    MultiPolygon,
} from "geojson";
import { describe, expect, it, vi } from "vitest";
import type * as GeoUtils from "@/maps/geo-utils";

// ArcGIS's geodesic buffer needs browser WASM; a finely stepped geodesic
// circle stands in for it.
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcBuffer: vi.fn(
            async (fc: FeatureCollection, radius: number, unit = "miles") =>
                turf.circle(fc.features[0] as Feature<Point>, radius, {
                    units: unit as turf.Units,
                    steps: 360,
                }),
        ),
    };
});

import { compileGameDefinition } from "@/game-definition/compile";
import { setActiveGameDefinition } from "@/game-definition/store";
import { hiderMode } from "@/lib/context";
import { hiderifyQuestion } from "@/maps";
import type { GameDefinition } from "@searchlight/shared";
import {
    evaluateTentacleOperator,
    featuresMatch,
    getFeatureCoordinates,
} from "@/maps/questions/operators/tentacle";
import { getLocationsForTentacleQuestion } from "@/maps/questions/tentacles";

describe("Tentacle Operator & Location Contract", () => {
    const boundaryPoly = {
        type: "Feature" as const,
        properties: {},
        geometry: {
            type: "Polygon" as const,
            coordinates: [
                [
                    [9.9, 53.5],
                    [10.1, 53.5],
                    [10.1, 53.6],
                    [9.9, 53.6],
                    [9.9, 53.5],
                ] as [number, number][],
            ],
        },
    };
    const playArea = {
        type: "FeatureCollection" as const,
        features: [boundaryPoly],
    };

    const poiNorth = {
        type: "Feature" as const,
        id: "fountain-north",
        properties: { name: "Twin Fountain" },
        geometry: {
            type: "Point" as const,
            coordinates: [10.0, 53.58] as [number, number],
        },
    };
    const poiSouth = {
        type: "Feature" as const,
        id: "fountain-south",
        properties: { name: "Twin Fountain" },
        geometry: {
            type: "Point" as const,
            coordinates: [10.0, 53.52] as [number, number],
        },
    };
    const poiFar = {
        type: "Feature" as const,
        id: "fountain-far",
        properties: { name: "Far Fountain" },
        geometry: {
            type: "Point" as const,
            coordinates: [10.0, 53.7] as [number, number],
        },
    };

    const centralStation = {
        type: "Feature" as const,
        properties: { name: "Central Station" },
        geometry: {
            type: "Point" as const,
            coordinates: [10.0, 53.55] as [number, number],
        },
    };

    const testGameDef: GameDefinition = {
        id: "hamburg-tentacles",
        name: "Hamburg Tentacles Test",
        serverId: "test-server",
        map: {
            center: [10.0, 53.55],
            playArea,
        },
        hidingZones: {
            radius: 500,
            unit: "meters",
            features: {
                type: "FeatureCollection",
                features: [centralStation],
            },
        },
        features: [
            {
                name: "Fountains",
                enabledFor: ["tentacle"],
                data: {
                    type: "FeatureCollection",
                    features: [poiNorth, poiSouth, poiFar],
                },
            },
        ],
    };

    const compiled = compileGameDefinition(testGameDef);
    setActiveGameDefinition(testGameDef);

    it("resolves compiled inline dataset for compiled tentacle IDs without OSM", async () => {
        const question = {
            lat: 53.55,
            lng: 10.0,
            radius: 10,
            unit: "kilometers" as const,
            locationType: "tentacle-fountains",
            location: false as const,
            color: "blue",
            collapsed: false,
            drag: true,
        };

        const locations = await getLocationsForTentacleQuestion(
            question as never,
        );
        expect(locations).toBeDefined();
        expect(locations.type).toBe("FeatureCollection");
        // poiNorth and poiSouth are within ~5.5km; poiFar is ~16km away (outside 10km radius)
        expect(locations.features.length).toBe(2);
        expect(locations.features[0].properties?.name).toBe("Twin Fountain");
        expect(locations.features[1].properties?.name).toBe("Twin Fountain");
    });

    it("eliminates circle when location is false (outside circle)", async () => {
        const tentacleQ = compiled.questions.find(
            (q) => q.family === "tentacle",
        );
        expect(tentacleQ).toBeDefined();

        const result = await evaluateTentacleOperator({
            evaluator: tentacleQ!.evaluator,
            datasets: compiled.datasets,
            data: {
                lat: 53.55,
                lng: 10.0,
                radius: 2,
                unit: "kilometers",
                location: false,
            },
            mapGeoData: playArea as FeatureCollection<Polygon | MultiPolygon>,
        });

        expect(result).toBeDefined();
        // A hole must have been carved out from the playArea
        const centerPt = turf.point([10.0, 53.55]);
        const centerInResult = turf.booleanPointInPolygon(
            centerPt,
            result as Feature<Polygon | MultiPolygon>,
        );
        expect(centerInResult).toBe(false);
    });

    it("returns restricted geometry when real compiled Feature<Point> POI is selected", async () => {
        const tentacleQ = compiled.questions.find(
            (q) => q.family === "tentacle",
        );
        expect(tentacleQ).toBeDefined();

        // Select poiNorth as the location
        const result = await evaluateTentacleOperator({
            evaluator: tentacleQ!.evaluator,
            datasets: compiled.datasets,
            data: {
                lat: 53.55,
                lng: 10.0,
                radius: 10,
                unit: "kilometers",
                location: poiNorth,
            },
            mapGeoData: playArea as FeatureCollection<Polygon | MultiPolygon>,
        });

        expect(result).toBeDefined();
        // The restricted geometry must contain poiNorth
        const northInResult = turf.booleanPointInPolygon(
            poiNorth,
            result as Feature<Polygon | MultiPolygon>,
        );
        expect(northInResult).toBe(true);

        // And must NOT contain poiSouth (which belongs to the other Voronoi cell)
        const southInResult = turf.booleanPointInPolygon(
            poiSouth,
            result as Feature<Polygon | MultiPolygon>,
        );
        expect(southInResult).toBe(false);
    });

    it("correctly distinguishes duplicate display names using coordinates/id identity", async () => {
        const tentacleQ = compiled.questions.find(
            (q) => q.family === "tentacle",
        );
        expect(tentacleQ).toBeDefined();

        // Both poiNorth and poiSouth have identical display name: "Twin Fountain"
        expect(poiNorth.properties?.name).toBe(poiSouth.properties?.name);

        // Evaluate with poiNorth
        const resultNorth = await evaluateTentacleOperator({
            evaluator: tentacleQ!.evaluator,
            datasets: compiled.datasets,
            data: {
                lat: 53.55,
                lng: 10.0,
                radius: 10,
                unit: "kilometers",
                location: poiNorth,
            },
            mapGeoData: playArea as FeatureCollection<Polygon | MultiPolygon>,
        });

        // Evaluate with poiSouth
        const resultSouth = await evaluateTentacleOperator({
            evaluator: tentacleQ!.evaluator,
            datasets: compiled.datasets,
            data: {
                lat: 53.55,
                lng: 10.0,
                radius: 10,
                unit: "kilometers",
                location: poiSouth,
            },
            mapGeoData: playArea as FeatureCollection<Polygon | MultiPolygon>,
        });

        expect(resultNorth).toBeDefined();
        expect(resultSouth).toBeDefined();

        // The two resulting restricted geometries must be different
        const areaNorth = turf.area(
            resultNorth as Feature<Polygon | MultiPolygon>,
        );
        const areaSouth = turf.area(
            resultSouth as Feature<Polygon | MultiPolygon>,
        );
        expect(areaNorth).toBeGreaterThan(0);
        expect(areaSouth).toBeGreaterThan(0);

        expect(
            turf.booleanPointInPolygon(
                poiNorth,
                resultNorth as Feature<Polygon | MultiPolygon>,
            ),
        ).toBe(true);
        expect(
            turf.booleanPointInPolygon(
                poiNorth,
                resultSouth as Feature<Polygon | MultiPolygon>,
            ),
        ).toBe(false);

        expect(
            turf.booleanPointInPolygon(
                poiSouth,
                resultSouth as Feature<Polygon | MultiPolygon>,
            ),
        ).toBe(true);
        expect(
            turf.booleanPointInPolygon(
                poiSouth,
                resultNorth as Feature<Polygon | MultiPolygon>,
            ),
        ).toBe(false);
    });

    it("handles single POI in circle by restricting to the circle", async () => {
        const singlePoiDef: GameDefinition = {
            id: "single-tentacle",
            name: "Single Tentacle",
            serverId: "test-server",
            map: {
                center: [10.0, 53.55],
                playArea,
            },
            hidingZones: {
                radius: 500,
                unit: "meters",
                features: {
                    type: "FeatureCollection",
                    features: [centralStation],
                },
            },
            features: [
                {
                    name: "Monuments",
                    enabledFor: ["tentacle"],
                    data: {
                        type: "FeatureCollection",
                        features: [poiNorth],
                    },
                },
            ],
        };
        const singleCompiled = compileGameDefinition(singlePoiDef);
        const tentacleQ = singleCompiled.questions.find(
            (q) => q.family === "tentacle",
        );

        const result = await evaluateTentacleOperator({
            evaluator: tentacleQ!.evaluator,
            datasets: singleCompiled.datasets,
            data: {
                lat: 53.58,
                lng: 10.0,
                radius: 1,
                unit: "kilometers",
                location: poiNorth,
            },
            mapGeoData: playArea as FeatureCollection<Polygon | MultiPolygon>,
        });

        expect(result).toBeDefined();
        expect(
            turf.booleanPointInPolygon(
                poiNorth,
                result as Feature<Polygon | MultiPolygon>,
            ),
        ).toBe(true);
    });

    it("lists, keeps and answers a site just inside the radius, between circle vertices", async () => {
        const center = turf.point([10.0, 53.55]);
        // 99.7% of the radius, midway between two vertices of a coarse
        // 32-segment circle (which would leave it outside).
        const edge = turf.destination(center, 4.985, 5.625, {
            units: "kilometers",
        });
        edge.id = "edge-fountain";
        edge.properties = { name: "Edge Fountain" };
        const inner = turf.point([10.0, 53.53], { name: "Inner Fountain" });
        const edgeGame: GameDefinition = {
            ...testGameDef,
            id: "edge-tentacles",
            features: [
                {
                    name: "Edge Fountains",
                    enabledFor: ["tentacle"],
                    data: turf.featureCollection([edge, inner]) as never,
                },
            ],
        };
        setActiveGameDefinition(edgeGame);
        try {
            const data = {
                lat: 53.55,
                lng: 10.0,
                radius: 5,
                unit: "kilometers" as const,
                locationType: "tentacle-edge-fountains",
                drag: true,
            };
            const listed = await getLocationsForTentacleQuestion({
                ...data,
                location: false,
            } as never);
            expect(listed.features.map((f) => f.properties?.name)).toEqual([
                "Edge Fountain",
                "Inner Fountain",
            ]);

            const edgeCompiled = compileGameDefinition(edgeGame);
            const region = await evaluateTentacleOperator({
                evaluator: edgeCompiled.questions[0].evaluator,
                datasets: edgeCompiled.datasets,
                data: { ...data, location: edge as Feature<Point> },
                mapGeoData: playArea as FeatureCollection<
                    Polygon | MultiPolygon
                >,
            });
            expect(
                turf.booleanPointInPolygon(
                    edge,
                    region as Feature<Polygon | MultiPolygon>,
                ),
            ).toBe(true);

            const [lng, lat] = edge.geometry.coordinates;
            hiderMode.set({ latitude: lat, longitude: lng });
            const question = {
                id: "tentacles" as const,
                key: 1,
                data: { ...data, location: false as const },
            };
            await hiderifyQuestion(question as never);
            expect(question.data.location).toMatchObject({
                id: "edge-fountain",
                geometry: edge.geometry,
            });
        } finally {
            hiderMode.set(false);
            setActiveGameDefinition(testGameDef);
        }
    });

    it("featuresMatch compares by ID and exact coordinates without relying on display names", () => {
        const p1 = turf.point([10.0, 53.5], { name: "Same Name" }, { id: "a" });
        const p2 = turf.point(
            [10.0, 53.5],
            { name: "Different Name" },
            { id: "a" },
        );
        const p3 = turf.point([10.0, 53.5], { name: "Same Name" }, { id: "b" });
        const p4 = turf.point([10.5, 53.8], { name: "Same Name" }, { id: "c" });

        // Same id matches even if name differs
        expect(featuresMatch(p1, p2)).toBe(true);
        // Same exact coords match even if id differs
        expect(featuresMatch(p1, p3)).toBe(true);
        // Different coords and different id do not match even with same name
        expect(featuresMatch(p1, p4)).toBe(false);
        // Different coords with duplicate id (e.g. Paris UGC) do not match
        const p5 = turf.point([10.5, 53.8], { name: "Same Name" }, { id: "a" });
        expect(featuresMatch(p1, p5)).toBe(false);
        expect(getFeatureCoordinates(p1)).toEqual([10.0, 53.5]);
    });
});
