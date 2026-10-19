import "./arcgisNode";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    type GameDefinition,
    validateGameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";
import { calculateFilterZoneIndexes } from "@/maps/geo-utils/zoneFilter";
import { borderNetwork } from "@/maps/questions/operators/geometry";
import { evaluateMeasuringOperator } from "@/maps/questions/operators/measuring";

type Region = Feature<Polygon | MultiPolygon>;

describe("borderNetwork", () => {
    it("keeps a border two regions share once", () => {
        const network = borderNetwork([
            turf.bboxPolygon([0, 0, 1, 1]) as Region,
            turf.bboxPolygon([1, 0, 2, 1]) as Region,
        ]);
        const edges = network.geometry.coordinates.reduce(
            (sum, path) => sum + path.length - 1,
            0,
        );
        // Four edges each, less the one they share.
        expect(edges).toBe(7);
    });
});

describe("distance to a boundary on a layer marked noOverlaps", () => {
    const belgium = JSON.parse(
        readFileSync(
            resolve(
                __dirname,
                "../../../games/preloaded/belgium-2026.game.json",
            ),
            "utf8",
        ),
    ) as GameDefinition;
    const unmarked = structuredClone(belgium);
    for (const layer of unmarked.features!) delete layer.noOverlaps;
    const marked = compileGameDefinition(belgium);
    const perRegion = compileGameDefinition(unmarked);

    // Brussels, an enclave in no province, and its surroundings.
    const map = turf.featureCollection([
        turf.intersect(
            turf.featureCollection([
                belgium.map.playArea!.features[0] as Region,
                turf.bboxPolygon([4.0, 50.7, 4.65, 51.0]),
            ]),
        )!,
    ]);
    const circles = hidingZoneCircles(marked);

    const answer = async (
        compiled: typeof marked,
        seeker: { lat: number; lng: number },
        hiderCloser: boolean,
    ) => {
        const result = await evaluateMeasuringOperator({
            evaluator:
                compiled.questionMap.get("measuring-province")!.evaluator,
            datasets: compiled.datasets,
            data: { ...seeker, hiderCloser },
            mapGeoData: map,
        });
        return turf.featureCollection(
            (result && "features" in result
                ? result.features
                : [result]
            ).filter(Boolean) as Region[],
        );
    };

    it("is marked in the preloaded file", () => {
        expect(validateGameDefinition(belgium).valid).toBe(true);
        expect(
            belgium.features!.find((layer) => layer.name === "Province")!
                .noOverlaps,
        ).toBe(true);
    });

    it.each([
        [
            "Ninove, a kilometre from its border",
            { lat: 50.839463, lng: 4.026178 },
        ],
        ["Leuven, inside a province", { lat: 50.8798, lng: 4.7005 }],
        ["Bordet, in Brussels", { lat: 50.877257, lng: 4.409532 }],
    ])(
        "matches measuring to each region's own boundary, from %s",
        async (_, seeker) => {
            for (const hiderCloser of [true, false]) {
                const network = await answer(marked, seeker, hiderCloser);
                const regions = await answer(perRegion, seeker, hiderCloser);
                // The same zones are left.
                expect(calculateFilterZoneIndexes(circles, [network])).toEqual(
                    calculateFilterZoneIndexes(circles, [regions]),
                );
                // And the same ground, to within the buffers' tolerance
                // along the outline.
                const a = network.features[0];
                const b = regions.features[0];
                const apart =
                    turf.area(
                        turf.difference(turf.featureCollection([a, b])) ??
                            turf.polygon([]),
                    ) +
                    turf.area(
                        turf.difference(turf.featureCollection([b, a])) ??
                            turf.polygon([]),
                    );
                const outline = turf.length(turf.polygonToLine(b) as never, {
                    units: "meters",
                });
                expect(apart / outline).toBeLessThan(1);
            }
        },
        120_000,
    );
});
