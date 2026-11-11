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
    answerAsHider,
    computePerQuestionRegions,
    determinePlanningPolygon,
    planningOutlines,
} from "@/maps";
import type * as GeoUtils from "@/maps/geo-utils";

// Radars of these radii stand in for geometry that fails, so the test can
// tell how the map's per-question regions handle each kind of failure.
const SUPERSEDED_RADIUS = 7;
const FAILS_ONCE_RADIUS = 8;
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
    const definition = JSON.parse(
        readFileSync(
            resolve(
                process.cwd(),
                "../../games/preloaded/stockholm-2026.game.json",
            ),
            "utf8",
        ),
    );
    setActiveGameDefinition(definition);
    const compiled = compiledGameAtom.get()!;
    polyGeoJSON.set(compiled.playArea);
    return compiled;
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
        color: "red",
        collapsed: false,
        enabled: true,
        ...data,
    },
});

const area = (region: any) => turf.area(region);

describe("a radar that can't be drawn", () => {
    for (const [label, data] of [
        ["radius 0", { radius: 0 }],
        ["radius -1", { radius: -1 }],
        ["radius null", { radius: null }],
        ["radius NaN", { radius: Number.NaN }],
        ["no latitude", { lat: undefined }],
    ] as const) {
        it(`${label} eliminates nothing, and the other radar still draws`, async () => {
            const compiled = loadStockholm();
            const base = compiled.playArea;
            const kept = filterSupportedQuestions(
                [radar(1), radar(2, data)],
                compiled,
            );
            expect(kept).toHaveLength(2);

            const regions = await computePerQuestionRegions(
                kept as never,
                base,
                false,
            );

            expect(regions).toHaveLength(2);
            expect(area(regions[0].region)).toBeLessThan(area(base) / 2);
            expect(area(regions[1].region)).toBeCloseTo(area(base), -3);
        });
    }

    it("outlines nothing in planning mode for a radius of 0 or less", async () => {
        loadStockholm();
        for (const radius of [0, -1, null]) {
            const question = radar(1, { radius, drag: true });
            expect(
                await determinePlanningPolygon(question, true),
            ).toBeUndefined();
        }
    });

    it("still lets a superseded request start the refresh over", async () => {
        const compiled = loadStockholm();
        await expect(
            computePerQuestionRegions(
                [radar(1), radar(2, { radius: SUPERSEDED_RADIUS })],
                compiled.playArea,
                false,
            ),
        ).rejects.toBeInstanceOf(SupersededError);
    });

    it("is drawn once its geometry works again: the failure isn't cached", async () => {
        const compiled = loadStockholm();
        const base = compiled.playArea;
        const questions = [radar(1, { radius: FAILS_ONCE_RADIUS })];

        failOnce = true;
        const failed = await computePerQuestionRegions(questions, base, false);
        expect(area(failed[0].region)).toBeCloseTo(area(base), -3);

        const drawn = await computePerQuestionRegions(questions, base, false);
        expect(area(drawn[0].region)).toBeLessThan(area(base) / 2);
    });

    it("lets a failed geometry worker stop the map: it isn't the question's doing", async () => {
        const compiled = loadStockholm();
        const failing = [radar(1), radar(2, { radius: WORKER_FAILS_RADIUS })];
        await expect(
            computePerQuestionRegions(failing, compiled.playArea, false),
        ).rejects.toBeInstanceOf(GeometryWorkerError);
        await expect(
            planningOutlines(
                failing.map((question) => ({
                    ...question,
                    data: { ...question.data, drag: true },
                })),
                true,
            ),
        ).rejects.toBeInstanceOf(GeometryWorkerError);
    });
});

describe("an unlocked question that can't be drawn", () => {
    // Unlocked questions take the planning outline and hider answering
    // passes, which run before and after the regions.
    const malformed = () => radar(2, { drag: true, lat: undefined });

    it("gets no planning outline, and the others still get theirs", async () => {
        loadStockholm();
        const outlines = await planningOutlines(
            [radar(1, { drag: true }), malformed(), radar(3, { drag: true })],
            true,
        );
        expect(outlines.map(({ question }) => question.key)).toEqual([1, 3]);
    });

    it("isn't answered in hider mode, eliminates nothing, and the others are answered", async () => {
        const compiled = loadStockholm();
        const base = compiled.playArea;
        // The hider is 1 km from the radars' centre, outside them.
        hiderMode.set({ latitude: 59.339, longitude: 18.06 });
        const questions: any[] = [
            radar(1, { drag: true, radius: 0.5 }),
            malformed(),
        ];

        const unanswered = await answerAsHider(questions);

        expect([...unanswered]).toEqual([questions[1]]);
        expect(questions[0].data.within).toBe(false);
        // Left as it was, so the card keeps what it showed.
        expect(questions[1].data).toEqual(malformed().data);

        const regions = await computePerQuestionRegions(
            questions,
            base,
            false,
            undefined,
            unanswered,
        );
        expect(regions).toHaveLength(2);
        expect(area(regions[0].region)).toBeLessThan(area(base));
        expect(area(regions[0].region)).toBeGreaterThan(area(base) / 2);
        expect(area(regions[1].region)).toBeCloseTo(area(base), -3);
    });

    it("still lets a superseded request start the refresh over", async () => {
        loadStockholm();
        await expect(
            planningOutlines(
                [radar(1, { drag: true, radius: SUPERSEDED_RADIUS })],
                true,
            ),
        ).rejects.toBeInstanceOf(SupersededError);
    });
});
