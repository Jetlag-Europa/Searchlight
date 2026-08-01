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

// Same faithful arcBufferToPoint stub as belgiumAdmin.test.ts: the surviving
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

const boroughs = JSON.parse(
    readFileSync(resolve(PUBLIC, "london-boroughs.geojson"), "utf8"),
) as FeatureCollection<Polygon | MultiPolygon>;
const boroughLines = JSON.parse(
    readFileSync(resolve(PUBLIC, "london-borough-lines.geojson"), "utf8"),
) as FeatureCollection<LineString>;

function flatLines(div: Feature): Feature<LineString>[] {
    const l = turf.polygonToLine(div as never);
    const feats = (l.type === "FeatureCollection" ? l.features : [l]) as Feature[];
    return feats.flatMap((f) =>
        f.geometry.type === "MultiLineString"
            ? f.geometry.coordinates.map((c) => turf.lineString(c))
            : [f as Feature<LineString>],
    );
}

const distTo = (pt: Feature<Point>, lines: Feature<LineString>[], units: "kilometers" | "miles") =>
    Math.min(...lines.map((l) => turf.pointToLineDistance(pt, l, { units })));

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
// Both assets come from OSM (admin_level 8, plus City of London at level 6),
// NOT from the KMZ's own Borough layer: 12 of its 27 rings are capped at a flat
// 201 vertices, the resampling signature that gave Belgium's arrondissements
// 62 km² of gaps. Assert the properties that made OSM the better source, so a
// regeneration that regresses them fails here.
describe("London borough assets", () => {
    it("london-boroughs.geojson is 27 named polygons", () => {
        expect(boroughs.type).toBe("FeatureCollection");
        expect(boroughs.features).toHaveLength(27);
        for (const f of boroughs.features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
        }
    });

    it("keeps the source map's borough set — including City of London", () => {
        const names = boroughs.features.map((f) => String(f.properties?.name));
        // City of London is admin_level 6, not 8; without an explicit relation
        // id it drops out of the query silently.
        expect(names).toContain("City of London");
        expect(names).toContain("Westminster");
        expect(names).toContain("Kensington and Chelsea");
        // The three Greater London boroughs that clip the play circle but hold
        // no hiding zone (nearest station 2.7–3.4 km away, radius 400 m). The
        // source map omits them deliberately; so do we.
        for (const n of ["Kingston upon Thames", "Sutton", "Harrow"]) {
            expect(names).not.toContain(n);
        }
    });

    it("boroughs do not overlap each other", () => {
        // O(n²) turf.intersect over the full set is slow; central London is
        // where a tear would show.
        const near = boroughs.features.filter((f) =>
            turf.booleanIntersects(f, turf.bboxPolygon([-0.2, 51.47, 0.0, 51.56])),
        );
        expect(near.length).toBeGreaterThan(4);
        for (let i = 0; i < near.length; i++) {
            for (let j = i + 1; j < near.length; j++) {
                const overlap = turf.intersect(
                    turf.featureCollection([near[i], near[j]] as never),
                );
                if (overlap) expect(turf.area(overlap)).toBeLessThan(1000);
            }
        }
    });

    it("every station falls in exactly one borough", () => {
        const pts = [
            ...readFileSync(resolve(PUBLIC, "london-stations.kml"), "utf8").matchAll(
                /<coordinates>([^,]+),([^,]+),/g,
            ),
        ].map((m) => turf.point([parseFloat(m[1]), parseFloat(m[2])]));
        expect(pts).toHaveLength(271);
        for (const pt of pts) {
            const hits = boroughs.features.filter((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(hits).toHaveLength(1);
        }
    });

    // Measuring is against EVERY borough boundary, so each internal border must
    // appear once, not once per side — otherwise the geodesic buffer does the
    // same work twice. linemerge before simplify is what makes this thin (the
    // Entry 44 lesson: unary_union nodes the network into two-point segments
    // that Douglas-Peucker cannot touch).
    it("london-borough-lines.geojson is a thin, deduped LineString network", () => {
        expect(boroughLines.type).toBe("FeatureCollection");
        expect(boroughLines.features.length).toBeGreaterThan(10);
        for (const f of boroughLines.features) {
            expect(f.geometry.type).toBe("LineString");
        }
        const verts = boroughLines.features.reduce(
            (n, f) => n + f.geometry.coordinates.length,
            0,
        );
        expect(verts).toBeLessThan(4000);
        // Sanity that it really is the borough network: every arc lies on some
        // borough ring.
        const allRings = boroughs.features.flatMap((f) => flatLines(f));
        for (const arc of boroughLines.features.slice(0, 12)) {
            const mid = turf.point(
                arc.geometry.coordinates[
                    Math.floor(arc.geometry.coordinates.length / 2)
                ],
            );
            expect(distTo(mid, allRings, "kilometers")).toBeLessThan(0.1);
        }
    });
});

// ── matching: same borough ──────────────────────────────────────────────────
function matchingQuestion(seeker: [number, number], same: boolean) {
    return {
        type: "london-borough",
        lat: seeker[1],
        lng: seeker[0],
        same,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

describe("adjustPerMatching — london-borough (bundled, exact)", () => {
    const base = boundary(-0.16, 51.5, 0.0, 51.58);
    const seeker: [number, number] = [-0.0553, 51.5416]; // Hackney
    const seekerDiv = boroughs.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(seeker), f),
    )!;
    const seekerLines = flatLines(seekerDiv);

    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            if (distTo(pt, seekerLines, "kilometers") <= 0.04) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
            const kept = same ? inDiv : !inDiv;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker sits in Hackney", () => {
        expect(seekerDiv.properties?.name).toBe("Hackney");
    });

    it("same: keeps exactly the seeker's borough ∩ base", async () => {
        const mask = (await adjustPerMatching(
            matchingQuestion(seeker, true) as never,
            turf.featureCollection([base]),
        )) as Feature<Polygon> | null;
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's borough from base", async () => {
        const mask = (await adjustPerMatching(
            matchingQuestion(seeker, false) as never,
            turf.featureCollection([base]),
        )) as Feature<Polygon> | null;
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);
});

// ── measuring: distance to ANY borough boundary ─────────────────────────────
async function measureMask(
    base: Feature<Polygon>,
    seeker: [number, number],
    hiderCloser: boolean,
) {
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        {
            type: "london-borough",
            lat: seeker[1],
            lng: seeker[0],
            hiderCloser,
            drag: true as const,
            color: "red" as const,
            collapsed: false,
            enabled: true,
        } as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

// This is the ALL-boroughs reading (Jules' call), not the "division you're in"
// behaviour of belgium-province / zurich-canton. The oracle therefore measures
// to every borough ring, so it fails if the handler is ever switched to the
// seeker's own borough.
describe("adjustPerMeasuring — london-borough (distance to ANY borough boundary)", () => {
    const base = boundary(-0.16, 51.5, 0.0, 51.58);
    const seeker: [number, number] = [-0.0553, 51.5416];
    const oracleLines = boroughs.features.flatMap((f) => flatLines(f));
    const dMin = distTo(turf.point(seeker), oracleLines, "miles");

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distTo(pt, oracleLines, "miles");
            // The shipped lines are simplified at ~35 m; the oracle is full
            // resolution. 8% absorbs the difference, as for Belgium.
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const closer = d <= dMin;
            const kept = hiderCloser ? closer : !closer;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("hiderCloser: keeps a band within d_min of some borough boundary", async () => {
        const mask = await measureMask(base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 28), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of every boundary", async () => {
        const mask = await measureMask(base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 28), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: mask area ≤ base for both directions", async () => {
        expect(
            turf.area((await measureMask(base, seeker, true))!),
        ).toBeLessThanOrEqual(turf.area(base));
        expect(
            turf.area((await measureMask(base, seeker, false))!),
        ).toBeLessThanOrEqual(turf.area(base));
    }, 120_000);
});
