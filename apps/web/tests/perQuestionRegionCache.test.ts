import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { FeatureCollection, Point } from "geojson";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setActiveGameDefinition } from "@/game-definition/store";
import { computePerQuestionRegions } from "@/maps";
import { sameResult } from "@/maps/mapResult";
import type * as GeoUtils from "@/maps/geo-utils";

// The geodesic buffer needs ArcGIS, which doesn't load under Node.
vi.mock("@/maps/geo-utils", async (importActual) => ({
    ...(await importActual<typeof GeoUtils>()),
    arcBuffer: async (
        fc: FeatureCollection<Point>,
        radius: number,
        unit: turf.Units,
    ) => turf.buffer(fc.features[0], radius, { units: unit }),
}));

// Questions are answered only within a game; this one offers radars.
const game = {
    id: "region-cache",
    name: "Region Cache",
    serverId: "home-games",
    radars: true,
    map: {
        center: [4.5, 51.5],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 1,
        unit: "kilometers",
        features: { type: "FeatureCollection", features: [] },
    },
} as unknown as GameDefinition;

beforeEach(() => setActiveGameDefinition(game));
afterEach(() => setActiveGameDefinition(null));

const radius = (key: number, lng: number, within: boolean): any => ({
    id: "radius",
    key,
    data: {
        lat: 51.5,
        lng,
        radius: 10,
        unit: "kilometers",
        within,
        drag: false,
        color: "black",
        collapsed: false,
    },
});

it("reuses unchanged questions' regions and re-evaluates only edited ones", async () => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const first = await computePerQuestionRegions(
        [radius(1, 4.3, true), radius(2, 4.7, false)],
        base,
        false,
    );
    expect(first).toHaveLength(2);
    expect(first[0].region).not.toEqual(base);

    const edited = await computePerQuestionRegions(
        [radius(1, 4.3, true), radius(2, 4.6, false)],
        base,
        false,
    );
    expect(edited[0].region).toBe(first[0].region);
    expect(edited[1].region).not.toBe(first[1].region);

    // A new base boundary invalidates every cached region.
    const moved = await computePerQuestionRegions(
        [radius(1, 4.3, true)],
        structuredClone(base),
        false,
    );
    expect(moved[0].region).not.toBe(first[0].region);
    expect(moved[0].region).toEqual(first[0].region);
});

it("keeps a question's region when only its name or collapsed state changes", async () => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const [first] = await computePerQuestionRegions(
        [radius(1, 4.3, true)],
        base,
        false,
    );
    const renamed = radius(1, 4.3, true);
    renamed.data.name = "Airport radar";
    renamed.data.collapsed = true;
    const [second] = await computePerQuestionRegions([renamed], base, false);
    expect(second.region).toBe(first.region);
});

it.each([
    ["lock state", { drag: true }],
    ["colour", { color: "red" }],
    ["answer colours", { colorA: "blue", colorB: "green" }],
])("keeps a question's region when only its %s changes", async (_, change) => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const [first] = await computePerQuestionRegions(
        [radius(1, 4.3, true)],
        base,
        false,
    );
    const changed = radius(1, 4.3, true);
    Object.assign(changed.data, change);
    const [second] = await computePerQuestionRegions([changed], base, false);
    expect(second.region).toBe(first.region);
});

it("keeps the map for a teammate's list that renames, locks and recolours", async () => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    const first = await computePerQuestionRegions(
        [radius(1, 4.3, true), radius(2, 4.7, false)],
        base,
        false,
    );
    const shown = { inputs: [], answered: first, mask: null, previewKey: "" };
    // Fresh objects, as after the session replaces the list.
    const replaced = [radius(1, 4.3, true), radius(2, 4.7, false)];
    replaced[0].data.name = "Airport radar";
    replaced[0].data.drag = true;
    replaced[1].data.color = "red";
    const same = await computePerQuestionRegions(replaced, base, false);
    expect(sameResult(shown, same, "")).toBe(true);

    const answered = [radius(1, 4.3, true), radius(2, 4.7, true)];
    const changed = await computePerQuestionRegions(answered, base, false);
    expect(sameResult(shown, changed, "")).toBe(false);
});

it("doesn't let an obsolete run drop the newer run's regions", async () => {
    const base = turf.featureCollection([turf.bboxPolygon([4, 51, 5, 52])]);
    // The newer run finishes first, then the obsolete one.
    const [newer] = await computePerQuestionRegions(
        [radius(1, 4.5, true)],
        base,
        false,
    );
    await computePerQuestionRegions(
        [radius(1, 4.4, true)],
        base,
        false,
        () => false,
    );
    const [again] = await computePerQuestionRegions(
        [radius(1, 4.5, true)],
        base,
        false,
    );
    expect(again.region).toBe(newer.region);
});
