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

// Same faithful arcBufferToPoint stub as grazAdmin/parisAdmin/milanAdmin.
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
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const MI = { units: "miles" as const };
const BRIGHTON = "__bundled-brighton-2026__";

const load = (f: string) =>
    JSON.parse(readFileSync(resolve(PUBLIC, f), "utf8")) as FeatureCollection<
        Polygon | MultiPolygon
    >;

const wards = load("brighton-wards.geojson");
const postcodes = load("brighton-postcodes.geojson");
const border = load("brighton-border.geojson");

// Production simplifies the ring at this tolerance before measuring against it,
// so the oracle uses the same figure — faithful, and it keeps the tight grid
// loops off the full-resolution rings.
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

const stationPoints = () => {
    const kml = readFileSync(resolve(PUBLIC, "brighton-stations.kml"), "utf8");
    return [...kml.matchAll(/<coordinates>([-\d.]+),([-\d.]+)/g)].map((m) =>
        turf.point([Number(m[1]), Number(m[2])]),
    );
};

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

// ── assets ───────────────────────────────────────────────────────────────────

describe("Brighton admin assets", () => {
    it("ships 24 wards plus Outer, and 8 postcodes plus Outer", () => {
        const wn = wards.features.map((f) => String(f.properties?.name));
        const pn = postcodes.features.map((f) => String(f.properties?.name));
        expect(wn).toHaveLength(25);
        expect(pn).toHaveLength(9);
        expect(wn).toContain("Outer");
        expect(pn).toContain("Outer");
        // Real ONS names, not the source KML's "Polygon 28" placemark labels.
        expect(wn).toContain("Patcham & Hollingbury");
        expect(wn).toContain("Queen's Park");
        expect(pn).toEqual(
            expect.arrayContaining(["BN1", "BN2", "BN3", "BN41", "BN42", "BN45"]),
        );
        for (const f of [...wards.features, ...postcodes.features]) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
        }
    });

    it.each([
        ["wards", () => wards],
        ["postcodes", () => postcodes],
    ])("%s tile the play area with no overlaps", async (_label, get) => {
        const fc = get();
        const feats = fc.features;
        const boxes = feats.map((f) => turf.bbox(f));
        const disjoint = (a: number[], b: number[]) =>
            a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
        for (let i = 0; i < feats.length; i++) {
            await new Promise((r) => setTimeout(r, 0));
            for (let j = i + 1; j < feats.length; j++) {
                if (disjoint(boxes[i], boxes[j])) continue;
                const ov = turf.intersect(
                    turf.featureCollection([feats[i], feats[j]] as never),
                );
                if (ov) expect(turf.area(ov)).toBeLessThan(5);
            }
        }
        const union = turf.union(fc as never)!;
        const uncovered = turf.difference(
            turf.featureCollection([border.features[0], union] as never),
        );
        const frac = uncovered ? turf.area(uncovered) / turf.area(border.features[0]) : 0;
        expect(frac).toBeLessThan(0.0005);
    }, 60_000);

    it.each([
        ["wards", () => wards],
        ["postcodes", () => postcodes],
    ])("every hiding zone sits in exactly one %s region", (_label, get) => {
        const pts = stationPoints();
        expect(pts).toHaveLength(132);
        for (const pt of pts) {
            const hits = get().features.filter((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(hits).toHaveLength(1);
        }
    });

    // Outer exists so the lookup always resolves, not because players go there.
    // If a future regenerate dumps real play area into Outer, this catches it.
    it("Outer is a small remainder holding no hiding zones", () => {
        const pts = stationPoints();
        const area = turf.area(border.features[0]);
        for (const fc of [wards, postcodes]) {
            const outer = fc.features.find((f) => f.properties?.name === "Outer")!;
            expect(turf.area(outer) / area).toBeLessThan(0.005);
            for (const pt of pts)
                expect(turf.booleanPointInPolygon(pt, outer)).toBe(false);
        }
    });
});

// ── the expanded play area ───────────────────────────────────────────────────
// The supplied game area clipped 14 hiding zones; it was pushed out additively
// to cover everything walkable they reached. Both halves are asserted: that it
// grew, and that it never shrank.
describe("Brighton play area was expanded, never trimmed", () => {
    it("is a single hole-free polygon of about 82.62 km²", () => {
        expect(border.type).toBe("FeatureCollection");
        expect(border.features).toHaveLength(1);
        const g = border.features[0].geometry as Polygon;
        expect(g.type).toBe("Polygon");
        expect(g.coordinates).toHaveLength(1); // no interior rings
        const km2 = turf.area(border.features[0]) / 1e6;
        expect(km2).toBeGreaterThan(82.5);
        expect(km2).toBeLessThan(82.7);
    });

    it("contains Brighton Palace Pier, which a strict coastline clip would have cut", () => {
        // The pier is seaward of the OSM coastline. Clipping the south edge to
        // that line would have deleted ~20,000 m² of walkable, in-play ground —
        // which is why the expansion is additive only. Don't "tidy" this away.
        expect(
            turf.booleanPointInPolygon(
                turf.point([-0.1369, 50.816]),
                border.features[0],
            ),
        ).toBe(true);
    });

    it("keeps every hiding zone's centre inside the play area", () => {
        for (const pt of stationPoints())
            expect(turf.booleanPointInPolygon(pt, border.features[0])).toBe(true);
    });
});

// ── coastline ────────────────────────────────────────────────────────────────

describe("Brighton coastline", () => {
    it("is a single line of roughly 18.6 km between the author's two markers", () => {
        const fc = JSON.parse(
            readFileSync(resolve(PUBLIC, "brighton-coastline.geojson"), "utf8"),
        ) as FeatureCollection<LineString>;
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry.type).toBe("LineString");
        const km = turf.length(fc.features[0], { units: "kilometers" });
        expect(km).toBeGreaterThan(17);
        expect(km).toBeLessThan(20);
        const ends = turf.explode(fc.features[0]).features;
        const near = (lng: number, lat: number) =>
            Math.min(
                ...ends.map((e) => turf.distance(e, turf.point([lng, lat]), MI)),
            ) *
            1609 <
            60;
        expect(near(-0.216034, 50.827584)).toBe(true); // Coastline End W
        expect(near(-0.0385633, 50.7990792)).toBe(true); // Coastline End E
    });
});

// ── picker gating ────────────────────────────────────────────────────────────

const BRIGHTON_TYPES = [
    "brighton-ward",
    "brighton-postcode",
    "brighton-rail",
];

function pickerTypes(
    schema: typeof matchingQuestionSchema,
    kind: "matching" | "measuring",
    sentinel: string,
) {
    return schema.options
        .filter((x: any) => x.description === NO_GROUP)
        .flatMap((x: any) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter(
            (value: string) =>
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind),
        );
}

describe("Brighton question picker gating", () => {
    it.each(BRIGHTON_TYPES)("%s is offered for both families", (t) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", BRIGHTON)).toContain(t);
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", BRIGHTON),
        ).toContain(t);
    });

    it("brighton-coastline is measuring-only, and replaces the generic coastline", () => {
        const d = pickerTypes(measuringQuestionSchema as never, "measuring", BRIGHTON);
        expect(d).toContain("brighton-coastline");
        // The bundled 26.7 km of real coast supersedes the Overpass question.
        expect(d).not.toContain("coastline");
    });

    it.each(["__bundled-milan-2026__", "__bundled-london-2026__"])(
        "no Brighton type is offered for %s",
        (other) => {
            const m = pickerTypes(matchingQuestionSchema, "matching", other);
            const d = pickerTypes(measuringQuestionSchema as never, "measuring", other);
            for (const t of [...BRIGHTON_TYPES, "brighton-coastline"]) {
                expect(m).not.toContain(t);
                expect(d).not.toContain(t);
            }
        },
    );

    it("hides the categories the play area has none of, keeps the ones it has", () => {
        const m = pickerTypes(matchingQuestionSchema, "matching", BRIGHTON);
        for (const t of ["airport", "aquarium-full", "zoo-full", "theme_park-full", "consulate-full"])
            expect(m, `should hide ${t}`).not.toContain(t);
        // Brighton DOES supply these — a copy-pasted hidden list would break them.
        for (const t of ["park-full", "library-full", "museum-full", "hospital-full", "golf_course-full", "cinema-full", "peak-full"])
            expect(m, `should keep ${t}`).toContain(t);
    });
});

// ── matching ─────────────────────────────────────────────────────────────────

function matchingQuestion(type: string, seeker: [number, number], same: boolean) {
    return {
        type, lat: seeker[1], lng: seeker[0], same,
        drag: true as const, color: "red" as const, collapsed: false, enabled: true,
    };
}

async function matchMask(
    type: string, base: Feature<Polygon>, seeker: [number, number], same: boolean,
) {
    return (await adjustPerMatching(
        matchingQuestion(type, seeker, same) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe.each([
    ["brighton-ward", wards, [-0.1372, 50.8425] as [number, number]],
    ["brighton-postcode", postcodes, [-0.1372, 50.8425] as [number, number]],
])("adjustPerMatching — %s (bundled, exact)", (type, fc, seeker) => {
    const base = boundary(-0.19, 50.81, -0.09, 50.87);
    const seekerDiv = fc.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(seeker), f),
    )!;
    const seekerLines = borderLines(turf.simplify(seekerDiv as never, RING_SIMPLIFY));

    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            if (distToBorder(pt, seekerLines, "kilometers") <= 0.04) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
            const kept = same ? inDiv : !inDiv;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker resolves to exactly one region", () => {
        expect(
            fc.features.filter((f) =>
                turf.booleanPointInPolygon(turf.point(seeker), f),
            ),
        ).toHaveLength(1);
    });

    it("same: keeps exactly the seeker's region ∩ base", async () => {
        const mask = await matchMask(type, base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!same: removes the seeker's region from base", async () => {
        const mask = await matchMask(type, base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 32), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);
});

// ── measuring ────────────────────────────────────────────────────────────────

function measuringQuestion(
    type: string, seeker: [number, number], hiderCloser: boolean,
) {
    return {
        type, lat: seeker[1], lng: seeker[0], hiderCloser,
        drag: true as const, color: "red" as const, collapsed: false, enabled: true,
    };
}

async function measureMask(
    type: string, base: Feature<Polygon>, seeker: [number, number], hiderCloser: boolean,
) {
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        measuringQuestion(type, seeker, hiderCloser) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

// BN1 is one of the two biggest districts, so the band has room. A ward seeker
// would collapse it — the wards average 3.4 km², which is the whole reason the
// ward measuring figure is lopsided (see the balance test below).
describe("adjustPerMeasuring — brighton-postcode (seeker's OWN border)", () => {
    const SEEKER: [number, number] = [-0.1372, 50.8425];
    const BASE = boundary(-0.21, 50.80, -0.06, 50.89);
    const div = postcodes.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(SEEKER), f),
    )!;
    const lines = borderLines(turf.simplify(div as never, RING_SIMPLIFY));
    const dMin = distToBorder(turf.point(SEEKER), lines, MI.units);

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distToBorder(pt, lines, MI.units);
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, BASE);
            const closer = d <= dMin;
            return inBase && (hiderCloser ? closer : !closer) ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker is in BN1", () => {
        expect(div.properties?.name).toBe("BN1");
    });

    it("hiderCloser: keeps a band within d_min of the postcode border", async () => {
        const mask = await measureMask("brighton-postcode", BASE, SEEKER, true);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of the border", async () => {
        const mask = await measureMask("brighton-postcode", BASE, SEEKER, false);
        const r = gridAgreement(mask, sampleGrid(BASE, 28), verdictFor(false));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    // Own-region, NOT the nearest of all 9 (the london-borough reading).
    // Written against the own ring on purpose so it fails loudly if anyone
    // "fixes" it to all-borders. Don't.
    it("uses the seeker's own ring, not the nearest of any region", () => {
        const far = turf.point([-0.1372, 50.8425]);
        const own = distToBorder(far, lines, "kilometers");
        const any = Math.min(
            ...postcodes.features.flatMap((f) =>
                borderLines(turf.simplify(f as never, RING_SIMPLIFY)).map((l) =>
                    turf.pointToLineDistance(far, l, { units: "kilometers" }),
                ),
            ),
        );
        expect(own).toBeGreaterThanOrEqual(any);
    });
});

// ── the balance figures, pinned ──────────────────────────────────────────────
// Recorded in brightonAdmin.ts and here. Ward measuring is deliberately
// lopsided (mean ~5.4%): 24 small wards, so it eliminates ~95% when true and is
// therefore rarely true. That is the opposite of belgium-arrondissement's 96%
// (which eliminated nothing and was cut), and marginally tighter than
// Stockholm's admin3 (6.5%), which was shipped after review. Postcodes at ~25%
// are the best-balanced admin measuring in the codebase.
describe("Brighton measuring balance is as measured", () => {
    it.each([
        ["brighton-ward", () => wards, 0.02, 0.1],
        ["brighton-postcode", () => postcodes, 0.15, 0.4],
    ])("%s keeps a mean fraction of zones within the expected band", (_t, get, lo, hi) => {
        const fc = get();
        const zones = stationPoints();
        const rings = fc.features.map((f) =>
            borderLines(turf.simplify(f as never, RING_SIMPLIFY)),
        );
        const own = zones.map((p) =>
            fc.features.findIndex((f) => turf.booleanPointInPolygon(p, f)),
        );
        expect(own.every((i) => i >= 0)).toBe(true);
        const dist = zones.map((p) =>
            rings.map((ls) => distToBorder(p, ls, "kilometers")),
        );
        let total = 0;
        for (let s = 0; s < zones.length; s++) {
            const d = own[s];
            total += dist.filter((row) => row[d] < dist[s][d]).length / zones.length;
        }
        const mean = total / zones.length;
        expect(mean).toBeGreaterThan(lo);
        expect(mean).toBeLessThan(hi);
    }, 120_000);
});

// ══ Greater Manchester 19-9 ══════════════════════════════════════════════════
// Lives in this file, not its own: the web suite is at 30 files, and a 31st
// reintroduces the vitest worker-RPC onTaskUpdate timeout (Journal Entry 57/58).
// Same shape as Brighton — bundled admin layers, own-region measuring — so it
// reuses the helpers above. Ward/borough tiling is asserted by the generator
// (gen-greater-manchester-assets.py) rather than here: a turf union of 215
// wards is too slow for the suite.

const GM = "__bundled-greater-manchester-2026__";
const gmBoroughs = load("gm-boroughs.geojson");
const gmWards = load("gm-wards.geojson");
const gmHslRegions = load("gm-hsl-regions.geojson");
const gmBorder = load("gm-border.geojson");
const gmHsl = JSON.parse(
    readFileSync(resolve(PUBLIC, "gm-hsl.geojson"), "utf8"),
) as FeatureCollection<LineString>;

const gmStationPoints = () => {
    const kml = readFileSync(resolve(PUBLIC, "gm-stations.kml"), "utf8");
    return [
        ...kml.matchAll(
            /<name>([^<]*)<\/name><Point><coordinates>([-\d.]+),([-\d.]+)/g,
        ),
    ].map((m) => turf.point([Number(m[2]), Number(m[3])], { name: m[1] }));
};

// Piccadilly Gardens, the author's start marker: Manchester borough, nearer the
// southern WCML stretch.
const GM_SEEKER: [number, number] = [-2.2370911, 53.4808872];

describe("Greater Manchester assets", () => {
    it("ships 168 hiding zones, all inside the play area", () => {
        const pts = gmStationPoints();
        expect(pts).toHaveLength(168);
        for (const pt of pts)
            expect(turf.booleanPointInPolygon(pt, gmBorder.features[0])).toBe(true);
        // Bus stations with a circle are hiding zones too (Jules' rule).
        expect(pts.map((p) => p.properties.name)).toContain("Wigan Bus Station");
    });

    it("is a single hole-free polygon of about 1,271 km²", () => {
        expect(gmBorder.features).toHaveLength(1);
        const g = gmBorder.features[0].geometry as Polygon;
        expect(g.type).toBe("Polygon");
        expect(g.coordinates).toHaveLength(1);
        const km2 = turf.area(gmBorder.features[0]) / 1e6;
        expect(km2).toBeGreaterThan(1265);
        expect(km2).toBeLessThan(1278);
    });

    it("has the 10 boroughs and 215 wards, with no Outer", () => {
        const bn = gmBoroughs.features.map((f) => String(f.properties?.name));
        const wn = gmWards.features.map((f) => String(f.properties?.name));
        expect(bn.sort()).toEqual([
            "Bolton", "Bury", "Manchester", "Oldham", "Rochdale",
            "Salford", "Stockport", "Tameside", "Trafford", "Wigan",
        ]);
        expect(wn).toHaveLength(215);
        expect(new Set(wn).size).toBe(215);
        expect(wn).not.toContain("Outer");
        // The two ward names used twice are disambiguated by borough.
        expect(wn).toEqual(
            expect.arrayContaining(["Brooklands (Manchester)", "Brooklands (Trafford)"]),
        );
    });

    it.each([
        ["borough", () => gmBoroughs],
        ["ward", () => gmWards],
        ["HSL region", () => gmHslRegions],
    ])("every hiding zone sits in exactly one %s", (_label, get) => {
        for (const pt of gmStationPoints()) {
            const hits = get().features.filter((f) => turf.booleanPointInPolygon(pt, f));
            expect(hits, pt.properties.name).toHaveLength(1);
        }
    });

    // Boroughs are dissolved from the wards, so the two can never disagree.
    it("every ward lies inside exactly one borough", () => {
        for (const w of gmWards.features) {
            const p = turf.pointOnFeature(w as never);
            const hits = gmBoroughs.features.filter((b) => turf.booleanPointInPolygon(p, b));
            expect(hits, String(w.properties?.name)).toHaveLength(1);
        }
    });

    it("Mills Hill is in Rochdale, per ONS — not Oldham as the hand-drawn layer had it", () => {
        const mh = gmStationPoints().find((p) => p.properties.name === "Mills Hill")!;
        const b = gmBoroughs.features.find((f) => turf.booleanPointInPolygon(mh, f));
        expect(b?.properties?.name).toBe("Rochdale");
    });

    // Stockport south to the county edge, and Wigan north to it.
    it("ships the two West Coast Main Line stretches, both inside the county", () => {
        expect(gmHsl.features.map((f) => f.properties?.name).sort()).toEqual([
            "West Coast Main Line (North of Wigan)",
            "West Coast Main Line (South of Stockport)",
        ]);
        for (const f of gmHsl.features) {
            expect(f.geometry.type).toBe("LineString");
            // Every interior vertex is inside. The endpoints are skipped: each
            // stretch ENDS on the county boundary, so they sit on the ring.
            const inner = f.geometry.coordinates.slice(1, -1);
            expect(inner.length).toBeGreaterThan(10);
            for (const c of inner)
                expect(turf.booleanPointInPolygon(turf.point(c), gmBorder.features[0])).toBe(true);
        }
    });

    it("splits the HSL regions by whichever stretch is actually nearer", () => {
        const [a, b] = gmHsl.features;
        for (const pt of gmStationPoints()) {
            const da = turf.pointToLineDistance(pt, a, { units: "kilometers" });
            const db = turf.pointToLineDistance(pt, b, { units: "kilometers" });
            if (Math.abs(da - db) < 0.3) continue; // on the bisector
            const want = (da < db ? a : b).properties?.name;
            const region = gmHslRegions.features.find((f) =>
                turf.booleanPointInPolygon(pt, f),
            );
            expect(region?.properties?.name, pt.properties.name).toBe(want);
        }
    });
});

const GM_TYPES = ["gm-borough", "gm-ward", "gm-hsl"];

describe("Greater Manchester question picker gating", () => {
    it.each(GM_TYPES)("%s is offered for both families", (t) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", GM)).toContain(t);
        expect(pickerTypes(measuringQuestionSchema as never, "measuring", GM)).toContain(t);
    });

    it.each([BRIGHTON, "__bundled-london-2026__"])("no GM type is offered for %s", (other) => {
        const m = pickerTypes(matchingQuestionSchema, "matching", other);
        const d = pickerTypes(measuringQuestionSchema as never, "measuring", other);
        for (const t of GM_TYPES) {
            expect(m).not.toContain(t);
            expect(d).not.toContain(t);
        }
    });

    it("airport is measuring-only", () => {
        expect(pickerTypes(measuringQuestionSchema as never, "measuring", GM)).toContain("airport");
        expect(pickerTypes(matchingQuestionSchema, "matching", GM)).not.toContain("airport");
    });

    // The board is exactly Jules' list. Grouped (Hiding Zone Mode) options are
    // checked through isQuestionTypeHidden directly, as the picker does.
    const KEPT = ["zoo", "aquarium", "hospital", "library", "consulate", "peak"];
    const DROPPED = ["museum", "cinema", "golf_course", "park", "theme_park"];
    it.each(["matching", "measuring"] as const)(
        "%s keeps the listed POI questions only",
        (kind) => {
            for (const t of KEPT) {
                expect(isQuestionTypeHidden(t, GM, kind), t).toBe(false);
                expect(isQuestionTypeHidden(`${t}-full`, GM, kind), `${t}-full`).toBe(false);
            }
            for (const t of DROPPED) {
                expect(isQuestionTypeHidden(t, GM, kind), t).toBe(true);
                expect(isQuestionTypeHidden(`${t}-full`, GM, kind), `${t}-full`).toBe(true);
            }
        },
    );

    it("hides the generic questions the bundled ones replace, and never tentacles", () => {
        const d = pickerTypes(measuringQuestionSchema as never, "measuring", GM);
        for (const t of ["highspeed-measure-shinkansen", "coastline", "city"])
            expect(d).not.toContain(t);
        expect(pickerTypes(matchingQuestionSchema, "matching", GM)).not.toContain("zone");
        for (const t of [...KEPT, ...DROPPED])
            expect(isQuestionTypeHidden(t, GM, "tentacle"), t).toBe(false);
    });
});

describe.each([
    ["gm-borough", gmBoroughs],
    ["gm-hsl", gmHslRegions],
])("adjustPerMatching — %s (bundled, exact)", (type, fc) => {
    // Straddles the Manchester borough edge. For gm-hsl the whole box is on the
    // southern side, so "same" keeps all of it and "!same" removes all of it.
    const base = boundary(-2.32, 53.44, -2.16, 53.52);
    const seekerDiv = fc.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(GM_SEEKER), f),
    )!;
    const seekerLines = borderLines(turf.simplify(seekerDiv as never, RING_SIMPLIFY));

    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            if (distToBorder(pt, seekerLines, "kilometers") <= 0.06) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
            return inBase && (same ? inDiv : !inDiv) ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker resolves to exactly one region", () => {
        expect(
            fc.features.filter((f) => turf.booleanPointInPolygon(turf.point(GM_SEEKER), f)),
        ).toHaveLength(1);
        expect(seekerDiv.properties?.name).toBe(
            type === "gm-borough" ? "Manchester" : "West Coast Main Line (South of Stockport)",
        );
    });

    it.each([true, false])("same=%s agrees with the region oracle", async (same) => {
        const mask = await matchMask(type, base, GM_SEEKER, same);
        const r = gridAgreement(mask, sampleGrid(base, 28), verdictFor(same));
        expect(r.failures).toEqual([]);
        if (type === "gm-borough") {
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }
    }, 120_000);
});

describe("adjustPerMeasuring — gm-borough (seeker's OWN border)", () => {
    const BASE = boundary(-2.35, 53.40, -2.10, 53.56);
    const div = gmBoroughs.features.find((f) =>
        turf.booleanPointInPolygon(turf.point(GM_SEEKER), f),
    )!;
    const lines = borderLines(turf.simplify(div as never, RING_SIMPLIFY));
    const dMin = distToBorder(turf.point(GM_SEEKER), lines, MI.units);

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distToBorder(pt, lines, MI.units);
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, BASE);
            const closer = d <= dMin;
            return inBase && (hiderCloser ? closer : !closer) ? "survives" : "eliminated";
        };

    it.each([true, false])("hiderCloser=%s agrees with the own-border oracle", async (hc) => {
        const mask = await measureMask("gm-borough", BASE, GM_SEEKER, hc);
        const r = gridAgreement(mask, sampleGrid(BASE, 24), verdictFor(hc));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);
});

describe("adjustPerMeasuring — gm-hsl (distance to either stretch)", () => {
    const BASE = boundary(-2.45, 53.35, -2.05, 53.62);
    const dist = (pt: Feature<Point>) =>
        Math.min(...gmHsl.features.map((l) => turf.pointToLineDistance(pt, l, MI)));
    const dMin = dist(turf.point(GM_SEEKER));

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = dist(pt);
            if (Math.abs(d - dMin) <= dMin * 0.05) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, BASE);
            return inBase && (hiderCloser ? d <= dMin : d > dMin) ? "survives" : "eliminated";
        };

    it.each([true, false])("hiderCloser=%s agrees with the nearest-line oracle", async (hc) => {
        const mask = await measureMask("gm-hsl", BASE, GM_SEEKER, hc);
        const r = gridAgreement(mask, sampleGrid(BASE, 24), verdictFor(hc));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);
});
