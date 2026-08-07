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
import { isQuestionTypeHidden } from "@/lib/games";
import { grazDistrictBorderLines } from "@/maps/questions/grazAdmin";
import { adjustPerMatching } from "@/maps/questions/matching";
import { adjustPerMeasuring } from "@/maps/questions/measuring";
import {
    determineUnionizedStrings,
    gateAllows,
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

const districts = load("graz-districts.geojson");

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
// The districts come straight out of the supplied feature map's
// "Administrative divisions" folder (scripts/gen-graz-assets.py). Both question
// families resolve the ONE district containing the seeker, so a gap or an
// overlap would make the answer depend on feature order.
describe("Graz district assets", () => {
    it("graz-districts.geojson is a FeatureCollection of 17 named polygons", () => {
        expect(districts.type).toBe("FeatureCollection");
        expect(districts.features.length).toBe(17);
        for (const f of districts.features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
            expect(typeof f.properties?.osm_id).toBe("number");
        }
    });

    it("carries all 17 Bezirke by name", () => {
        const names = districts.features.map((f) => String(f.properties?.name)).sort();
        expect(names).toEqual(
            [
                "Andritz",
                "Eggenberg",
                "Geidorf",
                "Gries",
                "Gösting",
                "Innere Stadt",
                "Jakomini",
                "Lend",
                "Liebenau",
                "Mariatrost",
                "Puntigam",
                "Ries",
                "Sankt Leonhard",
                "Sankt Peter",
                "Straßgang",
                "Waltendorf",
                "Wetzelsdorf",
            ].sort(),
        );
    });

    it("districts do not overlap each other", () => {
        const feats = districts.features;
        for (let i = 0; i < feats.length; i++) {
            for (let j = i + 1; j < feats.length; j++) {
                const overlap = turf.intersect(
                    turf.featureCollection([feats[i], feats[j]] as never),
                );
                // Shared borders are legal; real overlap area is not.
                if (overlap) expect(turf.area(overlap)).toBeLessThan(1000);
            }
        }
    });

    it("every hiding zone sits inside exactly one district", () => {
        const kml = readFileSync(resolve(PUBLIC, "graz-stations.kml"), "utf8");
        const coords = [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map(
            (m) => turf.point([Number(m[1]), Number(m[2])]),
        );
        expect(coords.length).toBe(174);
        for (const pt of coords) {
            const hits = districts.features.filter((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(hits.length).toBe(1);
        }
    });

    it("the stations KML carries the tier the radius overrides key on", () => {
        const kml = readFileSync(resolve(PUBLIC, "graz-stations.kml"), "utf8");
        const tiers = [...kml.matchAll(/<Data name="tier">\s*<value>(\w+)<\/value>/g)].map(
            (m) => m[1],
        );
        const counts = tiers.reduce<Record<string, number>>((acc, t) => {
            acc[t] = (acc[t] ?? 0) + 1;
            return acc;
        }, {});
        // 400 m applies to "train" only; bus and tram take the 250 m base.
        expect(counts).toEqual({ bus: 95, tram: 72, train: 7 });
    });
});

// ── question-picker gating ──────────────────────────────────────────────────
const GRAZ = "__bundled-graz-2026__";

function pickerTypes(
    schema: typeof matchingQuestionSchema,
    kind: "matching" | "measuring",
    sentinel: string,
) {
    return schema.options
        .filter((x: any) => x.description === NO_GROUP)
        .flatMap((x: any) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter((value: string) => {
            return (
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind)
            );
        });
}

describe("question picker gating", () => {
    it("graz-district is offered for both matching and measuring", () => {
        expect(pickerTypes(matchingQuestionSchema, "matching", GRAZ)).toContain(
            "graz-district",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", GRAZ),
        ).toContain("graz-district");
    });

    it.each([
        "__bundled-belgium-2026__",
        "__bundled-london-2026__",
        "__bundled-south-limburg-2026__",
    ])("graz-district is NOT offered for %s", (other) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", other)).not.toContain(
            "graz-district",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", other),
        ).not.toContain("graz-district");
    });

    // Graz supplies 10 of the 13 rulebook POI categories; the manifest hides
    // the three it has no data for. Only the ungrouped literals are actually
    // filtered by the pickers (Entry 48), so these are the ones that bite.
    it.each(["airport", "coastline"])("%s is hidden in Graz", (type) => {
        expect(pickerTypes(measuringQuestionSchema as never, "measuring", GRAZ)).not.toContain(
            type,
        );
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

describe("adjustPerMatching — graz-district (bundled, exact)", () => {
    // A box over western Graz straddling Eggenberg, Gösting, Wetzelsdorf, Lend
    // and Gries. Picked numerically: 237 of 1024 grid points fall inside the
    // seeker's district, so both directions have plenty on either side.
    const base = boundary(15.36, 47.05, 15.44, 47.1);
    const seeker: [number, number] = [15.4, 47.07];
    const seekerDiv = districts.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(seeker), f),
    )!;
    const seekerLines = borderLines(seekerDiv);

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

    it("scenario sanity: the seeker sits in Eggenberg", () => {
        expect(seekerDiv.properties?.name).toBe("Eggenberg");
    });

    it("same: keeps exactly the seeker's district ∩ base", async () => {
        const mask = await matchMask("graz-district", base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's district from base", async () => {
        const mask = await matchMask("graz-district", base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: same-mask ⊆ base and area ≤ base", async () => {
        const mask = await matchMask("graz-district", base, seeker, true);
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

// The seeker sits at Gösting's pole of inaccessibility — 1.09 km from its own
// ring, the deepest interior point of a district big enough to give the band
// room. Graz's districts are small (1.4–21.9 km²), so a seeker near an edge
// collapses the band to a sliver: this scenario splits ~474 survive / ~254
// eliminated over a 28-step grid, where a Sankt Peter seeker degenerates to
// 32/747. Picked numerically, not by eye.
const SEEKER: [number, number] = [15.3801, 47.0978];
const seekerDistrict = districts.features.find((f) =>
    turf.booleanPointInPolygon(turf.point(SEEKER), f),
)!;
const seekerLines = borderLines(seekerDistrict);
const BASE = boundary(15.3377, 47.0661, 15.4304, 47.1315);

describe("adjustPerMeasuring — graz-district (distance to the seeker's own district border)", () => {
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

    it("scenario sanity: the seeker sits in Gösting", () => {
        expect(seekerDistrict.properties?.name).toBe("Gösting");
    });

    it("hiderCloser: keeps a band within d_min of the district border", async () => {
        const mask = await measureMask("graz-district", BASE, SEEKER, true);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of the border", async () => {
        const mask = await measureMask("graz-district", BASE, SEEKER, false);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: mask area ≤ base for both directions", async () => {
        expect(
            turf.area((await measureMask("graz-district", BASE, SEEKER, true))!),
        ).toBeLessThanOrEqual(turf.area(BASE));
        expect(
            turf.area((await measureMask("graz-district", BASE, SEEKER, false))!),
        ).toBeLessThanOrEqual(turf.area(BASE));
    }, 120_000);
});

describe("graz-district measuring uses only the seeker's own district", () => {
    // This is the belgium-province / zurich-canton reading, NOT the
    // london-borough all-boroughs one. Jules' explicit call. If anyone
    // "fixes" measuring to use every district border, this test flips.
    it("measures the seeker's district border, not every district's", async () => {
        const lines = await grazDistrictBorderLines(
            "graz-district",
            SEEKER[1],
            SEEKER[0],
        );
        expect(lines?.length).toBeGreaterThan(0);

        // Deep in Liebenau, across the city from Gösting: ~7.5 km from
        // Gösting's ring but under 1 km from the nearest district border
        // anywhere. With 17 districts over a compact city, every point is near
        // *some* border — which is exactly why the two readings diverge here.
        const inLiebenau = turf.point([15.465, 47.03]);
        const measured = distToBorder(
            inLiebenau,
            lines!.flatMap((l: Feature) =>
                l.geometry.type === "MultiLineString"
                    ? (l.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
                    : [l as Feature<LineString>],
            ),
            "kilometers",
        );
        const own = distToBorder(inLiebenau, seekerLines, "kilometers");
        const any = Math.min(
            ...districts.features.map((f) =>
                distToBorder(inLiebenau, borderLines(f), "kilometers"),
            ),
        );

        expect(measured).toBeCloseTo(own, 0); // handler simplifies at ~55 m
        expect(any).toBeLessThan(own);
        expect(own).toBeGreaterThan(5);
        expect(any).toBeLessThan(2);
    }, 120_000);
});
