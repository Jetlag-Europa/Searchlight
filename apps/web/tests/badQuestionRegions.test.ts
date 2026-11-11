import "./arcgisNode";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { hiderMode, polyGeoJSON } from "@/lib/context";
import {
    computePerQuestionRegions,
    determinePlanningPolygon,
    hiderifyQuestion,
} from "@/maps";
import type * as GeoUtils from "@/maps/geo-utils";

// Radars of these radii stand in for geometry that fails in each way.
const FAILS_ONCE_RADIUS = 8;
const SUPERSEDED_RADIUS = 7;
const WORKER_FAILS_RADIUS = 9;
let failOnce = false;
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        arcBuffer: async (...args: Parameters<typeof actual.arcBuffer>) => {
            if (args[1] === SUPERSEDED_RADIUS)
                throw new actual.SupersededError();
            if (args[1] === WORKER_FAILS_RADIUS)
                throw new actual.GeometryWorkerError();
            if (args[1] === FAILS_ONCE_RADIUS && failOnce) {
                failOnce = false;
                throw new Error("Geometry failed");
            }
            return actual.arcBuffer(...args);
        },
    };
});

const { GeometryWorkerError, SupersededError } = await import(
    "@/maps/geo-utils"
);

function loadStockholm() {
    setActiveGameDefinition(
        JSON.parse(
            readFileSync(
                resolve(
                    process.cwd(),
                    "../../games/preloaded/stockholm-2026.game.json",
                ),
                "utf8",
            ),
        ),
    );
    const compiled = compiledGameAtom.get()!;
    polyGeoJSON.set(compiled.playArea);
    return compiled.playArea;
}

afterEach(() => {
    setActiveGameDefinition(null);
    hiderMode.set(false);
});

const radar = (key: number, data: Record<string, unknown> = {}): any => ({
    id: "radius",
    key,
    data: {
        lat: 59.33,
        lng: 18.06,
        radius: 5,
        unit: "kilometers",
        within: true,
        drag: false,
        ...data,
    },
});

const area = (region: any) => turf.area(region);

describe("a radar with a radius of 0 or less, or none", () => {
    for (const radius of [0, -1, null]) {
        it(`(${radius}) eliminates nothing, and the other radar still draws, also in hider mode`, async () => {
            const base = loadStockholm();
            for (const hider of [
                false,
                { latitude: 59.33, longitude: 18.06 },
            ] as const) {
                hiderMode.set(hider);
                const questions = filterSupportedQuestions(
                    [radar(1), radar(2, { radius })],
                    compiledGameAtom.get()!,
                ) as any[];
                expect(questions).toHaveLength(2);
                for (const question of questions)
                    await hiderifyQuestion(question);

                const regions = await computePerQuestionRegions(
                    questions,
                    base,
                    false,
                );
                expect(area(regions[0].region)).toBeLessThan(area(base) / 2);
                expect(area(regions[1].region)).toBeCloseTo(area(base), -3);
            }
        });

        it(`(${radius}) has no planning outline`, async () => {
            loadStockholm();
            expect(
                await determinePlanningPolygon(
                    radar(1, { radius, drag: true }),
                    true,
                ),
            ).toBeUndefined();
        });
    }
});

describe("a question whose geometry fails", () => {
    it("eliminates nothing, uncached, so it's drawn once it works again", async () => {
        const base = loadStockholm();
        const questions = [radar(1, { radius: FAILS_ONCE_RADIUS })];
        failOnce = true;
        const [failed] = await computePerQuestionRegions(
            questions,
            base,
            false,
        );
        expect(area(failed.region)).toBeCloseTo(area(base), -3);
        const [drawn] = await computePerQuestionRegions(questions, base, false);
        expect(area(drawn.region)).toBeLessThan(area(base) / 2);
    });

    it("still stops the refresh when superseded or the worker failed", async () => {
        const base = loadStockholm();
        for (const [radius, error] of [
            [SUPERSEDED_RADIUS, SupersededError],
            [WORKER_FAILS_RADIUS, GeometryWorkerError],
        ] as const)
            await expect(
                computePerQuestionRegions(
                    [radar(1), radar(2, { radius })],
                    base,
                    false,
                ),
            ).rejects.toBeInstanceOf(error);
    });
});
