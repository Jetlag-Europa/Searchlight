import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    validateGameDefinition,
    type GameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as GeoUtils from "@/maps/geo-utils";

// ArcGIS's geodesic buffers and distances need browser WASM; Turf's agree
// with each other, which is what map and answer agreement needs.
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcBuffer: async (
            fc: FeatureCollection,
            distance: number,
            unit: turf.Units = "miles",
        ) => actual.safeUnion(turf.buffer(fc, distance, { units: unit })!),
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
                    turf.pointToLineDistance(
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

import {
    setActiveGameDefinition,
    compiledGameAtom,
} from "@/game-definition/store";
import { hiderMode } from "@/lib/context";
import { hiderifyQuestion } from "@/maps";
import { measuringQuestionSchema } from "@/maps/schema";
import { evaluateMeasuringOperator } from "@/maps/questions/operators/measuring";

const belgium = JSON.parse(
    readFileSync(
        resolve(
            __dirname,
            "../../../../games/preloaded/belgium-2026.game.json",
        ),
        "utf8",
    ),
) as GameDefinition;
// Measured region by region, as layers not marked noOverlaps are; the
// network path for marked layers has its own test (borderNetwork.test.ts),
// with real buffers rather than Turf's, which run out of memory on it.
for (const layer of belgium.features ?? []) delete layer.noOverlaps;

// Hainaut along the French border, as reported: Belgium's play area follows
// the border more closely than its provinces do, leaving slivers in neither.
const AREA = turf.bboxPolygon([3.6, 50.15, 4.6, 50.55]);
const SEEKER = { lat: 50.36298, lng: 4.28467 };

describe("Belgium province boundary measuring", () => {
    let provinces: Feature<Polygon | MultiPolygon>[];
    let map: FeatureCollection<Polygon | MultiPolygon>;
    let seekerDistance: number;

    /** Each point's own province boundary, or the nearest one outside them all. */
    const boundaryDistance = (point: Feature<Point>) => {
        const own = provinces.find((province) =>
            turf.booleanPointInPolygon(point, province),
        );
        let nearest = Infinity;
        for (const province of own ? [own] : provinces) {
            turf.flattenEach(turf.polygonToLine(province), (line) => {
                nearest = Math.min(
                    nearest,
                    turf.pointToLineDistance(
                        point,
                        line as Feature<LineString>,
                        {
                            units: "miles",
                        },
                    ),
                );
            });
        }
        return nearest;
    };

    const answer = async (point: Feature<Point>) => {
        const [longitude, latitude] = point.geometry.coordinates;
        hiderMode.set({ latitude, longitude });
        const question = {
            id: "measuring" as const,
            data: measuringQuestionSchema.parse({
                ...SEEKER,
                type: "measuring-province",
                drag: true,
            }),
        };
        await hiderifyQuestion(question as never);
        return question.data.hiderCloser;
    };

    const mask = async (hiderCloser: boolean) => {
        const compiled = compiledGameAtom.get()!;
        const result = await evaluateMeasuringOperator({
            evaluator:
                compiled.questionMap.get("measuring-province")!.evaluator,
            datasets: compiled.datasets,
            data: { ...SEEKER, hiderCloser },
            mapGeoData: map,
        });
        return turf.featureCollection(
            (result as FeatureCollection<Polygon | MultiPolygon>).features ?? [
                result,
            ],
        );
    };

    const inside = (
        point: Feature<Point>,
        area: FeatureCollection<Polygon | MultiPolygon>,
    ) =>
        area.features.some((feature) =>
            turf.booleanPointInPolygon(point, feature),
        );

    beforeAll(() => {
        const validation = validateGameDefinition(belgium);
        if (!validation.valid)
            throw new Error(JSON.stringify(validation.errors));
        setActiveGameDefinition(belgium);
        provinces = (
            belgium.features!.find((feature) => feature.name === "Province")!
                .data as FeatureCollection<Polygon | MultiPolygon>
        ).features;
        const playArea = turf.intersect(
            turf.featureCollection([
                belgium.map.playArea!.features[0] as Feature<
                    Polygon | MultiPolygon
                >,
                AREA,
            ]),
        )!;
        map = turf.featureCollection([playArea]);
        seekerDistance = boundaryDistance(turf.point([SEEKER.lng, SEEKER.lat]));
    });

    it("eliminates the play area outside every province along the border when the hider is farther", async () => {
        const slivers = turf.difference(
            turf.featureCollection([
                map.features[0],
                ...provinces.filter((province) =>
                    turf.booleanIntersects(province, AREA),
                ),
            ]),
        );
        const sliverPoints = turf
            .flatten(slivers!)
            .features.filter((piece) => turf.area(piece) > 1_000)
            .map((piece) => turf.pointOnFeature(piece))
            // Off the edges, where clipping can leave a point in both masks
            // or neither: of the map, and of the provinces (their own seams
            // are hairline slivers).
            .filter(
                (point) =>
                    turf.booleanPointInPolygon(point, map.features[0], {
                        ignoreBoundary: true,
                    }) && boundaryDistance(point) > 0.01,
            );
        expect(sliverPoints.length).toBeGreaterThan(10);

        const farther = await mask(false);
        const closer = await mask(true);
        for (const point of sliverPoints) {
            // Slivers hug the border, far nearer it than the seeker.
            expect(boundaryDistance(point)).toBeLessThan(seekerDistance / 2);
            expect(inside(point, farther)).toBe(false);
            expect(inside(point, closer)).toBe(true);
            expect(await answer(point)).toBe(true);
        }
    }, 120_000);

    it("eliminates exactly where the hider's answer says it cannot be", async () => {
        const farther = await mask(false);
        const closer = await mask(true);
        let checked = 0;
        for (const point of turf.pointGrid(turf.bbox(AREA), 3, {
            units: "kilometers",
            mask: map.features[0],
        }).features) {
            const distance = boundaryDistance(point);
            // Turf's buffers are polygons, not exact curves.
            if (Math.abs(distance - seekerDistance) < 0.05) continue;
            const isCloser = distance < seekerDistance;
            expect(await answer(point)).toBe(isCloser);
            expect(inside(point, closer)).toBe(isCloser);
            expect(inside(point, farther)).toBe(!isCloser);
            checked++;
        }
        expect(checked).toBeGreaterThan(200);
    }, 120_000);

    it("leaves no slivers along the seams between provinces", async () => {
        const compiled = compiledGameAtom.get()!;
        const result = (await evaluateMeasuringOperator({
            evaluator:
                compiled.questionMap.get("measuring-province")!.evaluator,
            datasets: compiled.datasets,
            data: { ...SEEKER, hiderCloser: false },
            mapGeoData: compiled.playArea,
        })) as Feature<Polygon | MultiPolygon>;
        // What survives is the provinces' far interiors and the open sea:
        // a few large areas, no needles along the provinces' shared edges.
        const pieces = turf.flatten(result).features;
        const slivers = pieces.filter((piece) => turf.area(piece) < 100_000);
        expect(slivers.map((piece) => turf.centroid(piece).geometry)).toEqual(
            [],
        );
        expect(pieces.length).toBeLessThan(20);
    }, 120_000);
});
