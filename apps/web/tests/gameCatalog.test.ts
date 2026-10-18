import type { CatalogGame } from "@searchlight/shared";
import { describe, expect, test } from "vitest";

import {
    distanceKm,
    isNearPlace,
    photonPlaces,
    type Place,
    searchCatalog,
} from "@/lib/gameCatalog";

const game = (overrides: Partial<CatalogGame>): CatalogGame => ({
    id: overrides.gameKey ?? "game",
    gameKey: "game",
    name: "Game",
    size: "medium",
    serverId: "uk",
    serverName: "JetLag UK",
    center: [0, 0],
    bounds: null,
    zoneCount: 10,
    updatedAt: "2026-09-01T00:00:00.000Z",
    locked: false,
    joinUrl: null,
    ...overrides,
});

const manchester = game({
    gameKey: "greater-manchester-2026",
    name: "Greater Manchester 19-09",
    center: [-2.24, 53.48],
    bounds: [-2.73, 53.33, -1.91, 53.69],
});
const bern = game({
    gameKey: "bern-2026",
    name: "Espace Mittelland 2026",
    serverId: "ch",
    serverName: "JetLag CH",
    center: [7.44, 46.92],
    bounds: [6.38, 46.28, 8.5, 47.55],
    updatedAt: "2026-08-01T00:00:00.000Z",
});
const zurich = game({
    gameKey: "zurich-2026",
    name: "Zürich 2026",
    serverId: "ch",
    serverName: "JetLag CH",
    center: [8.54, 47.37],
    updatedAt: "2026-10-01T00:00:00.000Z",
});
const games = [manchester, bern, zurich];

const place = (overrides: Partial<Place>): Place => ({
    name: "Place",
    label: "Place",
    lng: 0,
    lat: 0,
    extent: null,
    ...overrides,
});
const MANCHESTER_CITY = place({ name: "Manchester", lng: -2.23, lat: 53.44 });
const BERN_CITY = place({ name: "Bern", lng: 7.45, lat: 46.95 });
const SWITZERLAND = place({
    name: "Switzerland",
    lng: 8.23,
    lat: 46.8,
    extent: [5.96, 45.82, 10.49, 47.81],
});

const search = (
    query: string,
    options: Partial<Parameters<typeof searchCatalog>[1]> = {},
) =>
    searchCatalog(games, {
        query,
        place: null,
        serverId: "",
        sort: "name",
        ...options,
    }).map((m) => m.game.gameKey);

describe("searchCatalog", () => {
    test("without a query lists every game, by name", () => {
        expect(search("")).toEqual([
            "bern-2026",
            "greater-manchester-2026",
            "zurich-2026",
        ]);
    });

    test("matches word starts in name, server and key, ignoring case and accents", () => {
        expect(search("manchester")).toEqual(["greater-manchester-2026"]);
        expect(search("zurich")).toEqual(["zurich-2026"]);
        expect(search("jetlag ch")).toEqual(["bern-2026", "zurich-2026"]);
        expect(search("bern 2026")).toEqual(["bern-2026"]);
        expect(search("mitt")).toEqual(["bern-2026"]);
        expect(search("chester")).toEqual([]);
        expect(search("paris")).toEqual([]);
    });

    test("finds the games played at a place whose names don't mention it", () => {
        expect(search("Bern", { query: "Bern", place: BERN_CITY })).toContain(
            "bern-2026",
        );
        expect(search("Suisse", { place: SWITZERLAND })).toEqual([
            "bern-2026",
            "zurich-2026",
        ]);
    });

    test("sorts by distance from the place, newest or name", () => {
        expect(
            search("Switzerland", { place: BERN_CITY, sort: "nearest" })[0],
        ).toBe("bern-2026");
        expect(search("", { sort: "newest" })).toEqual([
            "zurich-2026",
            "greater-manchester-2026",
            "bern-2026",
        ]);
        expect(search("", { sort: "name" })).toEqual([
            "bern-2026",
            "greater-manchester-2026",
            "zurich-2026",
        ]);
    });

    test("lists games of servers the user hasn't joined after the playable ones", () => {
        const lockedBern = { ...bern, locked: true };
        const order = searchCatalog([lockedBern, manchester, zurich], {
            query: "",
            place: null,
            serverId: "",
            sort: "name",
        }).map((m) => m.game.gameKey);
        expect(order).toEqual([
            "greater-manchester-2026",
            "zurich-2026",
            "bern-2026",
        ]);
    });

    test("filters by server", () => {
        expect(search("", { serverId: "uk" })).toEqual([
            "greater-manchester-2026",
        ]);
    });

    test("reports the distance from the place", () => {
        const [match] = searchCatalog([manchester], {
            query: "",
            place: MANCHESTER_CITY,
            serverId: "",
            sort: "name",
        });
        expect(match.distanceKm).toBeGreaterThan(3);
        expect(match.distanceKm).toBeLessThan(6);
    });
});

describe("isNearPlace", () => {
    test("a place within the game's bounds", () => {
        expect(isNearPlace(manchester, MANCHESTER_CITY)).toBe(true);
        expect(isNearPlace(manchester, BERN_CITY)).toBe(false);
    });

    test("a place near a game without bounds", () => {
        expect(isNearPlace(zurich, place({ lng: 8.7, lat: 47.4 }))).toBe(true);
        expect(isNearPlace(zurich, BERN_CITY)).toBe(false);
    });

    test("an area containing the game's center", () => {
        expect(isNearPlace(zurich, SWITZERLAND)).toBe(true);
        expect(isNearPlace(manchester, SWITZERLAND)).toBe(false);
    });
});

describe("distanceKm", () => {
    test("is the great-circle distance", () => {
        // Manchester to Bern is about 1,000 km.
        expect(distanceKm([-2.24, 53.48], [7.45, 46.95])).toBeCloseTo(1000, -2);
    });
});

describe("photonPlaces", () => {
    test("keeps places, labels them and turns Photon's extent into bounds", () => {
        const places = photonPlaces([
            {
                geometry: { coordinates: [-2.23, 53.44] },
                properties: {
                    name: "Manchester",
                    type: "city",
                    state: "England",
                    country: "United Kingdom",
                    extent: [-2.32, 53.54, -2.15, 53.34],
                },
            },
            {
                geometry: { coordinates: [7.44, 46.95] },
                properties: { name: "Bern", type: "house" },
            },
            {
                geometry: { coordinates: [7.6, 46.84] },
                properties: {
                    name: "Bern",
                    type: "state",
                    state: "Bern",
                    country: "Switzerland",
                },
            },
        ]);
        expect(places).toEqual([
            {
                name: "Manchester",
                label: "Manchester, England, United Kingdom",
                lng: -2.23,
                lat: 53.44,
                extent: [-2.32, 53.34, -2.15, 53.54],
            },
            {
                name: "Bern",
                label: "Bern, Switzerland",
                lng: 7.6,
                lat: 46.84,
                extent: null,
            },
        ]);
    });
});

describe("place extents", () => {
    test("drops extents that cross the antimeridian or circle most of the globe", () => {
        const [russia, fiji] = photonPlaces([
            {
                geometry: { coordinates: [97.7, 64.7] },
                properties: {
                    name: "Russia",
                    type: "country",
                    extent: [-180, 81.9, 180, 41.2],
                },
            },
            {
                geometry: { coordinates: [178.1, -17.8] },
                properties: {
                    name: "Fiji",
                    type: "country",
                    extent: [174.6, -12.4, -178.2, -21.7],
                },
            },
        ]);
        expect(russia.extent).toBeNull();
        expect(fiji.extent).toBeNull();
        // Without the extent, Europe isn't "near Russia".
        expect(isNearPlace(manchester, russia)).toBe(false);
    });

    test("marks games inside a searched area, whatever their distance from its center", () => {
        const [match] = searchCatalog([zurich], {
            query: "",
            place: SWITZERLAND,
            serverId: "",
            sort: "name",
        });
        expect(match).toMatchObject({ near: true, inPlace: true });
        expect(match.distanceKm).toBeGreaterThan(50);
    });
});
