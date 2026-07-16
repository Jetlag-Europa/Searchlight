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

// Same faithful arcBufferToPoint stub as intlBorderOg.test.ts: the surviving
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
import { isQuestionTypeHidden } from "@/lib/games";
import { adjustPerMatching } from "@/maps/questions/matching";
import { adjustPerMeasuring } from "@/maps/questions/measuring";
import {
    determineUnionizedStrings,
    GAME_GATED_TYPES,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const MI = { units: "miles" as const };

const load = (f: string) =>
    JSON.parse(readFileSync(resolve(PUBLIC, f), "utf8")) as FeatureCollection<
        Polygon | MultiPolygon
    >;

const regions = load("belgium-regions.geojson");
const arrondissements = load("belgium-arrondissements.geojson");

// Several divisions are MultiPolygons (exclaves), for which polygonToLine
// returns a FeatureCollection and/or MultiLineStrings — neither of which
// pointToLineDistance accepts. Flatten to plain LineStrings and take the min.
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
// These assets are generated from OSM (scripts/gen-belgium-assets.py) rather
// than the supplied CSVs, precisely because the CSVs had gaps between
// neighbours and omitted Brussels. Assert those properties so a regeneration
// that reintroduces either is caught here.
describe("Belgium admin assets", () => {
    it.each([
        ["belgium-regions.geojson", regions, 3],
        ["belgium-arrondissements.geojson", arrondissements, 43],
    ])("%s is a FeatureCollection of %s named polygons", (_f, fc, count) => {
        expect((fc as FeatureCollection).type).toBe("FeatureCollection");
        expect((fc as FeatureCollection).features.length).toBe(count);
        for (const f of (fc as FeatureCollection).features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
        }
    });

    it("regions include Brussels-Capital (the gap in the supplied CSV)", () => {
        const names = regions.features.map((f) => String(f.properties?.name));
        expect(names.some((n) => /Bruxelles|Brussel/.test(n))).toBe(true);
        expect(names).toContain("Vlaanderen");
        expect(names).toContain("Wallonie");
    });

    it("arrondissements do not overlap each other", () => {
        // Sample: every pair is O(n^2) turf.intersect on 40k verts and too slow
        // here; neighbours around Gent are where a tear would show up.
        const near = arrondissements.features.filter((f) =>
            turf.booleanIntersects(f, turf.bboxPolygon([3.4, 50.9, 4.1, 51.3])),
        );
        expect(near.length).toBeGreaterThan(3);
        for (let i = 0; i < near.length; i++) {
            for (let j = i + 1; j < near.length; j++) {
                const overlap = turf.intersect(
                    turf.featureCollection([near[i], near[j]] as never),
                );
                // Shared borders are legal; real overlap area is not.
                if (overlap) expect(turf.area(overlap)).toBeLessThan(1000);
            }
        }
    });
});

// ── question-picker gating ──────────────────────────────────────────────────
// Mirrors the filter in components/cards/{matching,measuring}.tsx: a type shows
// up only if it is ungated or gated to the active game, and not hidden by the
// manifest. Guards the "wired the handler but forgot GAME_GATED_TYPES" mistake,
// which would leak Belgium types into every other game's picker.
const BELGIUM = "__bundled-belgium-2026__";

function pickerTypes(schema: typeof matchingQuestionSchema, kind: "matching" | "measuring", sentinel: string) {
    return schema.options
        .filter((x: any) => x.description === NO_GROUP)
        .flatMap((x: any) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter((value: string) => {
            const required = GAME_GATED_TYPES[value];
            return (
                (!required || required === sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind)
            );
        });
}

describe("question picker gating", () => {
    // The two types are deliberately one-sided: there is no "same region"
    // match, and no arrondissement border-distance (it eliminated only ~4%).
    it("belgium-arrondissement is offered for matching only, never measuring", () => {
        expect(pickerTypes(matchingQuestionSchema, "matching", BELGIUM)).toContain(
            "belgium-arrondissement",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", BELGIUM),
        ).not.toContain("belgium-arrondissement");
    });

    it("belgium-region is offered for measuring only, never matching", () => {
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", BELGIUM),
        ).toContain("belgium-region");
        expect(pickerTypes(matchingQuestionSchema, "matching", BELGIUM)).not.toContain(
            "belgium-region",
        );
    });

    it.each(["belgium-region", "belgium-arrondissement"])(
        "%s is NOT offered for another game",
        (type) => {
            const other = "__bundled-south-limburg-2026__";
            expect(pickerTypes(matchingQuestionSchema, "matching", other)).not.toContain(type);
            expect(
                pickerTypes(measuringQuestionSchema as never, "measuring", other),
            ).not.toContain(type);
        },
    );
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

describe("adjustPerMatching — belgium-arrondissement (bundled, exact)", () => {
    // A box around Gent straddling several arrondissements.
    const base = turf.bboxPolygon([3.55, 50.95, 3.95, 51.15]) as Feature<Polygon>;
    const seeker: [number, number] = [3.72, 51.05]; // Gent
    const seekerDiv = arrondissements.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(seeker), f),
    )!;
    const seekerLines = borderLines(seekerDiv);

    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            // Only float noise on the shared edge is ambiguous (~40 m).
            if (distToBorder(pt, seekerLines, "kilometers") <= 0.04)
                return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
            const kept = same ? inDiv : !inDiv;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker sits in Gent", () => {
        expect(seekerDiv.properties?.name).toBe("Gent");
    });

    it("same: keeps exactly the seeker's arrondissement ∩ base", async () => {
        const mask = await matchMask("belgium-arrondissement", base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's arrondissement from base", async () => {
        const mask = await matchMask("belgium-arrondissement", base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: same-mask ⊆ base and area ≤ base", async () => {
        const mask = await matchMask("belgium-arrondissement", base, seeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
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

// Measuring is against EVERY border at the level, so the oracle is built from
// all divisions' borders — not just the seeker's. Built at full resolution; the
// handler simplifies at ~55 m, which the 8% ambiguity margin absorbs.
const allLinesFor = (fc: FeatureCollection<Polygon | MultiPolygon>) =>
    fc.features.flatMap((f) => borderLines(f));

const allRegionLines = allLinesFor(regions);

function measuringSuite(
    type: string,
    label: string,
    lines: Feature<LineString>[],
    base: Feature<Polygon>,
    seeker: [number, number],
) {
    describe(`adjustPerMeasuring — ${type} (distance to ANY ${label} border)`, () => {
        const dMin = distToBorder(turf.point(seeker), lines, MI.units);

        const verdictFor =
            (hiderCloser: boolean) =>
            (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
                const d = distToBorder(pt, lines, MI.units);
                if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
                const inBase = turf.booleanPointInPolygon(pt, base);
                const closer = d <= dMin;
                const kept = hiderCloser ? closer : !closer;
                return inBase && kept ? "survives" : "eliminated";
            };

        it(`hiderCloser: keeps a band within d_min of the nearest ${label} border`, async () => {
            const mask = await measureMask(type, base, seeker, true);
            const r = gridAgreement(mask, sampleGrid(base, 28), verdictFor(true));
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }, 120_000);

        it("!hiderCloser: keeps points beyond d_min of the border", async () => {
            const mask = await measureMask(type, base, seeker, false);
            const r = gridAgreement(mask, sampleGrid(base, 28), verdictFor(false));
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }, 120_000);

        it("invariant: mask area ≤ base for both directions", async () => {
            expect(
                turf.area((await measureMask(type, base, seeker, true))!),
            ).toBeLessThanOrEqual(turf.area(base));
            expect(
                turf.area((await measureMask(type, base, seeker, false))!),
            ).toBeLessThanOrEqual(turf.area(base));
        }, 120_000);
    });
}

// A box in Flanders that also reaches Wallonia and the Brussels ring, so a
// per-region implementation (the bug: only the seeker's own region's border was
// measured) disagrees with the oracle here.
measuringSuite(
    "belgium-region",
    "region",
    allRegionLines,
    boundary(4.0, 50.6, 4.5, 50.95),
    [4.25, 50.85], // Flanders, between Brussels and the Wallonia border
);

describe("belgium-region measuring uses every region's border", () => {
    it("includes borders that are not on the seeker's own region", async () => {
        const seeker: [number, number] = [4.25, 50.85];
        const seekerRegion = regions.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(seeker), f),
        )!;
        expect(seekerRegion.properties?.name).toBe("Vlaanderen");

        // A point deep inside Wallonia, far from any Flanders border: its
        // distance to ALL region borders must be strictly smaller than its
        // distance to Flanders' border alone. If measuring ever reverts to the
        // seeker's own region, this gap disappears.
        const inWallonia = turf.point([5.0, 50.0]);
        const dAll = distToBorder(inWallonia, allRegionLines, "kilometers");
        const dOwn = distToBorder(inWallonia, borderLines(seekerRegion), "kilometers");
        expect(dAll).toBeLessThan(dOwn);
    }, 120_000);
});
