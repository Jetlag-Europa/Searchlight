import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type * as GeoUtils from "@/maps/geo-utils";
import { arcBuffer } from "@/maps/geo-utils";

vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcBuffer: vi.fn(
            async (
                fc: FeatureCollection,
                distance: number,
                unit: turf.Units = "miles",
            ) => {
                const buffered = turf.buffer(fc, distance, { units: unit });
                if (!buffered) throw new Error("No buffer");
                return actual.safeUnion(buffered);
            },
        ),
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
                    const distance =
                        feature.geometry.type === "Point"
                            ? turf.distance(origin, feature as Feature<Point>, {
                                  units: unit,
                              })
                            : turf.pointToLineDistance(
                                  origin,
                                  feature as Feature<LineString>,
                                  { units: unit },
                              );
                    nearest = Math.min(nearest, distance);
                });
                return nearest;
            },
        ),
        arcBufferToPoint: vi.fn(
            async (fc: FeatureCollection, lat: number, lng: number) => {
                const seeker = turf.point([lng, lat]);
                const verts = turf.explode(fc);
                let min = Infinity;
                turf.featureEach(verts, (p) => {
                    const d = turf.distance(seeker, p, { units: "miles" });
                    if (d < min) min = d;
                });
                const buffered = turf.buffer(fc, min, { units: "miles" });
                if (!buffered) throw new Error("No buffer");
                return actual.safeUnion(buffered);
            },
        ),
    };
});

import { filterZoneIndexes } from "@/maps/geo-utils/geometryClient";
import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import type { Region } from "@/maps/questions/operators/geometry";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils/voronoi";
import {
    determineMatchingGeometry,
    evaluateMatchingOperator,
} from "@/maps/questions/operators/matching";
import {
    determineMeasuringGeometry,
    evaluateMeasuringOperator,
} from "@/maps/questions/operators/measuring";
import {
    determineTentacleGeometry,
    featuresMatch,
} from "@/maps/questions/operators/tentacle";
const PRELOADED = resolve(__dirname, "../../../../games/preloaded");

describe("Geometry Repairs & Regressions", () => {
    describe("Contradiction 1: Point identity duplicate IDs (Paris UGC fixture)", () => {
        const parisGame = JSON.parse(
            readFileSync(resolve(PRELOADED, "paris-2026.game.json"), "utf8"),
        );
        const cinemaFeature = parisGame.features.find(
            (f: { name?: string }) => f.name === "Cinema",
        );
        // The preloaded file gives every "UGC" its own ID, but imported files
        // may still repeat IDs: give them all the one the old data shared.
        const ugcCinemas = cinemaFeature.data.features
            .filter((f: Feature<Point>) => f.properties?.name === "UGC")
            .map((f: Feature<Point>) => ({ ...f, id: "ugc" }));

        it("distinguishes locations with duplicate IDs by their coordinates", () => {
            const c0 = ugcCinemas[0];
            const c1 = ugcCinemas[1];
            expect(featuresMatch(c0, c1)).toBe(false);
        });

        it("matching operator with UGC duplicate IDs correctly preserves hider when answer is different", async () => {
            const c0 = ugcCinemas[0];
            const c1 = ugcCinemas[1];
            const seekerPt = c0.geometry.coordinates;
            const hiderPt = c1.geometry.coordinates;

            const datasets = {
                cinemas: {
                    kind: "inline",
                    features: turf.featureCollection(ugcCinemas),
                },
            };
            const evaluator = {
                operator: "nearest-feature-match",
                source: { kind: "dataset", datasetId: "cinemas" },
            } as const;

            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([1.8, 48.5, 2.8, 49.1]),
            ]);

            // Seeker is at c0, hider is at c1. featuresMatch says they are different (same: false).
            const areSame = featuresMatch(c0, c1);
            expect(areSame).toBe(false);

            const modifiedMap = (await evaluateMatchingOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], same: areSame },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;

            expect(modifiedMap).toBeDefined();
            // The hider must survive in the map
            expect(
                turf.booleanPointInPolygon(turf.point(hiderPt), modifiedMap),
            ).toBe(true);
            // The seeker must be excluded since answer is different
            expect(
                turf.booleanPointInPolygon(turf.point(seekerPt), modifiedMap),
            ).toBe(false);
        });

        it("tentacle operator selects the exact UGC cinema's cell without colliding on duplicate ID", async () => {
            const targetCinema = ugcCinemas[4];
            const seekerPt = ugcCinemas[0].geometry.coordinates;
            const datasets = {
                cinemas: {
                    kind: "inline",
                    features: turf.featureCollection(ugcCinemas),
                },
            };
            const evaluator = {
                operator: "inside-circle",
                source: { kind: "dataset", datasetId: "cinemas" },
            } as const;

            const result = await determineTentacleGeometry({
                evaluator,
                datasets,
                data: {
                    lat: seekerPt[1],
                    lng: seekerPt[0],
                    radius: 15,
                    unit: "miles",
                },
            });

            expect(result.cells.features.length).toBeGreaterThan(0);
            const matchedCell = result.cells.features.find((c) =>
                featuresMatch(c.properties?.site, targetCinema),
            );
            expect(matchedCell).toBeDefined();
            expect(
                featuresMatch(matchedCell?.properties?.site, targetCinema),
            ).toBe(true);
            // Ensure it did not match the wrong cinema
            expect(
                featuresMatch(matchedCell?.properties?.site, ugcCinemas[0]),
            ).toBe(false);
        });
    });

    describe("Contradiction 2: South Limburg clustered consulate Voronoi", () => {
        const slGame = JSON.parse(
            readFileSync(
                resolve(PRELOADED, "south-limburg-2026.game.json"),
                "utf8",
            ),
        );
        const consulateFeature = slGame.features.find(
            (f: { data?: { features?: Feature<Point>[] } }) =>
                f.data?.features?.some((p) => p.id === "consulate-of-belgium"),
        );
        const points = consulateFeature.data as FeatureCollection<Point>;

        it("prevents self-exclusion on tightly clustered consulates", () => {
            const bbox = [5.5, 50.7, 6.0, 51.1] as [
                number,
                number,
                number,
                number,
            ];
            const safe = geoSpatialVoronoiSafe(points, bbox);

            expect(safe.features.length).toBe(points.features.length);
            for (const site of points.features) {
                const owningCell = safe.features.find((c) =>
                    turf.booleanPointInPolygon(site, c),
                );
                expect(owningCell).toBeDefined();
                expect(owningCell?.properties?.site?.id).toBe(site.id);
            }
        });

        it("matches nearest-point classification on 6400 probes across South Limburg", () => {
            const bbox = [5.5, 50.7, 6.0, 51.1] as [
                number,
                number,
                number,
                number,
            ];
            const safe = geoSpatialVoronoiSafe(points, bbox);

            let misclassified = 0;
            const N = 80;
            for (let i = 0; i < N; i++) {
                const lng = bbox[0] + ((bbox[2] - bbox[0]) * (i + 0.5)) / N;
                for (let j = 0; j < N; j++) {
                    const lat = bbox[1] + ((bbox[3] - bbox[1]) * (j + 0.5)) / N;
                    const probe = turf.point([lng, lat]);
                    const nearest = turf.nearestPoint(probe, points);
                    const cell = safe.features.find((f) =>
                        turf.booleanPointInPolygon(probe, f),
                    );
                    if (!cell || cell.properties?.site?.id !== nearest.id) {
                        misclassified++;
                    }
                }
            }

            // Regional Gnomonic planar projection approximates great-circle bisectors closely enough to eliminate probe misclassifications across South Limburg.
            expect(misclassified).toBe(0);
        });

        it("production determineMatchingGeometry with world bbox keeps each consulate in its own region", async () => {
            const datasets = {
                consulates: { kind: "inline", features: points },
            };
            const evaluator = {
                operator: "nearest-feature-match",
                source: { kind: "dataset", datasetId: "consulates" },
            } as const;

            for (const site of points.features) {
                const seekerPt = site.geometry.coordinates;
                const res = await determineMatchingGeometry({
                    evaluator,
                    datasets,
                    data: { lat: seekerPt[1], lng: seekerPt[0] },
                });
                expect(res).toBeDefined();
                expect(
                    turf.booleanPointInPolygon(
                        turf.point(seekerPt),
                        res!.region,
                    ),
                ).toBe(true);
            }
        });

        it("recomputes domain and does not reuse stale cache when custom boundary changes in same dataset", async () => {
            const datasets = {
                consulates: { kind: "inline", features: points },
            };
            const evaluator = {
                operator: "nearest-feature-match",
                source: { kind: "dataset", datasetId: "consulates" },
            } as const;
            const seekerPt = points.features[0].geometry.coordinates;

            // Boundary 1: narrow around Maastricht
            const mapGeoData1 = turf.featureCollection([
                turf.bboxPolygon([5.6, 50.8, 5.8, 50.9]),
            ]);
            const res1 = await determineMatchingGeometry({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0] },
                mapGeoData: mapGeoData1,
            });
            expect(res1).toBeDefined();

            // Boundary 2: wide regional map
            const mapGeoData2 = turf.featureCollection([
                turf.bboxPolygon([5.0, 50.0, 6.5, 51.5]),
            ]);
            const res2 = await determineMatchingGeometry({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0] },
                mapGeoData: mapGeoData2,
            });
            expect(res2).toBeDefined();
            expect(res2!.region).not.toEqual(res1!.region);
            // Far probe covered by wide regional map
            const farProbe = turf.point([5.3, 50.5]);
            expect(turf.booleanPointInPolygon(farProbe, res2!.region)).toBe(
                true,
            );
        });
    });

    describe("Contradiction 3: Own-region boundary measuring across two regions", () => {
        const regionA = turf.polygon([
            [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
            ],
        ]);
        const regionB = turf.polygon([
            [
                [20, 0],
                [30, 0],
                [30, 10],
                [20, 10],
                [20, 0],
            ],
        ]);

        const datasets = {
            regions: {
                kind: "inline",
                features: turf.featureCollection([regionA, regionB]),
            },
        };
        const evaluator = {
            operator: "distance-to-containing-region-boundary",
            source: { kind: "dataset", datasetId: "regions" },
        } as const;

        // Seeker in Region A at [1, 5] (distance to Region A boundary is ~111 km)
        const seekerPt: [number, number] = [1, 5];
        // Hider in Region B at [20.5, 5] (distance to Region B boundary is ~55 km, closer than seeker!)
        const hiderCloserPt: [number, number] = [20.5, 5];
        // Hider in Region B at [25, 5] (distance to Region B boundary is ~550 km, farther than seeker!)
        const hiderFartherPt: [number, number] = [25, 5];
        const outsidePt: [number, number] = [15, 5];

        const mapGeoData = turf.featureCollection([
            turf.bboxPolygon([-5, -5, 35, 15]),
        ]);

        it("when hider is closer, candidate in second region survives and outside points are pruned", async () => {
            const result = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], hiderCloser: true },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;

            expect(result).toBeDefined();
            expect(
                turf.booleanPointInPolygon(turf.point(hiderCloserPt), result),
            ).toBe(true);
            expect(
                turf.booleanPointInPolygon(turf.point(hiderFartherPt), result),
            ).toBe(false);
            expect(
                turf.booleanPointInPolygon(turf.point(outsidePt), result),
            ).toBe(false);
        });

        it("does not reuse a region target across different areas sharing one bounding box", async () => {
            const outer = turf.bboxPolygon([-5, -5, 35, 15]);
            const hole = turf.bboxPolygon([19, -1, 31, 11]);
            const cutout = turf.polygon([
                outer.geometry.coordinates[0],
                hole.geometry.coordinates[0],
            ]);
            const scopedDatasets = {
                regions: {
                    kind: "inline",
                    features: turf.featureCollection([regionA, regionB]),
                },
            };
            const data = {
                lat: seekerPt[1],
                lng: seekerPt[0],
                hiderCloser: true,
            };
            const withoutB = await evaluateMeasuringOperator({
                evaluator,
                datasets: scopedDatasets,
                data,
                mapGeoData: turf.featureCollection([cutout]),
            });
            expect(
                Boolean(
                    withoutB &&
                        withoutB.type === "Feature" &&
                        turf.booleanPointInPolygon(
                            turf.point(hiderCloserPt),
                            withoutB,
                        ),
                ),
            ).toBe(false);

            const withB = await evaluateMeasuringOperator({
                evaluator,
                datasets: scopedDatasets,
                data,
                mapGeoData: turf.featureCollection([outer]),
            });
            expect(
                Boolean(
                    withB &&
                        withB.type === "Feature" &&
                        turf.booleanPointInPolygon(
                            turf.point(hiderCloserPt),
                            withB,
                        ),
                ),
            ).toBe(true);
        });

        it("when hider is farther, candidate in second region survives and outside points are pruned", async () => {
            const result = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: {
                    lat: seekerPt[1],
                    lng: seekerPt[0],
                    hiderCloser: false,
                },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;

            expect(result).toBeDefined();
            expect(
                turf.booleanPointInPolygon(turf.point(hiderCloserPt), result),
            ).toBe(false);
            expect(
                turf.booleanPointInPolygon(turf.point(hiderFartherPt), result),
            ).toBe(true);
            expect(
                turf.booleanPointInPolygon(turf.point(outsidePt), result),
            ).toBe(true);
        });

        it.each([
            {
                // Seeker in Region A, 1° from its boundary.
                seeker: seekerPt,
                closer: [
                    [-0.5, 5], // just outside Region A
                    [20.5, 5],
                ],
                farther: [
                    [-4, 5],
                    [15, 5], // 5° from both regions
                ],
            },
            {
                // Seeker in neither region, 2° from Region A.
                seeker: [12, 5],
                closer: [
                    [11, 5],
                    [20.5, 5],
                ],
                farther: [
                    [15, 5],
                    [25, 5], // Region B's centre, 5° from its boundary
                ],
            },
        ])(
            "measures a point outside every region to the nearest region's boundary (seeker at $seeker)",
            async ({ seeker, closer, farther }) => {
                for (const hiderCloser of [true, false]) {
                    const result = (await evaluateMeasuringOperator({
                        evaluator,
                        datasets,
                        data: { lat: seeker[1], lng: seeker[0], hiderCloser },
                        mapGeoData,
                    })) as Feature<Polygon | MultiPolygon>;
                    for (const point of closer) {
                        expect(turf.booleanPointInPolygon(point, result)).toBe(
                            hiderCloser,
                        );
                    }
                    for (const point of farther) {
                        expect(turf.booleanPointInPolygon(point, result)).toBe(
                            !hiderCloser,
                        );
                    }
                }
            },
        );

        it("handles disjoint current area: closer eliminates all, farther keeps all", async () => {
            const disjointMap = turf.featureCollection([
                turf.bboxPolygon([50, 50, 60, 60]),
            ]);

            // When candidateRegions is empty (disjoint from all regions):
            // closer: eliminates all (empty FeatureCollection)
            const closerRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], hiderCloser: true },
                mapGeoData: disjointMap,
            })) as FeatureCollection;
            expect(closerRes.type).toBe("FeatureCollection");
            expect(closerRes.features.length).toBe(0);

            // farther: keeps all of mapGeoData
            const fartherRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: {
                    lat: seekerPt[1],
                    lng: seekerPt[0],
                    hiderCloser: false,
                },
                mapGeoData: disjointMap,
            })) as FeatureCollection<Polygon | MultiPolygon>;
            expect(fartherRes).toBeDefined();
            expect(
                turf.booleanPointInPolygon(
                    turf.point([55, 55]),
                    fartherRes.features[0],
                ),
            ).toBe(true);
        });

        it("handles zero closer parts (seeker at boundary): closer eliminates all, farther keeps all", async () => {
            // Seeker right at Region A boundary: [0, 5], distance = 0
            const boundarySeekerPt: [number, number] = [0, 5];

            const closerRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: {
                    lat: boundarySeekerPt[1],
                    lng: boundarySeekerPt[0],
                    hiderCloser: true,
                },
                mapGeoData,
            })) as FeatureCollection;
            expect(closerRes.type).toBe("FeatureCollection");
            expect(closerRes.features.length).toBe(0);

            const fartherRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: {
                    lat: boundarySeekerPt[1],
                    lng: boundarySeekerPt[0],
                    hiderCloser: false,
                },
                mapGeoData,
            })) as FeatureCollection<Polygon | MultiPolygon>;
            expect(fartherRes).toBeDefined();
            expect(
                turf.booleanPointInPolygon(
                    turf.point([5, 5]),
                    fartherRes.features[0],
                ),
            ).toBe(true);
        });
    });

    describe("Contradiction 4: Nearest-line matching competing lines", () => {
        // Line 1 is short (1 km)
        const line1 = turf.lineString([
            [5.0, 50.0],
            [5.0, 50.009],
        ]);
        // Line 2 is long (100 km)
        const line2 = turf.lineString([
            [5.008, 49.5],
            [5.008, 50.5],
        ]);

        const datasets = {
            lines: {
                kind: "inline",
                features: turf.featureCollection([line1, line2]),
            },
        };
        const evaluator = {
            operator: "nearest-feature-match",
            source: { kind: "dataset", datasetId: "lines" },
        } as const;

        it("never crops the seeker out of its nearest line's matching region", async () => {
            // Seeker is closer to line 1
            const seekerPt = [5.003, 50.005];
            const result = await determineMatchingGeometry({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0] },
            });

            expect(result).toBeDefined();
            expect(result?.sameInside).toBe(true);
            expect(
                turf.booleanPointInPolygon(
                    turf.point(seekerPt),
                    result!.region,
                ),
            ).toBe(true);
        });

        it("agrees with nearestLine answer across long and short lines and inter-sample probes", async () => {
            const seekerPt = [5.003, 50.005];
            const result = await determineMatchingGeometry({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0] },
            });
            expect(result).toBeDefined();

            // Probes near line 1 should be inside line 1's region
            const nearLine1 = turf.point([5.001, 50.004]);
            expect(turf.booleanPointInPolygon(nearLine1, result!.region)).toBe(
                true,
            );

            // Probes near line 2 should be outside line 1's region
            const nearLine2 = turf.point([5.007, 50.004]);
            expect(turf.booleanPointInPolygon(nearLine2, result!.region)).toBe(
                false,
            );

            // Probes midway between samples along line 1 must strictly agree with continuous point-to-line distance
            for (let s = 1; s <= 5; s++) {
                const probePt = turf.point([5.002, 50.0 + 0.0015 * s]);
                const d1 = turf.pointToLineDistance(probePt, line1, {
                    units: "kilometers",
                });
                const d2 = turf.pointToLineDistance(probePt, line2, {
                    units: "kilometers",
                });
                const expectedCloserToLine1 = d1 < d2;
                expect(
                    turf.booleanPointInPolygon(probePt, result!.region),
                ).toBe(expectedCloserToLine1);
            }
        });

        it("keeps a seeker on either of two lines closer than a sample step in their own line's region", async () => {
            // 5 m apart, with staggered samples: the sampled boundary cannot
            // resolve them, but the seeker's own answer must still be right.
            const first = turf.lineString([
                [0, 0],
                [0.018, 0],
            ]);
            const second = turf.lineString([
                [0.00009, 0.000045],
                [0.01809, 0.000045],
            ]);
            const parallel = {
                parallel: {
                    kind: "inline",
                    features: turf.featureCollection([first, second]),
                },
            };
            const evaluator = {
                operator: "nearest-feature-match",
                source: { kind: "dataset", datasetId: "parallel" },
            } as const;
            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([-0.002, -0.002, 0.02, 0.002]),
            ]);
            for (let index = 10; index < 80; index += 5) {
                const longitude = 0.00009 + index * 0.00018;
                for (const latitude of [0, 0.000045]) {
                    const seeker = turf.point([longitude, latitude]);
                    const data = { lat: latitude, lng: longitude };
                    const selection = await determineMatchingGeometry({
                        evaluator,
                        datasets: parallel,
                        data,
                        mapGeoData,
                    });
                    expect(
                        turf.booleanPointInPolygon(seeker, selection!.region),
                    ).toBe(true);
                    const different = (await evaluateMatchingOperator({
                        evaluator,
                        datasets: parallel,
                        data: { ...data, same: false },
                        mapGeoData,
                    })) as Feature<Polygon | MultiPolygon>;
                    expect(turf.booleanPointInPolygon(seeker, different)).toBe(
                        false,
                    );
                }
            }
        }, 120_000);

        it("evaluates both polarities correctly without false positives or false negatives", async () => {
            const seekerPt = [5.003, 50.005];
            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([4.95, 49.45, 5.05, 50.55]),
            ]);

            const nearLine1 = turf.point([5.001, 50.004]);
            const nearLine2 = turf.point([5.007, 50.004]);

            // Polar 1: same = true (seeker and hider are near the same line)
            const sameResult = (await evaluateMatchingOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], same: true },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;

            expect(
                turf.booleanPointInPolygon(turf.point(seekerPt), sameResult),
            ).toBe(true);
            expect(turf.booleanPointInPolygon(nearLine1, sameResult)).toBe(
                true,
            );
            expect(turf.booleanPointInPolygon(nearLine2, sameResult)).toBe(
                false,
            );

            // Polar 2: same = false (seeker and hider are near different lines)
            const diffResult = (await evaluateMatchingOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], same: false },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;

            expect(
                turf.booleanPointInPolygon(turf.point(seekerPt), diffResult),
            ).toBe(false);
            expect(turf.booleanPointInPolygon(nearLine1, diffResult)).toBe(
                false,
            );
            expect(turf.booleanPointInPolygon(nearLine2, diffResult)).toBe(
                true,
            );
        });

        it("handles near-parallel competing lines (20m apart) with nearest-line classification under planar approximation and both polarities", async () => {
            const npLine1 = turf.lineString([
                [5.0, 50.0],
                [5.0, 50.01],
            ]);
            const npLine2 = turf.lineString([
                [5.00028, 50.0],
                [5.00028, 50.01],
            ]);
            const npDatasets = {
                lines: {
                    kind: "inline",
                    features: turf.featureCollection([npLine1, npLine2]),
                },
            };
            const npSeekerPt = [5.00007, 50.005];

            const res = await determineMatchingGeometry({
                evaluator,
                datasets: npDatasets,
                data: { lat: npSeekerPt[1], lng: npSeekerPt[0] },
            });
            expect(res).toBeDefined();
            expect(
                turf.booleanPointInPolygon(turf.point(npSeekerPt), res!.region),
            ).toBe(true);

            const probeNear2 = turf.point([5.00021, 50.005]);
            expect(turf.booleanPointInPolygon(probeNear2, res!.region)).toBe(
                false,
            );

            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([4.99, 49.99, 5.01, 50.02]),
            ]);
            const sameTrue = (await evaluateMatchingOperator({
                evaluator,
                datasets: npDatasets,
                data: { lat: npSeekerPt[1], lng: npSeekerPt[0], same: true },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;
            expect(
                turf.booleanPointInPolygon(turf.point(npSeekerPt), sameTrue),
            ).toBe(true);
            expect(turf.booleanPointInPolygon(probeNear2, sameTrue)).toBe(
                false,
            );

            const sameFalse = (await evaluateMatchingOperator({
                evaluator,
                datasets: npDatasets,
                data: { lat: npSeekerPt[1], lng: npSeekerPt[0], same: false },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;
            expect(
                turf.booleanPointInPolygon(turf.point(npSeekerPt), sameFalse),
            ).toBe(false);
            expect(turf.booleanPointInPolygon(probeNear2, sameFalse)).toBe(
                true,
            );
        });

        it("single-source line fast path preserves entire play area when same=true and far hider survives", async () => {
            const singleLine = turf.lineString([
                [5.0, 50.0],
                [5.0, 50.01],
            ]);
            const singleLineDatasets = {
                lines: {
                    kind: "inline",
                    features: turf.featureCollection([singleLine]),
                },
            };
            const singleSeekerPt = [5.001, 50.005];
            const farHiderPt = [4.6, 50.0]; // 40 km away, still within play area

            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([4.5, 49.5, 5.5, 50.5]),
            ]);

            const sameTrue = (await evaluateMatchingOperator({
                evaluator,
                datasets: singleLineDatasets,
                data: {
                    lat: singleSeekerPt[1],
                    lng: singleSeekerPt[0],
                    same: true,
                },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;
            expect(
                turf.booleanPointInPolygon(
                    turf.point(singleSeekerPt),
                    sameTrue,
                ),
            ).toBe(true);
            expect(
                turf.booleanPointInPolygon(turf.point(farHiderPt), sameTrue),
            ).toBe(true);
        });

        it("far candidate 40km away within play area remains for same=true across competing lines", async () => {
            const playAreaMap = turf.featureCollection([
                turf.bboxPolygon([4.5, 49.5, 5.5, 50.5]),
            ]);
            const seekerPt = [5.003, 50.005]; // closer to line 1
            const farCandidatePt = [4.6, 50.0]; // 40 km away from lines, closer to line 1 than line 2

            const d1 = turf.pointToLineDistance(
                turf.point(farCandidatePt),
                line1,
                { units: "kilometers" },
            );
            const d2 = turf.pointToLineDistance(
                turf.point(farCandidatePt),
                line2,
                { units: "kilometers" },
            );
            expect(d1).toBeLessThan(d2);

            const sameTrue = (await evaluateMatchingOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], same: true },
                mapGeoData: playAreaMap,
            })) as Feature<Polygon | MultiPolygon>;
            expect(
                turf.booleanPointInPolygon(turf.point(seekerPt), sameTrue),
            ).toBe(true);
            expect(
                turf.booleanPointInPolygon(
                    turf.point(farCandidatePt),
                    sameTrue,
                ),
            ).toBe(true);

            const sameFalse = (await evaluateMatchingOperator({
                evaluator,
                datasets,
                data: { lat: seekerPt[1], lng: seekerPt[0], same: false },
                mapGeoData: playAreaMap,
            })) as Feature<Polygon | MultiPolygon>;
            expect(
                turf.booleanPointInPolygon(turf.point(seekerPt), sameFalse),
            ).toBe(false);
            expect(
                turf.booleanPointInPolygon(
                    turf.point(farCandidatePt),
                    sameFalse,
                ),
            ).toBe(false);
        });
    });
    describe("filterZoneIndexes API", () => {
        const c1 = turf.circle([5.0, 50.0], 1, { units: "kilometers" });
        const c2 = turf.circle([6.0, 50.0], 1, { units: "kilometers" });
        const c3 = turf.circle([7.0, 50.0], 1, { units: "kilometers" });
        const circles = [c1, c2, c3];

        const reg1 = turf.featureCollection([
            turf.bboxPolygon([4.9, 49.9, 6.1, 50.1]),
        ]);

        it("returns surviving circle indexes", async () => {
            const surviving = await filterZoneIndexes(circles, [reg1]);
            expect(surviving).toEqual([0, 1]);
        });

        it("returns empty array for empty circles", async () => {
            const surviving = await filterZoneIndexes([], [reg1]);
            expect(surviving).toEqual([]);
        });

        it("returns all indexes for empty regions", async () => {
            const surviving = await filterZoneIndexes(circles, []);
            expect(surviving).toEqual([0, 1, 2]);
        });

        it("returns empty array when a region has no features", async () => {
            const emptyReg = turf.featureCollection<Polygon | MultiPolygon>([]);
            const surviving = await filterZoneIndexes(circles, [
                reg1,
                emptyReg,
            ]);
            expect(surviving).toEqual([]);
        });

        it("prunes disjoint circles", async () => {
            const disjointReg = turf.featureCollection([
                turf.bboxPolygon([10, 10, 11, 11]),
            ]);
            const surviving = await filterZoneIndexes(circles, [disjointReg]);
            expect(surviving).toEqual([]);
        });

        it("rejects on malformed geometry without silent fallback", async () => {
            const malformedReg = {
                type: "FeatureCollection" as const,
                features: [
                    {
                        type: "Feature" as const,
                        geometry: null as never,
                        properties: {},
                    },
                ],
            };
            await expect(
                filterZoneIndexes(circles, [malformedReg as never]),
            ).rejects.toThrow();
        });
    });
    describe("Reviewer-confirmed defects regressions", () => {
        it("includes actual compiled.playArea and site extent in matching domain rather than truncating to viewport compiled.bounds", async () => {
            const site1 = turf.point([4.2, 49.2], { id: "s1" });
            const site2 = turf.point([5.8, 50.8], { id: "s2" });
            const definition = {
                id: "matching-domain-test",
                name: "Matching domain test",
                serverId: "home-games",
                map: {
                    center: [5.05, 50.05],
                    bounds: [5.0, 50.0, 5.1, 50.1],
                    playArea: turf.featureCollection([
                        turf.bboxPolygon([4.0, 49.0, 6.0, 51.0]),
                    ]),
                },
                hidingZones: {
                    radius: 400,
                    unit: "meters",
                    features: turf.featureCollection([]),
                },
                features: [
                    {
                        name: "Sites",
                        enabledFor: ["matching"],
                        data: turf.featureCollection([site1, site2]),
                    },
                ],
            };
            // Turf's general GeoJSON positions are wider than the validated
            // coordinate tuples accepted by the game definition.
            setActiveGameDefinition(definition as unknown as GameDefinition);
            try {
                const compiled = compiledGameAtom.get()!;
                const datasets = compiled.datasets;
                const evaluator =
                    compiled.questionMap.get("matching-sites")!.evaluator;

                const geom = await determineMatchingGeometry({
                    evaluator,
                    datasets,
                    data: { lat: 49.2, lng: 4.2 },
                });
                expect(geom).toBeDefined();

                // Candidate outside the viewport [5.0, 50.0, 5.1, 50.1] but inside playArea near site 1
                const candidate = turf.point([4.1, 49.1]);
                expect(
                    turf.booleanPointInPolygon(candidate, geom!.region),
                ).toBe(true);
            } finally {
                setActiveGameDefinition(null);
            }
        });

        it("world fallback covers caller domain rather than silently clipping to POI bbox", () => {
            const pts = turf.featureCollection([
                turf.point([5.6, 50.8], {}, { id: "p1" }),
                turf.point([5.7, 50.8], {}, { id: "p2" }),
                turf.point([5.8, 50.8], {}, { id: "p3" }),
            ]);
            const worldBbox: [number, number, number, number] = [
                -180, -85, 180, 85,
            ];
            const res = geoSpatialVoronoiSafe(pts, worldBbox);
            const bbox = turf.bbox(res);
            expect(bbox[0]).toBe(-180);
            expect(bbox[1]).toBe(-85);
            expect(bbox[2]).toBe(180);
            expect(bbox[3]).toBe(85);

            // Worldwide probes outside the local consulate cluster
            for (const [lng, lat] of [
                [-170, 80],
                [-74, 40], // New York
                [0, 51.5], // London
                [2.3, 48.8], // Paris
                [139.7, 35.7], // Tokyo
                [151.2, -33.8], // Sydney
            ]) {
                const pt = turf.point([lng, lat]);
                const containing = res.features.filter((f) =>
                    turf.booleanPointInPolygon(pt, f),
                );
                expect(containing.length).toBeGreaterThanOrEqual(1);
            }
        });

        it("honors first-containing-region ownership for overlapping and nested regions in own-region measuring", async () => {
            // Region 0: [0, 0] to [10, 10]
            const r0 = turf.polygon([
                [
                    [0, 0],
                    [10, 0],
                    [10, 10],
                    [0, 10],
                    [0, 0],
                ],
            ]);
            // Region 1: Overlaps Region 0 from x=5 to 10
            const r1 = turf.polygon([
                [
                    [5, 0],
                    [15, 0],
                    [15, 10],
                    [5, 10],
                    [5, 0],
                ],
            ]);
            // Region 2: Nested inside Region 0 from [2, 2] to [4, 4]
            const r2 = turf.polygon([
                [
                    [2, 2],
                    [4, 2],
                    [4, 4],
                    [2, 4],
                    [2, 2],
                ],
            ]);
            const datasets = {
                regions: {
                    kind: "inline",
                    features: turf.featureCollection([r0, r1, r2]),
                },
            };
            const evaluator = {
                operator: "distance-to-containing-region-boundary",
                source: { kind: "dataset", datasetId: "regions" },
            } as const;
            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([-5, -5, 20, 15]),
            ]);

            // Seeker in Region 0 at [1, 5]: distance to Region 0 boundary is 1 (approx 69 miles)
            // Candidate H1 at [6, 5]: inside Region 0 (distance to r0 boundary = 4) and Region 1 (distance to r1 boundary = 1).
            // First-containing region is Region 0! In Region 0, distance 4 > seekerDistance 1 -> H1 is farther.
            const closerRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: { lat: 5, lng: 1, hiderCloser: true },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;
            const h1 = turf.point([6, 5]);
            expect(turf.booleanPointInPolygon(h1, closerRes)).toBe(false);

            const fartherRes = (await evaluateMeasuringOperator({
                evaluator,
                datasets,
                data: { lat: 5, lng: 1, hiderCloser: false },
                mapGeoData,
            })) as Feature<Polygon | MultiPolygon>;
            expect(turf.booleanPointInPolygon(h1, fartherRes)).toBe(true);

            // Candidate H2 in nested Region 2 at [3, 3]: belongs to Region 0 because Region 0 precedes Region 2.
            // Distance to Region 0 boundary is 3 > seekerDistance 1 -> H2 is farther.
            const h2 = turf.point([3, 3]);
            expect(turf.booleanPointInPolygon(h2, closerRes)).toBe(false);
            expect(turf.booleanPointInPolygon(h2, fartherRes)).toBe(true);
        });

        it("reuses derived buffers across repeated answers with >32 regions without unbounded drag retention", async () => {
            const arcBufferMock = arcBuffer as unknown as Mock;

            // 40 non-overlapping regions
            const regions: Region[] = [];
            for (let i = 0; i < 40; i++) {
                const x = i * 2;
                regions.push(
                    turf.polygon([
                        [
                            [x, 0],
                            [x + 1.5, 0],
                            [x + 1.5, 10],
                            [x, 10],
                            [x, 0],
                        ],
                    ]),
                );
            }
            const datasets = {
                manyRegions: {
                    kind: "inline",
                    features: turf.featureCollection(regions),
                },
            };
            const evaluator = {
                operator: "distance-to-containing-region-boundary",
                source: { kind: "dataset", datasetId: "manyRegions" },
            } as const;
            const mapGeoData = turf.featureCollection([
                turf.bboxPolygon([-5, -5, 100, 15]),
            ]);

            arcBufferMock.mockClear();

            // First call: computes buffers for all 40 regions
            const params = {
                evaluator,
                datasets,
                data: { lat: 5, lng: 0.5, hiderCloser: true },
                mapGeoData,
            };
            const first = await evaluateMeasuringOperator(params);
            expect(first).toBeDefined();
            const initialCalls = arcBufferMock.mock.calls.length;
            expect(initialCalls).toBe(40);

            // Repeated identical answer (e.g. preview then evaluate, or repeated query):
            // Must reuse expensive derived buffers and aggregate with 0 additional buffer calls!
            await determineMeasuringGeometry(params);
            await evaluateMeasuringOperator(params);
            expect(arcBufferMock.mock.calls.length).toBe(initialCalls);

            // Continuous drag across 15 positions: verify execution succeeds without error
            for (let step = 1; step <= 15; step++) {
                await evaluateMeasuringOperator({
                    ...params,
                    data: {
                        lat: 5,
                        lng: 0.5 + step * 0.01,
                        hiderCloser: true,
                    },
                });
            }
        });

        it("answers a seeker between staggered samples of 1m-separated parallel lines by its own nearest line", async () => {
            const dLng = 1 / 111320; // ~1 meter separation at equator
            const dLatStagger = 2.5 / 111320; // 2.5m stagger
            const line1 = turf.lineString([
                [0, 0],
                [0, 0.01],
            ]);
            const line2 = turf.lineString([
                [dLng, dLatStagger],
                [dLng, 0.01 + dLatStagger],
            ]);
            const datasets = {
                lines: {
                    kind: "inline",
                    features: turf.featureCollection([line1, line2]),
                },
            };
            const evaluator = {
                operator: "nearest-feature-match",
                source: { kind: "dataset", datasetId: "lines" },
            } as const;

            for (let i = 0; i < 20; i++) {
                const lat = 0.001 + (i * 0.008) / 20;
                const geom = await determineMatchingGeometry({
                    evaluator,
                    datasets,
                    data: { lat, lng: 0 },
                });
                expect(
                    turf.booleanPointInPolygon(
                        turf.point([0, lat]),
                        geom!.region,
                    ),
                ).toBe(true);
            }
        });

        it("filters zone indexes with parity across multi-feature regions without unnecessary union", async () => {
            const c1 = turf.circle([5.0, 50.0], 1, { units: "kilometers" });
            const c2 = turf.circle([6.0, 50.0], 1, { units: "kilometers" });
            const c3 = turf.circle([7.0, 50.0], 1, { units: "kilometers" });
            const circles = [c1, c2, c3];

            // Multi-feature region: two disjoint boxes
            const multiReg = turf.featureCollection([
                turf.bboxPolygon([4.9, 49.9, 5.1, 50.1]),
                turf.bboxPolygon([5.9, 49.9, 6.1, 50.1]),
            ]);

            const surviving = await filterZoneIndexes(circles, [multiReg]);
            expect(surviving).toEqual([0, 1]);
        });
    });
});
