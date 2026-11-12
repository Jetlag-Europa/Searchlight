import "./arcgisNode";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import { expect, it, vi } from "vitest";

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { hiderMode, mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    computePerQuestionRegions,
    hiderifyQuestion,
    intersectRegions,
} from "@/maps";
import type * as GeoUtils from "@/maps/geo-utils";
import { calculateClip } from "@/maps/geo-utils/clipGeometry";
import { questionSchema } from "@/maps/schema";

let clips = 0;
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof GeoUtils>();
    return {
        ...actual,
        requestGeometry: (request: any, options: any) => {
            if (request.kind === "clip" && request.within) clips++;
            return (actual.requestGeometry as any)(request, options);
        },
    };
});
const { calculateFilterZoneIndexes, hidingZoneCircles } =
    await vi.importActual<typeof GeoUtils>("@/maps/geo-utils");

// A session on a real game: one question of each kind the game offers,
// answered from where a hider stands.
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
const base = compiled.playArea;
polyGeoJSON.set(base);
mapGeoJSON.set(base);
const HIDER = { latitude: 59.3326, longitude: 18.0649 };
const [west, south, east, north] = turf.bbox(base);

function session() {
    return compiled.questions.map(({ id, family }, index) => {
        const at = (step: number) => ({
            lat: south + ((north - south) * (2 + (step % 7))) / 10,
            lng: west + ((east - west) * (2 + (step % 5))) / 8,
        });
        const { lat, lng } = at(index);
        const data: Record<string, any> = {
            radius: { radius: 3 + index, unit: "kilometers" },
            thermometer: {
                latA: lat,
                lngA: lng,
                latB: at(index + 3).lat,
                lngB: at(index + 3).lng,
            },
            tentacle: { radius: 4, unit: "kilometers", locationType: id },
            matching: { type: id },
            measuring: { type: id },
        };
        return questionSchema.parse({
            id: family === "tentacle" ? "tentacles" : family,
            key: index,
            data: { lat, lng, ...data[family] },
        });
    });
}

async function regionsOf(questions: ReturnType<typeof session>) {
    hiderMode.set(HIDER);
    for (const question of questions) await hiderifyQuestion(question);
    return computePerQuestionRegions(questions, base, false);
}

// What the map did before: every region intersected again, in order.
function fromScratch(regions: { region: any }[]) {
    return regions.slice(1).reduce((area, { region }) => {
        const intersection = calculateClip({
            kind: "clip",
            mapData: area,
            modifications: region,
            within: true,
        });
        return turf.featureCollection(intersection ? [intersection] : []);
    }, regions[0].region);
}

function moved<T extends { data: any }>(question: T): T {
    const copy = structuredClone(question);
    if ("lat" in copy.data) copy.data.lat += 0.004;
    else copy.data.latA += 0.004;
    return copy;
}

it("intersects only from the first changed question on, with the same result", async () => {
    let questions = session();
    const count = questions.length;
    expect(count).toBeGreaterThan(8);
    const refresh = async () => {
        const regions = await regionsOf(questions);
        clips = 0;
        const area = await intersectRegions(regions);
        expect(area).toEqual(fromScratch(regions));
        // The hider's own spot always remains.
        expect(area?.features).toHaveLength(1);
        return clips;
    };
    expect(await refresh()).toBe(count - 1);
    // The same answers again, as after a rename or a hider's small move.
    expect(await refresh()).toBe(0);

    questions = [...questions.slice(0, -1), moved(questions[count - 1])];
    expect(await refresh()).toBe(1);

    questions = [...questions, moved(questions[2])];
    expect(await refresh()).toBe(1);

    questions = questions.map((question, index) =>
        index === count - 4 ? moved(question) : question,
    );
    expect(await refresh()).toBe(5);

    questions = questions.filter((_, index) => index !== 3);
    expect(await refresh()).toBe(count - 3);

    // A refresh that became obsolete midway leaves nothing behind.
    questions = [moved(questions[0]), ...questions.slice(1)];
    const regions = await regionsOf(questions);
    expect(await intersectRegions(regions, () => false)).toBeUndefined();
    expect(await refresh()).toBe(count - 1);

    expect(await intersectRegions([])).toBeUndefined();
}, 120_000);

it("keeps every region when the hider moves without changing an answer", async () => {
    const questions = session();
    const first = await regionsOf(questions);
    const answers = JSON.stringify(questions);
    hiderMode.set({ ...HIDER, latitude: HIDER.latitude + 0.0001 });
    for (const question of questions) await hiderifyQuestion(question);
    expect(JSON.stringify(questions)).toBe(answers);
    const again = await computePerQuestionRegions(questions, base, false);
    again.forEach(({ region }, index) =>
        expect(region).toBe(first[index].region),
    );
}, 120_000);

it("finds the same surviving zones as testing each whole region", async () => {
    const regions = (await regionsOf(session())).map(({ region }) => region);
    for (const scale of [0.5, 1, 3]) {
        const circles = hidingZoneCircles(compiled, scale);
        // Region by region, so that no zone is decided by an earlier region.
        for (const region of regions) {
            const whole = circles.flatMap((circle, index) =>
                region.features.some((feature: any) =>
                    turf.booleanIntersects(circle, feature),
                )
                    ? [index]
                    : [],
            );
            expect(calculateFilterZoneIndexes(circles, [region])).toEqual(
                whole,
            );
        }
    }
}, 120_000);

it("drops a zone of radius 0 that lies outside a region", () => {
    const region = turf.featureCollection([
        turf.polygon([
            [
                [8.5, 47.125],
                [8.625, 47.25],
                [8.375, 47.375],
                [8.5, 47.75],
                [8, 48],
                [8.5, 47.125],
            ],
        ]),
    ]);
    const zone = turf.circle([8.5, 47.5], 0, { steps: 32 });
    expect(turf.booleanIntersects(zone, region.features[0])).toBe(false);
    expect(calculateFilterZoneIndexes([zone], [region])).toEqual([]);
});
