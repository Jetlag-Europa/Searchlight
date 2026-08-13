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

// Same faithful arcBufferToPoint stub as grazAdmin.test.ts: the surviving
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
import { parisArrondissementBorderLines } from "@/maps/questions/parisAdmin";
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

const arrondissements = load("paris-arrondissements.geojson");
const border = load("paris-border.geojson");

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
// The arrondissements come straight out of the supplied "Paris Arrondissements
// v0.1" layer (scripts/gen-paris-assets.py). Both question families resolve the
// ONE region containing the seeker, so a gap or an overlap would make the answer
// depend on feature order.
describe("Paris arrondissement assets", () => {
    it("paris-arrondissements.geojson is a FeatureCollection of 21 named polygons", () => {
        expect(arrondissements.type).toBe("FeatureCollection");
        expect(arrondissements.features.length).toBe(21);
        for (const f of arrondissements.features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
            expect(typeof f.properties?.osm_id).toBe("number");
        }
    });

    it("carries the 20 numbered arrondissements plus the Outer catch-all", () => {
        const numbered = arrondissements.features
            .filter((f) => !f.properties?.outer)
            .map((f) => Number(f.properties?.number))
            .sort((a, b) => a - b);
        expect(numbered).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

        const outer = arrondissements.features.filter((f) => f.properties?.outer);
        expect(outer.length).toBe(1);
        expect(outer[0].properties?.name).toBe("Outer");
    });

    // "Outer" is the play-area rectangle with Paris punched out — not an
    // administrative division. It is kept as a real region on purpose (Jules'
    // call): without it, the 186 outer-zone hiding spots would have no answer.
    it("Outer is the play area with Paris as a hole", () => {
        const outer = arrondissements.features.find((f) => f.properties?.outer)!;
        expect(outer.geometry.type).toBe("Polygon");
        const rings = (outer.geometry as Polygon).coordinates;
        expect(rings.length).toBe(2); // exterior + one hole

        // Its exterior is the play-area boundary itself.
        const outerRing = turf.polygon([rings[0]]);
        const sym = turf.area(outerRing) - turf.area(border.features[0] as never);
        expect(Math.abs(sym)).toBeLessThan(turf.area(border.features[0] as never) * 0.001);

        // The hole is Paris proper: the 20 numbered arrondissements fill it.
        const paris = turf.union(
            turf.featureCollection(
                arrondissements.features.filter((f) => !f.properties?.outer) as never,
            ),
        )!;
        const hole = turf.polygon([rings[1]]);
        expect(turf.area(hole)).toBeCloseTo(turf.area(paris), -6);
    });

    it("arrondissements do not overlap each other", () => {
        const feats = arrondissements.features;
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

    it("every hiding zone sits inside exactly one arrondissement", () => {
        const kml = readFileSync(resolve(PUBLIC, "paris-stations.kml"), "utf8");
        const coords = [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map(
            (m) => turf.point([Number(m[1]), Number(m[2])]),
        );
        expect(coords.length).toBe(412);
        for (const pt of coords) {
            const hits = arrondissements.features.filter((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(hits.length).toBe(1);
        }
    });

    it("the stations KML carries the tier the radius overrides key on", () => {
        const kml = readFileSync(resolve(PUBLIC, "paris-stations.kml"), "utf8");
        const tiers = [...kml.matchAll(/<Data name="tier">\s*<value>(\w+)<\/value>/g)].map(
            (m) => m[1],
        );
        const counts = tiers.reduce<Record<string, number>>((acc, t) => {
            acc[t] = (acc[t] ?? 0) + 1;
            return acc;
        }, {});
        // 600 m applies to "Outer" only; Inner takes the 400 m base. The
        // capitalisation matters — it is matched against tierRadiusOverrides.
        expect(counts).toEqual({ Inner: 226, Outer: 186 });
    });

    it("the POI KML supplies 11 canonical categories", () => {
        const kml = readFileSync(resolve(PUBLIC, "paris-poi.kml"), "utf8");
        const counts: Record<string, number> = {};
        for (const m of kml.matchAll(
            /<Folder><name>(\w+)<\/name>([\s\S]*?)<\/Folder>/g,
        )) {
            counts[m[1]] = [...m[2].matchAll(/<Placemark>/g)].length;
        }
        expect(counts).toEqual({
            airport: 2,
            aquarium: 3,
            cinema: 234,
            consulate: 41,
            golf_course: 37,
            hospital: 119,
            library: 577,
            museum: 295,
            park: 455,
            theme_park: 17,
            zoo: 14,
        });
    });
});

// ── question-picker gating ──────────────────────────────────────────────────
const PARIS = "__bundled-paris-2026__";

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
    it("paris-arrondissement is offered for both matching and measuring", () => {
        expect(pickerTypes(matchingQuestionSchema, "matching", PARIS)).toContain(
            "paris-arrondissement",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", PARIS),
        ).toContain("paris-arrondissement");
    });

    it.each([
        "__bundled-graz-2026__",
        "__bundled-london-2026__",
        "__bundled-belgium-2026__",
    ])("paris-arrondissement is NOT offered for %s", (other) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", other)).not.toContain(
            "paris-arrondissement",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", other),
        ).not.toContain("paris-arrondissement");
    });

    // Paris supplies 11 of the 13 rulebook POI categories; the manifest hides
    // the two it has no data for. Only the ungrouped literals are actually
    // filtered by the pickers (Entry 48), so these are the ones that bite.
    it.each(["peak-full", "coastline"])("%s is hidden in Paris", (type) => {
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", PARIS),
        ).not.toContain(type);
    });

    // Paris DOES supply airports and aquariums, so these must stay available —
    // a copy-paste of Graz's hidden list would have wrongly removed them. Note
    // the aquarium literal in the ungrouped picker is "aquarium-full"; bare
    // "aquarium" lives in the Hiding Zone Mode group and is never filtered.
    it.each(["airport", "aquarium-full"])("%s stays available in Paris", (type) => {
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", PARIS),
        ).toContain(type);
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

describe("adjustPerMatching — paris-arrondissement (bundled, exact)", () => {
    // A box over western Paris straddling the 16e, 15e, 17e, 7e, 8e and Outer.
    // Picked numerically: 533 of 1024 grid points fall inside the seeker's
    // arrondissement, a near-even split, so both directions have plenty on
    // either side. Central-Paris boxes degenerate badly (a 1er seeker splits
    // 71/953) because the inner arrondissements are tiny.
    const base = boundary(2.225, 48.835, 2.305, 48.883);
    const seeker: [number, number] = [2.2638, 48.8588];
    const seekerDiv = arrondissements.features.find((f) =>
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

    it("scenario sanity: the seeker sits in the 16e", () => {
        expect(seekerDiv.properties?.name).toBe("16e Arrondissement");
    });

    it("same: keeps exactly the seeker's arrondissement ∩ base", async () => {
        const mask = await matchMask("paris-arrondissement", base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's arrondissement from base", async () => {
        const mask = await matchMask("paris-arrondissement", base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: same-mask ⊆ base and area ≤ base", async () => {
        const mask = await matchMask("paris-arrondissement", base, seeker, true);
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

// The seeker sits at the 16e's pole of inaccessibility — 1.35 km from its own
// ring, the deepest interior point of any Paris arrondissement, in the largest
// one (16.4 km²). As in Graz, a seeker near an edge collapses the band to a
// sliver, so this was picked numerically: it splits ~472 survive / ~249
// eliminated over a 28-step grid.
const SEEKER: [number, number] = [2.2638, 48.8588];
const seekerArr = arrondissements.features.find((f) =>
    turf.booleanPointInPolygon(turf.point(SEEKER), f),
)!;
const seekerLines = borderLines(seekerArr);
const BASE = boundary(2.2038, 48.8192, 2.3238, 48.8984);

describe("adjustPerMeasuring — paris-arrondissement (distance to the seeker's own border)", () => {
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

    it("scenario sanity: the seeker sits in the 16e", () => {
        expect(seekerArr.properties?.name).toBe("16e Arrondissement");
    });

    it("hiderCloser: keeps a band within d_min of the arrondissement border", async () => {
        const mask = await measureMask("paris-arrondissement", BASE, SEEKER, true);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of the border", async () => {
        const mask = await measureMask("paris-arrondissement", BASE, SEEKER, false);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("invariant: mask area ≤ base for both directions", async () => {
        expect(
            turf.area((await measureMask("paris-arrondissement", BASE, SEEKER, true))!),
        ).toBeLessThanOrEqual(turf.area(BASE));
        expect(
            turf.area((await measureMask("paris-arrondissement", BASE, SEEKER, false))!),
        ).toBeLessThanOrEqual(turf.area(BASE));
    }, 120_000);
});

describe("paris-arrondissement measuring uses only the seeker's own arrondissement", () => {
    // This is the belgium-province / graz-district reading, NOT the
    // london-borough all-boroughs one. Jules' call, consistent with every time
    // he has been asked. If anyone "fixes" measuring to use every border, this
    // test flips.
    it("measures the seeker's own border, not every arrondissement's", async () => {
        const lines = await parisArrondissementBorderLines(
            "paris-arrondissement",
            SEEKER[1],
            SEEKER[0],
        );
        expect(lines?.length).toBeGreaterThan(0);

        // Deep in the 12e, across the city from the 16e: ~12 km from the 16e's
        // ring but ~1 km from the nearest arrondissement border anywhere. With
        // 20 arrondissements over a compact city, every point is near *some*
        // border — which is exactly why the two readings diverge.
        const inTwelfth = turf.point([2.45, 48.831]);
        const measured = distToBorder(
            inTwelfth,
            lines!.flatMap((l: Feature) =>
                l.geometry.type === "MultiLineString"
                    ? (l.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
                    : [l as Feature<LineString>],
            ),
            "kilometers",
        );
        const own = distToBorder(inTwelfth, seekerLines, "kilometers");
        const any = Math.min(
            ...arrondissements.features.map((f) =>
                distToBorder(inTwelfth, borderLines(f), "kilometers"),
            ),
        );

        expect(measured).toBeCloseTo(own, 0); // handler simplifies at ~55 m
        expect(any).toBeLessThan(own);
        expect(own).toBeGreaterThan(8);
        expect(any).toBeLessThan(2);
    }, 120_000);
});

describe("the Outer region answers for hiders beyond the city limits", () => {
    // 186 of the 412 hiding zones are outside Paris proper. Keeping "Outer" as
    // a real region is what makes the questions answerable for them.
    const OUTSIDE: [number, number] = [2.1, 48.75];

    it("resolves a suburban point to Outer, not to nothing", async () => {
        const hit = arrondissements.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(OUTSIDE), f),
        );
        expect(hit?.properties?.name).toBe("Outer");
    });

    it("its border is both the city limits and the map edge", async () => {
        const lines = await parisArrondissementBorderLines(
            "paris-arrondissement",
            OUTSIDE[1],
            OUTSIDE[0],
        );
        const flat = lines!.flatMap((l: Feature) =>
            l.geometry.type === "MultiLineString"
                ? (l.geometry.coordinates as number[][][]).map((c) => turf.lineString(c))
                : [l as Feature<LineString>],
        );
        // Two rings: the rectangle, and the hole around Paris.
        expect(flat.length).toBe(2);

        // The nearer of the two from this point is the map edge, but Paris is
        // within reach — both genuinely bound the region the hider is in.
        const dists = flat
            .map((l) => turf.pointToLineDistance(turf.point(OUTSIDE), l, {
                units: "kilometers",
            }))
            .sort((a, b) => a - b);
        expect(dists[0]).toBeGreaterThan(0);
        expect(dists[1]).toBeLessThan(30);
    }, 120_000);
});
