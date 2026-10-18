import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { FeatureCollection, Point } from "geojson";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
    compiledGameAtom,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { computePerQuestionRegions } from "@/maps";
import { answerSplit, splitInputs } from "@/maps/answerSplit";
import type * as GeoUtils from "@/maps/geo-utils";
import { calculateFilterZoneIndexes } from "@/maps/geo-utils";
import { questionSchema } from "@/maps/schema";

// The geodesic buffers need ArcGIS, which doesn't load under Node.
vi.mock("@/maps/geo-utils", async (importActual) => ({
    ...(await importActual<typeof GeoUtils>()),
    arcBuffer: async (
        fc: FeatureCollection<Point>,
        radius: number,
        unit: turf.Units,
    ) => turf.buffer(fc.features[0], radius, { units: unit }),
    // Everywhere as close to the targets as the seeker is.
    arcBufferToPoint: async (
        fc: FeatureCollection,
        lat: number,
        lng: number,
    ) => {
        const distance = Math.min(
            ...turf
                .explode(fc)
                .features.map((point) => turf.distance([lng, lat], point)),
        );
        return turf.buffer(fc.features[0], distance);
    },
}));

// Five stations in a row, about 3.5 km apart, with 1 km zones.
const lngs = [4.4, 4.45, 4.5, 4.55, 4.6];
const game = {
    id: "answer-split",
    name: "Answer Split",
    serverId: "home-games",
    radars: true,
    thermometer: true,
    map: {
        center: [4.5, 51.5],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 1,
        unit: "kilometers",
        features: {
            type: "FeatureCollection",
            features: lngs.map((lng) => ({
                type: "Feature",
                id: `s${lng}`,
                geometry: { type: "Point", coordinates: [lng, 51.5] },
                properties: { name: `Station ${lng}` },
            })),
        },
    },
} as unknown as GameDefinition;

beforeEach(() => setActiveGameDefinition(game));
afterEach(() => setActiveGameDefinition(null));

const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);

let nextKey = 1;
const radar = (lng: number, radius: number, drag: boolean): any => ({
    id: "radius",
    key: nextKey++,
    data: {
        lat: 51.5,
        lng,
        radius,
        unit: "kilometers",
        within: true,
        drag,
        color: "black",
        collapsed: false,
        enabled: true,
    },
});

const zoneSize = (multiplier: number): any =>
    questionSchema.parse({
        id: "zone-size",
        key: nextKey++,
        data: { multiplier },
    });

/** The split of `question`, as planning mode previews it on its card. */
const split = async (
    question: any,
    questions: any[],
    disabled: string[] = [],
) =>
    answerSplit(
        question,
        questions,
        compiledGameAtom.get()!,
        await computePerQuestionRegions(questions, base, true),
        disabled,
        base,
        calculateFilterZoneIndexes,
    );

it("counts the zones each answer leaves, with zones on the line in both", async () => {
    // The middle zone is inside 3 km, its neighbours straddle the line and
    // the outer two are outside it.
    const question = radar(4.5, 3, true);
    expect(await split(question, [question])).toEqual([
        { label: "Outside", zones: 4 },
        { label: "Inside", zones: 3 },
    ]);
});

it("leaves out the zones the player disabled", async () => {
    const question = radar(4.5, 3, true);
    expect(await split(question, [question], ["s4.6"])).toEqual([
        { label: "Outside", zones: 3 },
        { label: "Inside", zones: 3 },
    ]);
});

it("counts only the zones the answered questions leave", async () => {
    // Within 7 km of the second station rules out the last one.
    const answered = radar(4.45, 7, false);
    const question = radar(4.5, 3, true);
    expect(await split(question, [answered, question])).toEqual([
        { label: "Outside", zones: 3 },
        { label: "Inside", zones: 3 },
    ]);
});

it("ignores the other unlocked questions", async () => {
    // Unlocked, the same radar rules out nothing yet.
    const other = radar(4.45, 7, true);
    const question = radar(4.5, 3, true);
    expect(await split(question, [other, question])).toEqual([
        { label: "Outside", zones: 4 },
        { label: "Inside", zones: 3 },
    ]);
});

it("sizes the zones as they are where the question sits", async () => {
    const question = radar(4.5, 3, true);
    // Zones four times as big all straddle the line.
    expect(await split(question, [zoneSize(4), question])).toEqual([
        { label: "Outside", zones: 5 },
        { label: "Inside", zones: 5 },
    ]);
    // A curse cast after the question doesn't change what it says.
    expect(await split(question, [question, zoneSize(4)])).toEqual([
        { label: "Outside", zones: 4 },
        { label: "Inside", zones: 3 },
    ]);
});

it("flips the answer of other two-answer questions", async () => {
    const question: any = {
        id: "thermometer",
        key: nextKey++,
        data: {
            latA: 51.5,
            lngA: 4.45,
            latB: 51.5,
            lngB: 4.55,
            warmer: false,
            drag: true,
            colorA: "black",
            colorB: "black",
            collapsed: false,
            enabled: true,
        },
    };
    // The middle zone straddles the halfway line.
    expect(await split(question, [question])).toEqual([
        { label: "Colder", zones: 3 },
        { label: "Warmer", zones: 3 },
    ]);
    // The card's own answer is left as it was.
    expect(question.data.warmer).toBe(false);
});

it("flips a drawn measuring question", async () => {
    // The seeker stands at the middle station, 7 km from the drawn point.
    const question: any = {
        id: "measuring",
        key: nextKey++,
        data: {
            type: "custom-measure",
            lat: 51.5,
            lng: 4.5,
            geo: turf.featureCollection([turf.point([4.6, 51.5])]),
            hiderCloser: true,
            drag: true,
            color: "black",
            collapsed: false,
            enabled: true,
        },
    };
    // The middle zone straddles the line, the two beyond it are further and
    // the two towards the point closer.
    expect(await split(question, [question])).toEqual([
        { label: "Further", zones: 3 },
        { label: "Closer", zones: 3 },
    ]);
    expect(question.data.hiderCloser).toBe(true);
});

it("has no split for a question with more than two answers", async () => {
    const tentacles: any = {
        id: "tentacles",
        key: nextKey++,
        data: { drag: true },
    };
    expect(await split(tentacles, [tentacles])).toBeUndefined();
});

it("recounts for what changes the split, not for its answer or colour", () => {
    const question = radar(4.5, 3, true);
    const edited = structuredClone(question);
    edited.data.within = false;
    edited.data.color = "red";
    edited.data.name = "Renamed";
    expect(splitInputs(edited)).toEqual(splitInputs(question));
    edited.data.radius = 4;
    expect(splitInputs(edited)).not.toEqual(splitInputs(question));
});
