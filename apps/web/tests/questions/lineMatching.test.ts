import * as turf from "@turf/turf";
import type { GameDefinition } from "@searchlight/shared";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Voronoi from "@/maps/geo-utils/voronoi";

vi.mock("@/maps/geo-utils/voronoi", async (importActual) => {
    const actual = await importActual<typeof Voronoi>();
    return {
        ...actual,
        geoSpatialVoronoiSafe: vi.fn(actual.geoSpatialVoronoiSafe),
    };
});

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { lineSampleStep } from "@/maps/geo-utils/lineVoronoi";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils/voronoi";
import {
    determineMatchingGeometry,
    evaluateMatchingOperator,
} from "@/maps/questions/operators/matching";

const parts = (...lines: [number, number][][]) =>
    lines.map((coordinates, featureOrdinal) => ({
        featureOrdinal,
        line: turf.lineString(coordinates),
    }));

describe("line sample step", () => {
    it("ignores where lines cross or touch", () => {
        const cross = parts(
            [
                [0, -0.05],
                [0, 0.05],
            ],
            [
                [-0.05, 0],
                [0.05, 0],
            ],
        );
        const shareEnd = parts(
            [
                [0, 0],
                [0.1, 0.001],
            ],
            [
                [0, 0],
                [0.1, -0.001],
            ],
        );
        expect(lineSampleStep(cross)).toBe(0.25);
        expect(lineSampleStep(shareEnd)).toBe(0.25);
    });

    it("follows lines that run close without meeting, down to 25 m", () => {
        const apart = (metres: number) =>
            parts(
                [
                    [0, 0],
                    [0.05, 0],
                ],
                [
                    [0, metres / 111_195],
                    [0.05, metres / 111_195],
                ],
            );
        expect(lineSampleStep(apart(150))).toBeCloseTo(0.05, 3);
        expect(lineSampleStep(apart(5))).toBe(0.025);
        // Parts of one feature are the same answer, however close.
        const sameFeature = apart(5).map((part) => ({
            ...part,
            featureOrdinal: 0,
        }));
        expect(lineSampleStep(sameFeature)).toBe(0.25);
    });

    it("spreads a bounded number of samples over long layers", () => {
        const meridians = parts(
            ...Array.from({ length: 20 }, (_, index): [number, number][] => [
                [index, -5],
                [index, 5],
            ]),
        );
        const length = meridians.reduce(
            (sum, { line }) => sum + turf.length(line),
            0,
        );
        expect(lineSampleStep(meridians)).toBeCloseTo(length / 20_000, 6);
    });
});

// The reviewer's reproduction: radial lines meeting at a common terminus.
function radialGame(lineCount: number): GameDefinition {
    const center = [4.35, 50.85];
    const features = Array.from({ length: lineCount }, (_, index) => {
        const angle = (2 * Math.PI * index) / lineCount;
        const coordinates = [center];
        for (let k = 1; k <= 20; k++) {
            coordinates.push([
                center[0] + 0.01 * k * Math.cos(angle),
                center[1] + 0.01 * k * Math.sin(angle),
            ]);
        }
        return turf.lineString(coordinates, { name: `Line ${index}` });
    });
    return {
        name: "Radial lines",
        serverId: "home-games",
        map: {
            center: [4.35, 50.85],
            playArea: turf.featureCollection([
                turf.bboxPolygon([4.1, 50.7, 4.6, 51.0]),
            ]),
        },
        hidingZones: {
            radius: 400,
            unit: "meters",
            features: turf.featureCollection([]),
        },
        features: [
            {
                name: "Rail Line",
                enabledFor: ["matching"],
                data: turf.featureCollection(features),
            },
        ],
    } as unknown as GameDefinition;
}

describe("nearest-line partition", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setActiveGameDefinition(radialGame(8));
    });
    afterEach(() => setActiveGameDefinition(null));

    it("is built once per layer with a step crossings do not shrink, and answers every seeker from it", async () => {
        const compiled = compiledGameAtom.get()!;
        const evaluator = compiled.questionMap.get("matching-rail-line")!
            .evaluator;
        const lines = compiled.definition.features![0].data
            .features as Feature<LineString>[];
        const playArea = compiled.playArea as FeatureCollection<
            Polygon | MultiPolygon
        >;
        const distances = (point: Feature<Point>) =>
            lines.map((line) => turf.pointToLineDistance(point, line));

        for (const [lng, lat] of [
            [4.36, 50.86],
            [4.361, 50.86],
            [4.3, 50.9],
            [4.45, 50.8],
            [4.35, 50.851],
        ]) {
            const seeker = turf.point([lng, lat]);
            const own = distances(seeker).indexOf(
                Math.min(...distances(seeker)),
            );
            const same = await determineMatchingGeometry({
                evaluator,
                datasets: compiled.datasets,
                data: { lat, lng },
                mapGeoData: playArea,
            });
            expect(turf.booleanPointInPolygon(seeker, same!.region)).toBe(
                true,
            );
            const different = (await evaluateMatchingOperator({
                evaluator,
                datasets: compiled.datasets,
                data: { lat, lng, same: false },
                mapGeoData: playArea,
            })) as Feature<Polygon | MultiPolygon>;
            expect(turf.booleanPointInPolygon(seeker, different)).toBe(false);

            // Away from the bisectors the partition is exact.
            for (let x = 4.12; x < 4.6; x += 0.04) {
                for (let y = 50.72; y < 51; y += 0.04) {
                    const probe = turf.point([x, y]);
                    const probeDistances = distances(probe);
                    const nearest = Math.min(...probeDistances);
                    const ownGap = probeDistances[own] - nearest;
                    const otherGap =
                        Math.min(
                            ...probeDistances.filter((_, i) => i !== own),
                        ) - probeDistances[own];
                    if (ownGap > 0.3) {
                        expect(
                            turf.booleanPointInPolygon(probe, same!.region),
                        ).toBe(false);
                    } else if (otherGap > 0.3) {
                        expect(
                            turf.booleanPointInPolygon(probe, same!.region),
                        ).toBe(true);
                    }
                }
            }
        }

        expect(geoSpatialVoronoiSafe).toHaveBeenCalledTimes(1);
        // 8 lines of about 22 km at the 250 m maximum step, not the 3,000
        // samples per line that the crossing used to force.
        const sites = vi.mocked(geoSpatialVoronoiSafe).mock.calls[0][0];
        expect(sites.features.length).toBeLessThan(800);
    });
});
