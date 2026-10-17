import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    compiledGameAtom,
    filterSupportedQuestions,
    setActiveGameDefinition,
} from "@/game-definition/store";
import { defaultQuestionLabel } from "@/lib/questionNames";
import { zoneScaleAfter } from "@/lib/zoneSize";
import { computePerQuestionRegions } from "@/maps";
import type * as GeoUtils from "@/maps/geo-utils";
import {
    calculateFilterZoneIndexes,
    hidingZoneCircles,
    survivingHidingZones,
} from "@/maps/geo-utils";
import { questionSchema } from "@/maps/schema";

// The geodesic buffer needs ArcGIS, which doesn't load under Node.
vi.mock("@/maps/geo-utils", async (importActual) => ({
    ...(await importActual<typeof GeoUtils>()),
    arcBuffer: async (
        fc: FeatureCollection<Point>,
        radius: number,
        unit: turf.Units,
    ) => turf.buffer(fc.features[0], radius, { units: unit }),
}));

const station: [number, number] = [4.5, 51.5];

// One station with a 1 km zone, and radars to ask about it.
const game = {
    id: "zone-size",
    name: "Zone Size",
    serverId: "home-games",
    radars: true,
    map: {
        center: station,
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 1,
        unit: "kilometers",
        features: {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    id: "central",
                    geometry: { type: "Point", coordinates: station },
                    properties: { name: "Central" },
                },
            ],
        },
    },
} as unknown as GameDefinition;

beforeEach(() => setActiveGameDefinition(game));
afterEach(() => setActiveGameDefinition(null));

let nextKey = 1;
const radar = (within: boolean, radius: number, eastKm = 0): any => {
    const [lng, lat] = turf.destination(station, eastKm, 90, {
        units: "kilometers",
    }).geometry.coordinates;
    return {
        id: "radius",
        key: nextKey++,
        data: {
            lat,
            lng,
            radius,
            unit: "kilometers",
            within,
            drag: false,
            color: "black",
            collapsed: false,
            enabled: true,
        },
    };
};

const zoneSize = (multiplier: number, enabled = true): any =>
    questionSchema.parse({
        id: "zone-size",
        key: nextKey++,
        data: { multiplier, enabled },
    });

const zoneRadiusKm = (zone: { geometry: unknown }) =>
    turf.distance(station, (zone.geometry as Polygon).coordinates[0][0], {
        units: "kilometers",
    });

/** The zones left after the questions, as the zone sidebar finds them. */
const surviving = async (questions: any[]) => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const answered = await computePerQuestionRegions(questions, base, false);
    return survivingHidingZones(
        compiledGameAtom.get()!,
        answered,
        zoneScaleAfter(questions),
        calculateFilterZoneIndexes,
    );
};

describe("zoneScaleAfter", () => {
    it("multiplies the changes above a point in the list", () => {
        const list = [radar(true, 1), zoneSize(2), radar(true, 1), zoneSize(3)];
        expect(zoneScaleAfter(list, 0)).toBe(1);
        expect(zoneScaleAfter(list, 1)).toBe(1);
        expect(zoneScaleAfter(list, 2)).toBe(2);
        expect(zoneScaleAfter(list)).toBe(6);
    });

    it("ignores disabled and malformed changes", () => {
        const malformed = {
            id: "zone-size",
            key: 0,
            data: { multiplier: -1 },
        } as any;
        expect(zoneScaleAfter([zoneSize(2, false), malformed])).toBe(1);
    });
});

it("resizes circular zones and leaves polygon zones alone", () => {
    const compiled = compiledGameAtom.get()!;
    expect(zoneRadiusKm(hidingZoneCircles(compiled)[0])).toBeCloseTo(1, 2);
    expect(zoneRadiusKm(hidingZoneCircles(compiled, 2.5)[0])).toBeCloseTo(
        2.5,
        2,
    );
});

describe("hiding zones after a curse", () => {
    // Not within 2 km of the station: no point of a 1 km zone is that far
    // out, but a 3 km zone's edge is.
    it("tests a question asked after growing zones at the new size", async () => {
        const zones = await surviving([zoneSize(3), radar(false, 2)]);
        expect(zones).toHaveLength(1);
        expect(zoneRadiusKm(zones![0])).toBeCloseTo(3, 2);
    });

    it("tests a question asked before growing zones at the old size", async () => {
        expect(await surviving([radar(false, 2), zoneSize(3)])).toEqual([]);
    });

    // Within 0.8 km of a point 1.6 km east: a 1 km zone reaches that circle,
    // a 0.5 km zone doesn't.
    it("keeps a zone a question asked before shrinking allowed", async () => {
        const zones = await surviving([radar(true, 0.8, 1.6), zoneSize(0.5)]);
        expect(zones).toHaveLength(1);
        // Drawn at the size the hider must be in now.
        expect(zoneRadiusKm(zones![0])).toBeCloseTo(0.5, 2);
    });

    it("tests a question asked after shrinking zones at the new size", async () => {
        expect(await surviving([zoneSize(0.5), radar(true, 0.8, 1.6)])).toEqual(
            [],
        );
    });

    it("needs a zone to pass questions asked at each size", async () => {
        // The first radar needs the shrunk zone's old size, the second the
        // grown zone's new size: both hold for the same station.
        const zones = await surviving([
            radar(true, 0.8, 1.6),
            zoneSize(0.5),
            zoneSize(6),
            radar(false, 2),
        ]);
        expect(zones).toHaveLength(1);
        expect(zoneRadiusKm(zones![0])).toBeCloseTo(3, 2);
    });

    it("ignores a disabled curse", async () => {
        expect(await surviving([zoneSize(3, false), radar(false, 2)])).toEqual(
            [],
        );
    });
});

it("keeps zone size changes in every game and labels them", () => {
    const list = [radar(true, 1), zoneSize(2), zoneSize(0.5)];
    expect(filterSupportedQuestions(list, compiledGameAtom.get())).toEqual(
        list,
    );
    expect(filterSupportedQuestions(list, null)).toEqual(list);
    expect(defaultQuestionLabel(list, list[2].key)).toBe("Zone Size 2");
});

it("records the zone size each question was asked at", async () => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const answered = await computePerQuestionRegions(
        [radar(true, 1), zoneSize(2), radar(true, 1, 0.5)],
        base,
        false,
    );
    expect(answered.map(({ zoneScale }) => zoneScale)).toEqual([1, 2]);
});
