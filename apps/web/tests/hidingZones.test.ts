import type { GameDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { afterEach, expect, it, vi } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";
import { hidingZoneCircles } from "@/maps/geo-utils";

const district: Polygon = {
    type: "Polygon",
    coordinates: [
        [
            [10.2, 50.2],
            [10.4, 50.2],
            [10.4, 50.4],
            [10.2, 50.4],
            [10.2, 50.2],
        ],
    ],
};

const game = {
    id: "zones",
    name: "Zones",
    serverId: "home-games",
    map: {
        center: [10, 50],
        playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
        radius: 500,
        unit: "meters",
        tierOverrides: { tram: 300 },
        features: {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    id: "central",
                    geometry: { type: "Point", coordinates: [10, 50] },
                    properties: { name: "Central", tier: "tram" },
                },
                {
                    type: "Feature",
                    id: "district",
                    geometry: district,
                    properties: { name: "District" },
                },
            ],
        },
    },
} as unknown as GameDefinition;

afterEach(() => vi.restoreAllMocks());

it("draws a game's zones from its definition alone", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const compiled = compileGameDefinition(game);
    const [station, polygon] = hidingZoneCircles(compiled);

    // A station's zone is a circle of its tier's radius around it.
    expect(station.properties.properties).toEqual({
        id: "central",
        name: "Central",
        tier: "tram",
    });
    expect(
        turf.distance(
            [10, 50],
            (station.geometry as Polygon).coordinates[0][0],
            { units: "meters" },
        ),
    ).toBeCloseTo(300, 0);

    // A polygon zone is its own area, marked by a point inside it.
    expect(polygon.geometry).toEqual(district);
    expect(polygon.properties.properties).toEqual({
        id: "district",
        name: "District",
    });
    expect(turf.booleanPointInPolygon(polygon.properties, district)).toBe(true);

    // Without explicit bounds, the map frames the polygon zone too.
    expect(compiled.bounds[2]).toBeGreaterThanOrEqual(10.4);
    expect(compiled.bounds[3]).toBeGreaterThanOrEqual(50.4);
    expect(fetchSpy).not.toHaveBeenCalled();
});

it("numbers unnamed zones among their own kind", () => {
    const point = (lng: number) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, 50] },
        properties: {},
    });
    const area = { type: "Feature", geometry: district, properties: {} };
    const compiled = compileGameDefinition({
        ...game,
        hidingZones: {
            features: {
                type: "FeatureCollection",
                features: [area, point(10), area, point(10.1)],
            },
        },
    } as unknown as GameDefinition);

    // Adding areas doesn't renumber the stations.
    expect(
        compiled.hidingZones.stations?.map(({ id, name }) => [id, name]),
    ).toEqual([
        ["area-1", "Area 1"],
        ["zone-1", "Station 1"],
        ["area-2", "Area 2"],
        ["zone-2", "Station 2"],
    ]);
});

it("frames the play area without explicit bounds", () => {
    const compiled = compileGameDefinition({
        ...game,
        map: {
            center: [10, 50],
            playArea: {
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        geometry: {
                            type: "Polygon",
                            coordinates: [
                                [
                                    [9, 49],
                                    [11, 49],
                                    [11, 51],
                                    [9, 51],
                                    [9, 49],
                                ],
                            ],
                        },
                        properties: {},
                    },
                ],
            },
        },
    } as unknown as GameDefinition);

    const [west, south, east, north] = compiled.bounds;
    expect(west).toBeLessThanOrEqual(9);
    expect(south).toBeLessThanOrEqual(49);
    expect(east).toBeGreaterThanOrEqual(11);
    expect(north).toBeGreaterThanOrEqual(51);
});
