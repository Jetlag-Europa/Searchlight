import type { PlayAreaFeatureCollection, Position } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import {
    assembleAdminRelations,
    assembleLineWays,
    buildAdminRegionsQuery,
    type OverpassGeomElement,
    simplifyPathMeters,
    stitchWaysToRings,
} from "@/lib/creator/osmGeometry";

const PLAY_AREA: PlayAreaFeatureCollection = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [8.48, 47.35],
                        [8.60, 47.35],
                        [8.60, 47.42],
                        [8.48, 47.42],
                        [8.48, 47.35],
                    ],
                ],
            },
            properties: { name: "Zurich Test" },
        },
    ],
};

describe("simplifyPathMeters", () => {
    it("pins endpoints and drops collinear/near-collinear intermediate vertices", () => {
        const line: Position[] = [
            [8.5, 47.37],
            [8.505, 47.37251], // ~1m off segment from start to bend
            [8.51, 47.375], // big bend (~550m)
            [8.515, 47.37251], // ~1m off segment from bend to end
            [8.52, 47.37],
        ];
        const simplified = simplifyPathMeters(line, 25);
        expect(simplified).toEqual([
            [8.5, 47.37],
            [8.51, 47.375],
            [8.52, 47.37],
        ]);
    });

    it("returns rounded coordinates unchanged when tolerance is 0", () => {
        const line: Position[] = [
            [8.5, 47.37],
            [8.501, 47.37],
            [8.502, 47.37],
        ];
        expect(simplifyPathMeters(line, 0)).toEqual(line);
    });

    it("never collapses a small valid closed ring under tolerance", () => {
        const tinyRing: Position[] = [
            [0, 0],
            [0.00005, 0],
            [0, 0.00005],
            [0, 0],
        ];
        const simplified = simplifyPathMeters(tinyRing, 15);
        expect(simplified.length).toBeGreaterThanOrEqual(4);
        expect(simplified[0]).toEqual(simplified[simplified.length - 1]);
    });
});

describe("stitchWaysToRings", () => {
    it("splits a figure-8 self-touching ring into two simple closed rings", () => {
        const ways: Position[][] = [
            [
                [0, 0],
                [1, 0],
                [1, 1],
            ],
            [
                [1, 1],
                [2, 1],
                [2, 2],
            ],
            [
                [2, 2],
                [1, 2],
                [1, 1],
            ],
            [
                [1, 1],
                [0, 1],
                [0, 0],
            ],
        ];
        const rings = stitchWaysToRings(ways);
        expect(rings).toHaveLength(2);
        for (const ring of rings) {
            expect(ring.length).toBeGreaterThanOrEqual(4);
            expect(ring[0]).toEqual(ring[ring.length - 1]);
        }
    });
    it("stitches multi-segment open ways regardless of segment direction", () => {
        const ways: Position[][] = [
            [
                [0, 0],
                [1, 0],
            ],
            // Reversed relative to traversal
            [
                [1, 1],
                [1, 0],
            ],
            [
                [1, 1],
                [0, 1],
            ],
            [
                [0, 1],
                [0, 0],
            ],
        ];
        const rings = stitchWaysToRings(ways);
        expect(rings).toHaveLength(1);
        expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
        expect(rings[0]).toHaveLength(5);
    });

    it("keeps already-closed rings and ignores unclosed dangling ways", () => {
        const closed: Position[] = [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
        ];
        const dangling: Position[] = [
            [5, 5],
            [6, 6],
        ];
        const rings = stitchWaysToRings([closed, dangling]);
        expect(rings).toEqual([closed]);
    });
});

describe("assembleAdminRelations", () => {
    it("simplifies shared borders identically across neighbouring relations and assigns holes", () => {
        // Shared border way 100 runs north-south at lng=8.54 with a small jog and a bigger bend.
        // West region lists it south->north; East region lists it north->south.
        const sharedBorder = [
            { lat: 47.36, lon: 8.54 },
            { lat: 47.37, lon: 8.54251 }, // ~1m off segment from start to bend
            { lat: 47.38, lon: 8.545 }, // prominent bend (~370m)
            { lat: 47.39, lon: 8.54251 }, // ~1m off segment from bend to end
            { lat: 47.4, lon: 8.54 },
        ];

        const elements: OverpassGeomElement[] = [
            {
                type: "relation",
                id: 1,
                tags: { name: "West District" },
                members: [
                    { type: "way", ref: 100, role: "outer", geometry: sharedBorder },
                    {
                        type: "way",
                        ref: 101,
                        role: "outer",
                        geometry: [
                            { lat: 47.4, lon: 8.54 },
                            { lat: 47.4, lon: 8.5 },
                            { lat: 47.36, lon: 8.5 },
                            { lat: 47.36, lon: 8.54 },
                        ],
                    },
                    // Inner hole inside West District
                    {
                        type: "way",
                        ref: 102,
                        role: "inner",
                        geometry: [
                            { lat: 47.375, lon: 8.51 },
                            { lat: 47.375, lon: 8.52 },
                            { lat: 47.385, lon: 8.52 },
                            { lat: 47.385, lon: 8.51 },
                            { lat: 47.375, lon: 8.51 },
                        ],
                    },
                ],
            },
            {
                type: "relation",
                id: 2,
                tags: { name: "East District" },
                members: [
                    {
                        type: "way",
                        ref: 100,
                        role: "outer",
                        geometry: [...sharedBorder].reverse(),
                    },
                    {
                        type: "way",
                        ref: 201,
                        role: "outer",
                        geometry: [
                            { lat: 47.36, lon: 8.54 },
                            { lat: 47.36, lon: 8.58 },
                            { lat: 47.4, lon: 8.58 },
                            { lat: 47.4, lon: 8.54 },
                        ],
                    },
                ],
            },
            // Region completely outside the play area — must be skipped.
            {
                type: "relation",
                id: 3,
                tags: { name: "Far Away" },
                members: [
                    {
                        type: "way",
                        ref: 301,
                        role: "outer",
                        geometry: [
                            { lat: 46.0, lon: 7.0 },
                            { lat: 46.0, lon: 7.1 },
                            { lat: 46.1, lon: 7.1 },
                            { lat: 46.1, lon: 7.0 },
                            { lat: 46.0, lon: 7.0 },
                        ],
                    },
                ],
            },
        ];

        const result = assembleAdminRelations(elements, {
            playArea: PLAY_AREA,
            toleranceMeters: 25,
        });

        expect(result.skippedOutside).toBe(1);
        expect(result.items.map((i) => i.name)).toEqual([
            "East District",
            "West District",
        ]);

        const east = result.items[0].geometry;
        const west = result.items[1].geometry;
        expect(east.type).toBe("Polygon");
        expect(west.type).toBe("Polygon");
        if (east.type === "Polygon" && west.type === "Polygon") {
            // West should have 1 outer ring + 1 inner hole
            expect(west.coordinates).toHaveLength(2);
            // Both rings must contain the exact same simplified bend vertex [8.545, 47.38]
            // and neither should contain the dropped 1m wiggle [8.54251, 47.37].
            expect(east.coordinates[0]).toContainEqual([8.545, 47.38]);
            expect(west.coordinates[0]).toContainEqual([8.545, 47.38]);
            expect(east.coordinates[0]).not.toContainEqual([8.54251, 47.37]);
            expect(west.coordinates[0]).not.toContainEqual([8.54251, 47.37]);
        }
    });
});

describe("assembleLineWays", () => {
    it("merges named ways into MultiLineString and unnamed ways into fallback feature when groupByName=true", () => {
        const elements: OverpassGeomElement[] = [
            {
                type: "way",
                id: 1,
                tags: { name: "Limmat" },
                geometry: [
                    { lat: 47.37, lon: 8.54 },
                    { lat: 47.38, lon: 8.53 },
                ],
            },
            {
                type: "way",
                id: 2,
                tags: { name: "Limmat" },
                geometry: [
                    { lat: 47.38, lon: 8.53 },
                    { lat: 47.39, lon: 8.52 },
                ],
            },
            {
                type: "way",
                id: 3,
                tags: {},
                geometry: [
                    { lat: 47.36, lon: 8.55 },
                    { lat: 47.37, lon: 8.55 },
                ],
            },
        ];

        const grouped = assembleLineWays(elements, {
            layerName: "River",
            toleranceMeters: 0,
            groupByName: true,
        });
        expect(grouped.items).toHaveLength(2);
        expect(grouped.items[0].name).toBe("Limmat");
        expect(grouped.items[0].geometry.type).toBe("MultiLineString");
        expect(grouped.items[1].name).toBe("River");
        expect(grouped.items[1].geometry.type).toBe("LineString");
        expect(grouped.vertexCount).toBe(6);

        const ungrouped = assembleLineWays(elements, {
            layerName: "River",
            toleranceMeters: 0,
            groupByName: false,
        });
        expect(ungrouped.items).toHaveLength(3);
    });
});

describe("buildAdminRegionsQuery", () => {
    it("includes both bbox and enclosing is_in/pivot selectors", () => {
        const q = buildAdminRegionsQuery(6, [8.5, 47.35, 8.6, 47.41]);
        expect(q).toContain("is_in(47.38,8.55)->.containing;");
        expect(q).toContain('relation(pivot.containing)["boundary"="administrative"]["admin_level"="6"]["name"];');
        expect(q).toContain('relation["boundary"="administrative"]["admin_level"="6"]["name"](47.35,8.5,47.41,8.6);');
    });
});
