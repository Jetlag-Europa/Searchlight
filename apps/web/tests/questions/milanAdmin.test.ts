import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same faithful arcBufferToPoint stub as grazAdmin/parisAdmin: the surviving
// region is "all points within (seeker→nearest-target distance) of the target".
// The real one loads @arcgis/core WASM, which can't run under Node (Entry 38).
vi.mock("@/maps/geo-utils", async (importActual) => {
    const actual = await importActual<typeof import("@/maps/geo-utils")>();
    return {
        ...actual,
        arcBufferToPoint: async (
            fc: FeatureCollection,
            lat: number,
            lng: number,
        ) => {
            const seeker = turf.point([lng, lat]);
            const verts = turf.explode(fc);
            let min = Infinity;
            turf.featureEach(verts, (p) => {
                const d = turf.distance(seeker, p, { units: "miles" });
                if (d < min) min = d;
            });
            const buffered = turf.buffer(fc, min, {
                units: "miles",
            }) as FeatureCollection<Polygon>;
            return buffered.features.length < 2
                ? buffered.features[0]
                : turf.union(buffered as never);
        },
    };
});

import { hiderMode, mapGeoJSON } from "@/lib/context";
import { adjustPerMatching } from "@/maps/questions/matching";
import { adjustPerMeasuring } from "@/maps/questions/measuring";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const MI = { units: "miles" as const };

const load = (f: string) =>
    JSON.parse(readFileSync(resolve(PUBLIC, f), "utf8")) as FeatureCollection<
        Polygon | MultiPolygon
    >;

const municipi = load("milan-municipi.geojson");
const border = load("milan-border.geojson");

// The production path (milanMunicipioBorderLines) simplifies the ring at this
// tolerance before measuring against it, so the oracle uses the same figure:
// matching production is the point, and it also keeps these tests off the
// 5001-vertex full-resolution rings, which are slow enough in a tight grid loop
// to starve the vitest worker's reporter RPC.
const RING_SIMPLIFY = { tolerance: 0.0005, highQuality: false };

function borderLines(div: Feature): Feature<LineString>[] {
    const l = turf.polygonToLine(div as never);
    const feats = (l.type === "FeatureCollection" ? l.features : [l]) as Feature[];
    return feats.flatMap((f) =>
        f.geometry.type === "MultiLineString"
            ? f.geometry.coordinates.map((c) => turf.lineString(c))
            : [f as Feature<LineString>],
    );
}

function distToBorder(
    pt: Feature<Point>,
    lines: Feature<LineString>[],
    units: "kilometers" | "miles",
): number {
    return Math.min(...lines.map((l) => turf.pointToLineDistance(pt, l, { units })));
}

beforeEach(() => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            const file = String(url).split("/").pop()!;
            const body = readFileSync(resolve(PUBLIC, file), "utf8");
            return { ok: true, status: 200, json: async () => JSON.parse(body) } as Response;
        }),
    );
});

afterEach(() => {
    hiderMode.set(false);
    vi.unstubAllGlobals();
});

// ── asset guards ────────────────────────────────────────────────────────────
// Both question families resolve the ONE division containing the seeker, so a
// gap or an overlap would make the answer depend on feature order.
describe("Milan municipio assets", () => {
    it("is a FeatureCollection of 12 named polygons", () => {
        expect(municipi.type).toBe("FeatureCollection");
        expect(municipi.features.length).toBe(12);
        for (const f of municipi.features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
        }
    });

    it("carries the 9 Municipi plus the 3 Outer catch-alls", () => {
        const names = municipi.features.map((f) => String(f.properties?.name)).sort();
        expect(names).toEqual(
            [
                "Municipio 1",
                "Municipio 2",
                "Municipio 3",
                "Municipio 4",
                "Municipio 5",
                "Municipio 6",
                "Municipio 7",
                "Municipio 8",
                "Municipio 9",
                "Outer North",
                "Outer Southeast",
                "Outer Southwest",
            ].sort(),
        );
    });

    // The source had 206 m² of slivers across 8 pairs; the generator's
    // dedupe_overlaps removes them. This is the assertion that catches a
    // regenerate that skips that step.
    // Explicit budget: these are full-resolution rings (up to 5001 vertices), so
    // the 66 pairwise intersects run ~3 s alone and overrun the default 5 s
    // timeout under full-suite parallel load. The bbox prefilter skips the
    // majority of pairs that cannot touch.
    it("divisions do not overlap each other", async () => {
        const feats = municipi.features;
        const boxes = feats.map((f) => turf.bbox(f));
        const disjoint = (a: number[], b: number[]) =>
            a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];

        for (let i = 0; i < feats.length; i++) {
            // Yield between rows so the worker can answer the reporter's RPC;
            // a long synchronous block here trips "Timeout calling onTaskUpdate"
            // under full-suite parallel load.
            await new Promise((r) => setTimeout(r, 0));
            for (let j = i + 1; j < feats.length; j++) {
                if (disjoint(boxes[i], boxes[j])) continue;
                const overlap = turf.intersect(
                    turf.featureCollection([feats[i], feats[j]] as never),
                );
                // Shared borders are legal; real overlap area is not.
                if (overlap) expect(turf.area(overlap)).toBeLessThan(1);
            }
        }
    }, 60_000);

    it("tiles the play area exactly", () => {
        const union = turf.union(municipi as never)!;
        const sym = turf.area(
            turf.difference(
                turf.featureCollection([border.features[0], union] as never),
            ) ?? turf.polygon([]),
        );
        // Under 0.01% of the play area is uncovered.
        expect(sym / turf.area(border.features[0])).toBeLessThan(0.0001);
    });

    it("every hiding zone sits inside exactly one division", () => {
        const kml = readFileSync(resolve(PUBLIC, "milan-stations.kml"), "utf8");
        const coords = [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map(
            (m) => turf.point([Number(m[1]), Number(m[2])]),
        );
        expect(coords.length).toBe(269);
        for (const pt of coords) {
            const hits = municipi.features.filter((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(hits.length).toBe(1);
        }
    });

    // 65 of the 269 zones are outside the comune. This is why the three "Outer"
    // regions are first-class divisions rather than being dropped — without
    // them a quarter of the board could not answer either question.
    it("keeps a meaningful share of zones in the Outer regions", () => {
        const kml = readFileSync(resolve(PUBLIC, "milan-stations.kml"), "utf8");
        const coords = [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map(
            (m) => turf.point([Number(m[1]), Number(m[2])]),
        );
        const outer = coords.filter((pt) =>
            municipi.features.some(
                (f) =>
                    String(f.properties?.name).startsWith("Outer") &&
                    turf.booleanPointInPolygon(pt, f),
            ),
        );
        expect(outer.length).toBe(65);
    });
});

// ── matching ────────────────────────────────────────────────────────────────
function matchingQuestion(type: string, seeker: [number, number], same: boolean) {
    return {
        type,
        lat: seeker[1],
        lng: seeker[0],
        same,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

async function matchMask(
    type: string,
    base: Feature<Polygon>,
    seeker: [number, number],
    same: boolean,
) {
    return (await adjustPerMatching(
        matchingQuestion(type, seeker, same) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe("adjustPerMatching — milan-municipio (bundled, exact)", () => {
    // A north-western box straddling six divisions — Municipi 1, 2, 7, 8, 9 and
    // Outer North. Picked numerically: 366 of 1089 grid points fall inside the
    // seeker's own division, so both directions have plenty on either side. A
    // central box with a Municipio 1 seeker degenerates to 236/853.
    const base = boundary(9.1, 45.47, 9.2, 45.54);
    const seeker: [number, number] = [9.15, 45.5];
    const seekerDiv = municipi.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(seeker), f),
    )!;
    const seekerLines = borderLines(
        turf.simplify(seekerDiv as never, RING_SIMPLIFY),
    );

    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            // Only float noise on the shared edge is ambiguous (~40 m).
            if (distToBorder(pt, seekerLines, "kilometers") <= 0.04) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
            const kept = same ? inDiv : !inDiv;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker sits in Municipio 8", () => {
        expect(seekerDiv.properties?.name).toBe("Municipio 8");
    });

    it("same: keeps exactly the seeker's municipio ∩ base", async () => {
        const mask = await matchMask("milan-municipio", base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's municipio from base", async () => {
        const mask = await matchMask("milan-municipio", base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: same-mask ⊆ base and area ≤ base", async () => {
        const mask = await matchMask("milan-municipio", base, seeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
    }, 120_000);

    // An "Outer" seeker must behave like any other region — this is the test
    // that fails if someone decides the three catch-alls are not real divisions
    // and filters them out of the lookup.
    it("resolves for a seeker in an Outer region", async () => {
        const outerSeeker: [number, number] = [9.245, 45.543];
        const div = municipi.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(outerSeeker), f),
        )!;
        expect(div.properties?.name).toBe("Outer North");

        const outerBase = boundary(9.2, 45.51, 9.3, 45.57);
        const mask = await matchMask("milan-municipio", outerBase, outerSeeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeGreaterThan(0);
    }, 120_000);
});

// ── measuring ───────────────────────────────────────────────────────────────
function measuringQuestion(
    type: string,
    seeker: [number, number],
    hiderCloser: boolean,
) {
    return {
        type,
        lat: seeker[1],
        lng: seeker[0],
        hiderCloser,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

async function measureMask(
    type: string,
    base: Feature<Polygon>,
    seeker: [number, number],
    hiderCloser: boolean,
) {
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        measuringQuestion(type, seeker, hiderCloser) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

// The seeker sits at Municipio 7's pole of inaccessibility — 1.34 km from its
// own ring, in the largest Municipio (31.4 km²), which gives the band room. The
// division is small against any usable grid, so a seeker near an edge collapses
// the band to a sliver: this scenario splits ~454 near / ~387 far over a 28-step
// grid, where a Municipio 1 seeker degenerates to 139/702. Picked numerically.
const SEEKER: [number, number] = [9.10634, 45.47149];
const seekerDiv = municipi.features.find((f) =>
    turf.booleanPointInPolygon(turf.point(SEEKER), f),
)!;
const seekerLines = borderLines(turf.simplify(seekerDiv as never, RING_SIMPLIFY));
const BASE = boundary(9.03, 45.41, 9.19, 45.53);

describe("adjustPerMeasuring — milan-municipio (distance to the seeker's OWN border)", () => {
    const dMin = distToBorder(turf.point(SEEKER), seekerLines, MI.units);

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distToBorder(pt, seekerLines, MI.units);
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, BASE);
            const closer = d <= dMin;
            const kept = hiderCloser ? closer : !closer;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker sits in Municipio 7", () => {
        expect(seekerDiv.properties?.name).toBe("Municipio 7");
    });

    it("hiderCloser: keeps a band within d_min of the municipio border", async () => {
        const mask = await measureMask("milan-municipio", BASE, SEEKER, true);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of the border", async () => {
        const mask = await measureMask("milan-municipio", BASE, SEEKER, false);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    // Measuring is the seeker's OWN division border, NOT the nearest of all 12
    // (the london-borough reading). Written against the own-ring distance on
    // purpose so it fails loudly if anyone "fixes" it to all-borders. Don't.
    it("uses the seeker's own ring, not the nearest of any division", () => {
        // A point deep in Municipio 5, far from Municipio 7's ring but close to
        // its own.
        const far = turf.point([9.19433, 45.42331]);
        const ownRing = distToBorder(far, seekerLines, "kilometers");
        const anyRing = Math.min(
            ...municipi.features.flatMap((f) =>
                borderLines(turf.simplify(f as never, RING_SIMPLIFY)).map((l) =>
                    turf.pointToLineDistance(far, l, { units: "kilometers" }),
                ),
            ),
        );
        expect(ownRing).toBeGreaterThan(anyRing);
        expect(ownRing).toBeGreaterThan(2);
        expect(anyRing).toBeLessThan(2.5);
    });
});

// ── the lopsided-measuring figure, pinned ───────────────────────────────────
// Recorded in milanAdmin.ts and here so nobody rediscovers it in six months and
// deletes the question thinking it was an oversight. Across all 269 zones the
// "hider closer to their own border" answer keeps a mean ~10.5%, between
// Stockholm's admin2 (15.8%) and admin3 (6.5%) — both shipped deliberately —
// and nothing like belgium-arrondissement's 96%, which was cut.
describe("milan-municipio measuring is deliberately lopsided", () => {
    it("keeps roughly a tenth of hiding zones on average", async () => {
        const kml = readFileSync(resolve(PUBLIC, "milan-stations.kml"), "utf8");
        const zones = [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map(
            (m) => turf.point([Number(m[1]), Number(m[2])]),
        );

        // The reference ring depends only on the seeker's DIVISION, of which
        // there are 12 — so this is a 269x12 distance matrix, not the 269x269
        // one the naive loop computes. The rings are simplified first: this is a
        // statistical balance check, not an oracle, and full-resolution rings
        // (up to 5001 vertices) make it minutes rather than seconds.
        const names = municipi.features.map((f) => String(f.properties?.name));
        const rings = municipi.features.map((f) =>
            borderLines(turf.simplify(f as never, RING_SIMPLIFY)),
        );
        const ownIdx = zones.map((pt) =>
            municipi.features.findIndex((d) => turf.booleanPointInPolygon(pt, d)),
        );
        expect(ownIdx.every((i) => i >= 0)).toBe(true);

        // dist[z][d] = distance from zone z to division d's ring
        const dist: number[][] = [];
        for (let z = 0; z < zones.length; z++) {
            if (z % 25 === 0) await new Promise((r) => setTimeout(r, 0));
            dist.push(rings.map((lines) => distToBorder(zones[z], lines, "kilometers")));
        }

        let total = 0;
        for (let s = 0; s < zones.length; s++) {
            const d = ownIdx[s];
            const dMin = dist[s][d];
            const kept = dist.filter((row) => row[d] < dMin).length;
            total += kept / zones.length;
        }
        const mean = total / zones.length;

        expect(names.length).toBe(12);
        expect(mean).toBeGreaterThan(0.05);
        expect(mean).toBeLessThan(0.2);
    }, 120_000);
});
