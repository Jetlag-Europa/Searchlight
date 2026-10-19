import "./arcgisNode";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    type GameDefinition,
    validateGameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon, Position } from "geojson";
import { describe, expect, it } from "vitest";

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { calculateBuffer } from "@/maps/geo-utils/bufferGeometry";
import { ringsToMultiPolygon } from "@/maps/geo-utils/polygonRings";
import { regionLines } from "@/maps/questions/operators/geometry";
import { evaluateMeasuringOperator } from "@/maps/questions/operators/measuring";

const belgium = JSON.parse(
    readFileSync(
        resolve(__dirname, "../../../games/preloaded/belgium-2026.game.json"),
        "utf8",
    ),
) as GameDefinition;
// The Grand-Place, some 4 km inside Brussels's boundary.
const GRAND_PLACE = turf.point([4.3525, 50.8467]);

/** A square ring, clockwise as ArcGIS runs outer rings, or not. */
function square(size: number, clockwise: boolean): Position[] {
    const ring = [
        [-size, -size],
        [-size, size],
        [size, size],
        [size, -size],
        [-size, -size],
    ];
    return clockwise ? ring : ring.reverse();
}

describe("ringsToMultiPolygon", () => {
    it("gives each hole to the smallest outer ring around it", () => {
        // A band around a region (4 and its hole 3) and a band around its
        // enclave (2 and its hole 1), listed from the inside out.
        const polygons = ringsToMultiPolygon([
            square(1, false),
            square(2, true),
            square(3, false),
            square(4, true),
        ]);
        const multi = turf.multiPolygon(polygons);
        expect(polygons).toHaveLength(2);
        expect(polygons.map((polygon) => polygon.length)).toEqual([2, 2]);
        for (const [point, inside] of [
            [[0, 0], false],
            [[1.5, 0], true],
            [[2.5, 0], false],
            [[3.5, 0], true],
        ] as const) {
            expect(turf.booleanPointInPolygon([...point], multi)).toBe(inside);
        }
    });

    it("runs rings the GeoJSON way", () => {
        const [[outer, hole]] = ringsToMultiPolygon([
            square(2, true),
            square(1, false),
        ]);
        expect(turf.booleanClockwise(outer)).toBe(false);
        expect(turf.booleanClockwise(hole)).toBe(true);
    });

    it("keeps a hole that touches its outer ring at a vertex", () => {
        const polygons = ringsToMultiPolygon([
            square(2, true),
            [
                [-2, -2],
                [1, 0],
                [0, 1],
                [-2, -2],
            ],
        ]);
        expect(polygons).toHaveLength(1);
        expect(polygons[0]).toHaveLength(2);
    });
});

describe("buffers of a region with an enclave", () => {
    it("leave the enclave's middle out", async () => {
        // Brussels is a hole in Flemish Brabant.
        const provinces = belgium.features!.find(
            (layer) => layer.name === "Province",
        )!.data as { features: Feature<Polygon | MultiPolygon>[] };
        const flemishBrabant = provinces.features.find(
            (feature) => feature.properties?.name === "Vlaams-Brabant",
        )!;
        const buffer = await calculateBuffer({
            kind: "radius",
            geometry: regionLines(flemishBrabant),
            distance: 1,
            unit: "kilometers",
            maxDeviation: 1,
        });
        expect(turf.booleanPointInPolygon(GRAND_PLACE, buffer)).toBe(false);
        // Half a kilometre in from the boundary, towards the Grand-Place.
        const boundary = (flemishBrabant.geometry as Polygon).coordinates[1];
        const nearEdge = turf.destination(
            boundary[0],
            0.5,
            turf.bearing(boundary[0], GRAND_PLACE),
        );
        expect(turf.booleanPointInPolygon(nearEdge, buffer)).toBe(true);
    }, 60_000);
});

describe("distance to a province boundary from inside Brussels", () => {
    it("keeps the middle of Brussels when the hider is farther", async () => {
        const validation = validateGameDefinition(belgium);
        if (!validation.valid) {
            throw new Error(JSON.stringify(validation.errors));
        }
        setActiveGameDefinition(belgium);
        const compiled = compiledGameAtom.get()!;
        // Brussels and its surroundings, to keep the buffers few.
        const map = turf.featureCollection([
            turf.intersect(
                turf.featureCollection([
                    belgium.map.playArea!.features[0] as Feature<
                        Polygon | MultiPolygon
                    >,
                    turf.bboxPolygon([4.1, 50.75, 4.6, 50.95]),
                ]),
            )!,
        ]);
        // Ninove, about a kilometre from its province's boundary: the
        // Grand-Place is farther from every province boundary than that.
        const farther = await evaluateMeasuringOperator({
            evaluator:
                compiled.questionMap.get("measuring-province")!.evaluator,
            datasets: compiled.datasets,
            data: { lat: 50.839463, lng: 4.026178, hiderCloser: false },
            mapGeoData: map,
        });
        const pieces = (
            farther && "features" in farther ? farther.features : [farther]
        ) as Feature<Polygon | MultiPolygon>[];
        expect(
            pieces.some((piece) =>
                turf.booleanPointInPolygon(GRAND_PLACE, piece),
            ),
        ).toBe(true);
    }, 120_000);
});
