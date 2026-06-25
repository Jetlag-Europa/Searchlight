import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, describe, expect, it, vi } from "vitest";

// `arcBuffer` builds the radius circle via @arcgis/core's WASM geodesic-buffer
// operator, which can't load under Node/Vitest (`require is not defined`). A
// geodesic buffer is exactly "all points within `radius` geodesic distance of
// the centre" — which `turf.buffer` produces and which the oracle already uses
// as its radius test — so we swap in the turf equivalent and keep the real
// Voronoi / union / intersect code (the actual subject) untouched.
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof import("@/maps/geo-utils")>();
    return {
        ...actual,
        arcBuffer: async (
            fc: FeatureCollection<Point>,
            radius: number,
            unit: turf.Units,
        ) => turf.buffer(fc.features[0], radius, { units: unit }),
    };
});

import { hiderMode } from "@/lib/context";
import {
    geoSpatialVoronoi,
    geoSpatialVoronoiSafe,
} from "@/maps/geo-utils/voronoi";
import {
    adjustPerTentacle,
    hiderifyTentacles,
} from "@/maps/questions/tentacles";

import {
    oracleVerdict,
    sampleGrid,
    sitesWithinRadius,
    type TentacleScenario,
} from "./tentacleOracle";

// A point Feature with a name, the shape the tentacle code expects in `places`.
function poi(name: string, lng: number, lat: number): Feature<Point> {
    return turf.point([lng, lat], { name });
}

// A rectangular game boundary [minLng, minLat, maxLng, maxLat].
function boundary(
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
): Feature<Polygon> {
    return turf.polygon([
        [
            [minLng, minLat],
            [maxLng, minLat],
            [maxLng, maxLat],
            [minLng, maxLat],
            [minLng, minLat],
        ],
    ]);
}

// Build the inner TentacleQuestion data object for a scenario, custom-location
// type so no Overpass / gamePOIData is touched.
function customTentacleQuestion(s: TentacleScenario) {
    return {
        id: "tentacles",
        key: "test-tentacle",
        drag: true as const,
        enabled: true,
        locationType: "custom" as const,
        radius: s.radius,
        unit: s.unit,
        lat: s.seeker[1],
        lng: s.seeker[0],
        places: s.places,
        location: {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: s.seeker },
            properties: { name: s.answerName },
        },
    };
}

async function maskFor(s: TentacleScenario) {
    // adjustPerTentacle takes the inner question data and the base map data,
    // which is a FeatureCollection (safeUnion folds it before intersecting).
    return adjustPerTentacle(
        customTentacleQuestion(s) as never,
        turf.featureCollection([s.base]),
    );
}

// Run the grid oracle: every clearly-decidable sample point must agree with the
// real mask. Returns counts so tests can assert the scenario actually exercised
// both outcomes (guards against a vacuous pass).
async function checkAgainstOracle(
    s: TentacleScenario,
    steps = 28,
    edgeMarginFrac = 0.08,
) {
    const mask = (await maskFor(s)) as Feature<Polygon> | null;
    // Skip points near radius/Voronoi edges: the real cells come from a
    // Mercator-reprojected spherical Voronoi whose boundaries differ slightly
    // from the oracle's geodesic bisectors, so near-edge points can legitimately
    // disagree by a sliver. The margin is a fraction of the radius.
    const edgeMargin = s.radius * edgeMarginFrac;

    let survives = 0;
    let eliminated = 0;
    let ambiguous = 0;
    const failures: string[] = [];

    for (const pt of sampleGrid(s, steps)) {
        const verdict = oracleVerdict(s, pt, edgeMargin);
        if (verdict === "ambiguous") {
            ambiguous++;
            continue;
        }
        const inMask =
            mask !== null && turf.booleanPointInPolygon(pt, mask);
        if (verdict === "survives") {
            survives++;
            if (!inMask)
                failures.push(
                    `expected SURVIVE but masked out: ${pt.geometry.coordinates}`,
                );
        } else {
            eliminated++;
            if (inMask)
                failures.push(
                    `expected ELIMINATE but kept: ${pt.geometry.coordinates}`,
                );
        }
    }

    return { mask, survives, eliminated, ambiguous, failures };
}

afterEach(() => hiderMode.set(false));

describe("adjustPerTentacle — well-separated POIs (spherical Voronoi)", () => {
    // Seeker in canton Zürich; three POIs a few km apart so the spherical
    // Voronoi is non-degenerate. Answer = the western POI "A".
    // Three POIs ~450-670 m from the seeker, with a deliberately small 0.8 km
    // radius. `geoSpatialVoronoi`'s Mercator reprojection error grows with
    // distance from the POI centroid, so we keep the radius tight: every grid
    // point still being tested for *cell membership* lies within 0.8 km of the
    // seeker (close to the POIs, where the projection is accurate), while points
    // further out are eliminated by the radius circle — where the oracle and the
    // app trivially agree. The spherical path stays non-degenerate (well-spread).
    const scenario: TentacleScenario = {
        seeker: [8.54, 47.37],
        radius: 0.8,
        unit: "kilometers",
        answerName: "A",
        places: [
            poi("A", 8.534, 47.37), // west
            poi("B", 8.546, 47.37), // east
            poi("C", 8.54, 47.376), // north
        ],
        base: boundary(8.525, 47.362, 8.555, 47.38),
    };

    it("all three POIs are within the seeker's radius (scenario sanity)", () => {
        expect(sitesWithinRadius(scenario)).toHaveLength(3);
    });

    it("masked region agrees with the independent oracle on every clear point", async () => {
        // ~160 m edge margin (0.20 × 0.8 km) absorbs the small Voronoi-vs-
        // geodesic boundary fuzz (the Mercator reprojection nudges cell edges
        // ~100 m off the true bisector, and the three cells meet in a genuinely
        // ambiguous triple point near the seeker). Within the radius the
        // projection is accurate, so the interior must agree exactly.
        const r = await checkAgainstOracle(scenario, 32, 0.2);
        expect(r.failures).toEqual([]);
        // The scenario must genuinely test both outcomes, else a no-op passes.
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("never exceeds the base boundary or the radius circle (invariants)", async () => {
        const mask = (await maskFor(scenario)) as Feature<Polygon> | null;
        expect(mask).not.toBeNull();
        // Area can only shrink.
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(scenario.base));
        // Every vertex of the mask lies within (radius + slack) of the seeker.
        const seeker = turf.point(scenario.seeker);
        turf.coordEach(mask!, (c) => {
            const d = turf.distance(seeker, turf.point(c as [number, number]), {
                units: scenario.unit,
            });
            expect(d).toBeLessThanOrEqual(scenario.radius * 1.02);
        });
    });
});

describe("adjustPerTentacle — tightly-clustered POIs (planar Voronoi fallback)", () => {
    // Three POIs within ~150 m, the consulate-cluster case from Entry 35 that
    // breaks the spherical Voronoi and triggers geoSpatialVoronoiSafe's planar
    // fallback. Far from such a tight cluster, *which* cell a point belongs to
    // is genuinely ill-conditioned (the runner-up POI is only ~150 m further),
    // so the far-field grid oracle is meaningless here. Instead we assert
    // structurally: the fallback fires, the mask is valid, and near the cluster
    // the correct cell wins.
    const seeker: [number, number] = [8.54, 47.37];
    const places = [
        poi("P1", 8.5398, 47.3698), // SW
        poi("P2", 8.5404, 47.3698), // SE
        poi("P3", 8.5401, 47.3704), // N
    ];
    const scenario: TentacleScenario = {
        seeker,
        radius: 6,
        unit: "kilometers",
        answerName: "P3",
        places,
        base: boundary(8.5, 47.35, 8.58, 47.39),
    };

    it("the spherical Voronoi is degenerate, forcing the planar fallback", () => {
        const fc = turf.featureCollection(places);
        // Degeneracy signature geoSpatialVoronoiSafe checks for: at least one
        // site does NOT fall inside its own spherical cell.
        const spherical = geoSpatialVoronoi(fc);
        const everySiteInOwnCell = spherical.features.every((f) => {
            const site = (f.properties as { site?: Feature<Point> }).site;
            return site
                ? turf.booleanPointInPolygon(site, f as Feature<Polygon>)
                : false;
        });
        expect(everySiteInOwnCell).toBe(false);

        // The safe variant must repair it: every site lands in its own cell.
        const bbox = turf.bbox(
            turf.buffer(turf.point(seeker), scenario.radius * 1.2, {
                units: "kilometers",
            })!,
        );
        const safe = geoSpatialVoronoiSafe(fc, bbox);
        for (const site of places) {
            const owning = safe.features.find((f) =>
                turf.booleanPointInPolygon(site, f as Feature<Polygon>),
            );
            expect(
                (owning?.properties as { site?: Feature<Point> })?.site
                    ?.properties?.name,
            ).toBe(site.properties?.name);
        }
    });

    it("produces a valid mask within the base and radius", async () => {
        const mask = (await maskFor(scenario)) as Feature<Polygon> | null;
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeGreaterThan(0);
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(scenario.base));
        const seekerPt = turf.point(seeker);
        turf.coordEach(mask!, (c) => {
            const d = turf.distance(seekerPt, turf.point(c as [number, number]), {
                units: "kilometers",
            });
            expect(d).toBeLessThanOrEqual(scenario.radius * 1.02);
        });
    });

    it("keeps a hider just north of the cluster (P3's side), drops one to the south", async () => {
        const mask = (await maskFor(scenario)) as Feature<Polygon> | null;
        expect(mask).not.toBeNull();
        // A point clearly on P3's (northern) side of the cluster survives…
        const north = turf.point([8.5401, 47.385]);
        expect(turf.booleanPointInPolygon(north, mask!)).toBe(true);
        // …and one clearly on the southern side (nearest P1/P2) is eliminated.
        const south = turf.point([8.5401, 47.355]);
        expect(turf.booleanPointInPolygon(south, mask!)).toBe(false);
    });
});

describe("hiderifyTentacles — resolves the hider's POI", () => {
    const base = boundary(8.44, 47.31, 8.66, 47.45);
    const places = [
        poi("A", 8.5, 47.372),
        poi("B", 8.585, 47.372),
        poi("C", 8.545, 47.405),
    ];
    const baseQuestion = {
        id: "tentacles",
        key: "test",
        drag: true as const,
        enabled: true,
        locationType: "custom" as const,
        radius: 6,
        unit: "kilometers" as const,
        lat: 47.37,
        lng: 8.54,
        places,
        location: false as const,
        base,
    };

    it("sets location to the POI whose Voronoi cell holds the hider", async () => {
        // Hider sits right on top of POI B → B's cell.
        hiderMode.set({ latitude: 47.372, longitude: 8.585 } as never);
        const out = await hiderifyTentacles({ ...baseQuestion } as never);
        expect(out.location).not.toBe(false);
        expect((out.location as Feature<Point>).properties?.name).toBe("B");
    });

    it("sets location to false when the hider is outside the radius", async () => {
        // ~30 km east of the seeker, well beyond the 6 km radius.
        hiderMode.set({ latitude: 47.37, longitude: 8.94 } as never);
        const out = await hiderifyTentacles({ ...baseQuestion } as never);
        expect(out.location).toBe(false);
    });
});
