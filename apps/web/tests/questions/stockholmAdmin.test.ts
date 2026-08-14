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

import { gamePOIData, hiderMode, mapGeoJSON } from "@/lib/context";
import { isQuestionTypeHidden } from "@/lib/games";
import { stockholmAdminDivisionBorderLines } from "@/maps/questions/stockholmAdmin";
import { adjustPerMatching } from "@/maps/questions/matching";
import { adjustPerMeasuring } from "@/maps/questions/measuring";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
    tentacleQuestionSchema,
} from "@/maps/schema";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const MI = { units: "miles" as const };

const load = (f: string) =>
    JSON.parse(readFileSync(resolve(PUBLIC, f), "utf8")) as FeatureCollection<
        Polygon | MultiPolygon
    >;

const LEVELS = {
    "stockholm-admin1": load("stockholm-admin1.geojson"),
    "stockholm-admin2": load("stockholm-admin2.geojson"),
    "stockholm-admin3": load("stockholm-admin3.geojson"),
};
const border = load("stockholm-border.geojson");

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

function stationCoords(): Map<string, [number, number]> {
    const kml = readFileSync(resolve(PUBLIC, "stockholm-stations.kml"), "utf8");
    const out = new Map<string, [number, number]>();
    for (const m of kml.matchAll(
        /<name>([^<]+)<\/name><Point><coordinates>([-\d.]+),([-\d.]+)/g,
    )) {
        out.set(m[1], [Number(m[2]), Number(m[3])]);
    }
    return out;
}
const STATIONS = stationCoords();

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
    gamePOIData.set({} as never);
    vi.unstubAllGlobals();
});

// ── asset guards ────────────────────────────────────────────────────────────
describe("Stockholm admin assets", () => {
    it.each([
        ["stockholm-admin1", 3],
        ["stockholm-admin2", 9],
        ["stockholm-admin3", 25],
    ])("%s is a FeatureCollection of %i named polygons", (type, n) => {
        const fc = LEVELS[type as keyof typeof LEVELS];
        expect(fc.type).toBe("FeatureCollection");
        expect(fc.features.length).toBe(n);
        for (const f of fc.features) {
            expect(f.geometry.type).toMatch(/Polygon/);
            expect(f.properties?.name).toBeTruthy();
        }
    });

    // The supplied levels 1 and 2 each had ONE overlapping pair (North-West ∩
    // North-East, ~27,000 m² / ~26,000 m²). Both question families resolve the
    // one division containing the seeker, so the generator trims the overlap by
    // ordered subtraction. This asserts the trim actually happened.
    it.each(Object.keys(LEVELS))("%s divisions do not overlap each other", (type) => {
        const feats = LEVELS[type as keyof typeof LEVELS].features;
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

    it.each(Object.keys(LEVELS))(
        "every hiding zone sits inside exactly one %s division",
        (type) => {
            const fc = LEVELS[type as keyof typeof LEVELS];
            expect(STATIONS.size).toBe(191);
            for (const [lng, lat] of STATIONS.values()) {
                const pt = turf.point([lng, lat]);
                const hits = fc.features.filter((f) =>
                    turf.booleanPointInPolygon(pt, f),
                );
                expect(hits.length).toBe(1);
            }
        },
    );

    // The three levels are the author's own groupings, but they do nest — worth
    // pinning, because a future source revision that redraws one level without
    // the others would break the mental model even though every other test
    // still passes.
    it.each([
        ["stockholm-admin2", "stockholm-admin1"],
        ["stockholm-admin3", "stockholm-admin2"],
    ])("%s nests inside %s", (child, parent) => {
        const parents = LEVELS[parent as keyof typeof LEVELS].features;
        for (const c of LEVELS[child as keyof typeof LEVELS].features) {
            const best = Math.max(
                ...parents.map((p) => {
                    const i = turf.intersect(
                        turf.featureCollection([c, p] as never),
                    );
                    return i ? turf.area(i) / turf.area(c) : 0;
                }),
            );
            expect(best).toBeGreaterThan(0.99);
        }
    });

    it("all three levels dissolve to the same play area", () => {
        const target = turf.area(border.features[0] as never);
        for (const fc of Object.values(LEVELS)) {
            const u = turf.union(fc as never)!;
            expect(Math.abs(turf.area(u) - target) / target).toBeLessThan(0.001);
        }
    });

    it("the stations KML carries no tier data — the radius is uniform", () => {
        const kml = readFileSync(resolve(PUBLIC, "stockholm-stations.kml"), "utf8");
        expect(kml).not.toContain('<Data name="tier">');
        expect([...kml.matchAll(/<Placemark>/g)].length).toBe(191);
    });

    it("the POI KML supplies the four bundled categories", () => {
        const kml = readFileSync(resolve(PUBLIC, "stockholm-poi.kml"), "utf8");
        const counts: Record<string, number> = {};
        for (const m of kml.matchAll(
            /<Folder><name>(\w+)<\/name>([\s\S]*?)<\/Folder>/g,
        )) {
            counts[m[1]] = [...m[2].matchAll(/<Placemark>/g)].length;
        }
        expect(counts).toEqual({
            airport: 2,
            golf_course: 29,
            hospital: 15,
            ikea: 5,
        });
    });
});

// ── question-picker gating ──────────────────────────────────────────────────
const STOCKHOLM = "__bundled-stockholm-2026__";
const STOCKHOLM_TYPES = [
    "stockholm-admin1",
    "stockholm-admin2",
    "stockholm-admin3",
    "stockholm-ikea",
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
        .filter((value: string) => {
            return (
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind)
            );
        });
}

describe("question picker gating", () => {
    it.each(STOCKHOLM_TYPES)("%s is offered for both matching and measuring", (t) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", STOCKHOLM)).toContain(t);
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
        ).toContain(t);
    });

    it.each(["__bundled-graz-2026__", "__bundled-paris-2026__"])(
        "no Stockholm type is offered for %s",
        (other) => {
            const m = pickerTypes(matchingQuestionSchema, "matching", other);
            const d = pickerTypes(measuringQuestionSchema as never, "measuring", other);
            for (const t of STOCKHOLM_TYPES) {
                expect(m).not.toContain(t);
                expect(d).not.toContain(t);
            }
        },
    );

    // Stockholm supplies only 3 of the 13 rulebook categories and hides just
    // one question — the other ten categories are meant to reach Overpass
    // (which hits the self-hosted instance first, via the API proxy). This is
    // the inverse of the assertion most games need, and the one that would
    // catch someone copying another game's hidden list wholesale.
    it.each(["museum-full", "library-full", "park-full", "airport"])(
        "%s stays available in Stockholm so it can fall through to Overpass",
        (type) => {
            expect(
                pickerTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
            ).toContain(type);
        },
    );

    // Hidden for the OPPOSITE reason to every other game that hides it: those
    // are landlocked, Stockholm is an archipelago. The coast is fractal and
    // everywhere, so the question barely discriminates and the Overpass query
    // is huge.
    it("coastline is hidden in Stockholm", () => {
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
        ).not.toContain("coastline");
    });
});

// ── the per-family hidden list ──────────────────────────────────────────────
//
// Jules' list, hidden across all three question families. The kind: prefixes
// are load-bearing — hospitals are hidden as TENTACLES only (Stockholm bundles
// 15 of them, so the matching/measuring hospital questions are good here), and
// aquariums need two literals per family because the ungrouped option is
// "aquarium-full" while the Hiding Zone Mode one is bare "aquarium".

/** The grouped ("Hiding Zone Mode") half of a picker, which the cards build
 *  separately from the ungrouped half — see matching.tsx / measuring.tsx. */
function groupedTypes(
    schema: typeof matchingQuestionSchema,
    kind: "matching" | "measuring",
    sentinel: string,
) {
    return schema.options
        .filter((x: any) => x.description !== NO_GROUP)
        .flatMap((x: any) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter((value: string) => !isQuestionTypeHidden(value, sentinel, kind));
}

function tentacleTypes(sentinel: string) {
    return (tentacleQuestionSchema as any).options
        .flatMap((x: any) => determineUnionizedStrings(x.shape.locationType))
        .map((x: any) => x._def.value as string)
        .filter(
            (v: string) =>
                gateAllows(v, sentinel) &&
                !isQuestionTypeHidden(v, sentinel, "tentacle"),
        );
}

describe("Stockholm's per-family hidden list", () => {
    it.each(["theme_park", "zoo", "aquarium", "hospital"])(
        "tentacle %s is hidden",
        (t) => {
            expect(tentacleTypes(STOCKHOLM)).not.toContain(t);
        },
    );

    it("leaves the tentacle categories Jules kept", () => {
        const vis = tentacleTypes(STOCKHOLM);
        for (const t of ["museum", "cinema", "library", "custom"]) {
            expect(vis).toContain(t);
        }
    });

    it.each(["city", "international-border", "aquarium-full"])(
        "measuring %s is hidden (ungrouped)",
        (t) => {
            expect(
                pickerTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
            ).not.toContain(t);
        },
    );

    it.each(["mcdonalds", "seven11", "aquarium"])(
        "measuring %s is hidden (Hiding Zone Mode group)",
        (t) => {
            expect(
                groupedTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
            ).not.toContain(t);
        },
    );

    it.each(["letter-zone", "major-city", "aquarium-full"])(
        "matching %s is hidden (ungrouped)",
        (t) => {
            expect(pickerTypes(matchingQuestionSchema, "matching", STOCKHOLM)).not.toContain(
                t,
            );
        },
    );

    it("matching aquarium is hidden (Hiding Zone Mode group)", () => {
        expect(groupedTypes(matchingQuestionSchema, "matching", STOCKHOLM)).not.toContain(
            "aquarium",
        );
    });

    // Hospitals are bundled (15 of them), so only the tentacle is hidden.
    it("hospital stays available for matching and measuring", () => {
        expect(
            groupedTypes(measuringQuestionSchema as never, "measuring", STOCKHOLM),
        ).toContain("hospital");
        expect(groupedTypes(matchingQuestionSchema, "matching", STOCKHOLM)).toContain(
            "hospital",
        );
    });
});

// ── the grouped-picker filter, and the trap in it ───────────────────────────
describe("grouped picker options respect hiddenQuestionTypes", () => {
    // Until Aug 2026 the matching/measuring cards built their groups= list with
    // no filter, so hiddenQuestionTypes was silently a no-op for everything in
    // "Hiding Zone Mode" (Entry 48). These are the entries that were dormant.
    it.each([
        ["__bundled-belgium-2026__", ["aquarium", "park"]],
        ["__bundled-london-2026__", ["theme_park"]],
        ["__bundled-accessible-london-2026__", ["theme_park"]],
        ["__bundled-graz-2026__", ["aquarium"]],
        ["__bundled-paris-2026__", ["peak"]],
    ])("%s now actually hides %j", (sentinel, types) => {
        const m = groupedTypes(matchingQuestionSchema, "matching", sentinel as string);
        const d = groupedTypes(
            measuringQuestionSchema as never,
            "measuring",
            sentinel as string,
        );
        for (const t of types as string[]) {
            expect(m).not.toContain(t);
            expect(d).not.toContain(t);
        }
    });

    // The trap: GAME_GATED_TYPES holds bare TENTACLE category names
    // ("golf_course" → South Limburg, "park" → Bucharest, "castle"/"stadium" →
    // Budapest) and is not family-aware. Applying gateAllows to grouped
    // matching/measuring options therefore deletes the generic golf course and
    // park questions from EVERY game. It was written that way first and caught
    // here. Grouped options must filter on hiddenQuestionTypes only.
    it.each([
        "__bundled-brno-2026-v2__",
        "__bundled-luxembourg-2026__",
        "__bundled-zurich-2026__",
        "__bundled-stockholm-2026__",
    ])("generic golf_course and park survive in %s", (sentinel) => {
        for (const kind of ["matching", "measuring"] as const) {
            const schema =
                kind === "matching" ? matchingQuestionSchema : measuringQuestionSchema;
            const vis = groupedTypes(schema as never, kind, sentinel);
            expect(vis).toContain("golf_course");
            expect(vis).toContain("park");
        }
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

// Scenarios picked numerically, by sweeping all 191 hiding zones as candidate
// seekers at three box sizes and keeping the most balanced. Eyeballing does not
// work here: the deepest interior point of every level lands 27 km out in the
// southern archipelago, where the whole grid falls inside one division and the
// split degenerates to 784/0.
// `far` is a hiding zone deep inside the seeker's own division but within a
// kilometre of some *other* division's border — the pair of distances that
// separates the own-division reading from an all-borders one. minOwnKm is a
// floor a little under the measured own-ring distance (turf, geodesic).
const SCENARIOS = [
    {
        type: "stockholm-admin1",
        station: "Solna",
        division: "North-West",
        base: boundary(17.9096, 59.3133, 18.1096, 59.4153),
        far: "Sickla kaj",
        minOwnKm: 5,
    },
    {
        type: "stockholm-admin2",
        station: "Blackeberg",
        division: "Västerort",
        base: boundary(17.7836, 59.297, 17.9836, 59.399),
        far: "Skärmarbrink",
        minOwnKm: 6,
    },
    {
        type: "stockholm-admin3",
        station: "Sickla",
        division: "Nacka kommun",
        base: boundary(18.0904, 59.2916, 18.1504, 59.3222),
        far: "Svedmyra",
        minOwnKm: 3,
    },
] as const;

describe.each(SCENARIOS)(
    "adjustPerMatching — $type (bundled, exact)",
    ({ type, station, division, base }) => {
        const seeker = STATIONS.get(station)! as [number, number];
        const fc = LEVELS[type as keyof typeof LEVELS];
        const seekerDiv = fc.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(seeker), f),
        )!;
        const seekerLines = borderLines(seekerDiv);

        const verdictFor =
            (same: boolean) =>
            (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
                if (distToBorder(pt, seekerLines, "kilometers") <= 0.04)
                    return "ambiguous";
                const inBase = turf.booleanPointInPolygon(pt, base);
                const inDiv = turf.booleanPointInPolygon(pt, seekerDiv);
                const kept = same ? inDiv : !inDiv;
                return inBase && kept ? "survives" : "eliminated";
            };

        it(`scenario sanity: the seeker sits in ${division}`, () => {
            expect(seekerDiv.properties?.name).toBe(division);
        });

        it("same: keeps exactly the seeker's division ∩ base", async () => {
            const mask = await matchMask(type, base, seeker, true);
            const r = gridAgreement(mask, sampleGrid(base, 24), verdictFor(true));
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }, 120_000);

        it("!same: removes the seeker's division from base", async () => {
            const mask = await matchMask(type, base, seeker, false);
            const r = gridAgreement(mask, sampleGrid(base, 24), verdictFor(false));
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }, 120_000);
    },
);

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

describe.each(SCENARIOS)(
    "adjustPerMeasuring — $type (distance to the seeker's own division border)",
    ({ type, station, base }) => {
        const seeker = STATIONS.get(station)! as [number, number];
        const fc = LEVELS[type as keyof typeof LEVELS];
        const seekerDiv = fc.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(seeker), f),
        )!;
        const seekerLines = borderLines(seekerDiv);
        const dMin = distToBorder(turf.point(seeker), seekerLines, MI.units);

        const verdictFor =
            (hiderCloser: boolean) =>
            (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
                const d = distToBorder(pt, seekerLines, MI.units);
                if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
                const inBase = turf.booleanPointInPolygon(pt, base);
                const closer = d <= dMin;
                const kept = hiderCloser ? closer : !closer;
                return inBase && kept ? "survives" : "eliminated";
            };

        it("hiderCloser: keeps a band within d_min of the division border", async () => {
            const mask = await measureMask(type, base, seeker, true);
            const r = gridAgreement(mask, sampleGrid(base, 24), verdictFor(true));
            expect(r.failures).toEqual([]);
            expect(r.survives).toBeGreaterThan(10);
            expect(r.eliminated).toBeGreaterThan(10);
        }, 120_000);

        it("!hiderCloser: keeps points beyond d_min of the border", async () => {
            const mask = await measureMask(type, base, seeker, false);
            const r = gridAgreement(mask, sampleGrid(base, 24), verdictFor(false));
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
    },
);

describe.each(SCENARIOS)(
    "$type measuring uses only the seeker's own division",
    ({ type, station, far, minOwnKm }) => {
        // The belgium-province / graz-district / paris-arrondissement reading,
        // NOT london-borough's all-borders one. If anyone "fixes" measuring to
        // use every border at the level, these flip.
        it("measures the seeker's own border, not every division's", async () => {
            const seeker = STATIONS.get(station)!;
            const fc = LEVELS[type as keyof typeof LEVELS];
            const seekerDiv = fc.features.find((f) =>
                turf.booleanPointInPolygon(turf.point(seeker), f),
            )!;
            const seekerLines = borderLines(seekerDiv);

            const lines = await stockholmAdminDivisionBorderLines(
                type,
                seeker[1],
                seeker[0],
            );
            expect(lines?.length).toBeGreaterThan(0);

            const probe = turf.point(STATIONS.get(far)!);
            const measured = distToBorder(
                probe,
                lines!.flatMap((l: Feature) =>
                    l.geometry.type === "MultiLineString"
                        ? (l.geometry.coordinates as number[][][]).map((c) =>
                              turf.lineString(c),
                          )
                        : [l as Feature<LineString>],
                ),
                "kilometers",
            );
            const own = distToBorder(probe, seekerLines, "kilometers");
            const any = Math.min(
                ...fc.features.map((f) =>
                    distToBorder(probe, borderLines(f), "kilometers"),
                ),
            );

            expect(measured).toBeCloseTo(own, 0); // handler simplifies at ~55 m
            expect(any).toBeLessThan(own);
            expect(own).toBeGreaterThan(minOwnKm);
            expect(any).toBeLessThan(1);
        }, 120_000);
    },
);

// The 3rd level is lopsided on purpose and this records that it was measured,
// not overlooked. Across all 191 hiding zones, distance-to-own-border keeps
// 35.8% / 15.8% / 6.5% at levels 1 / 2 / 3 — so admin3 eliminates ~93% when
// true and is therefore rarely true. Jules was shown these numbers and chose to
// ship all three levels with both question families. Don't delete admin3
// measuring on rediscovering this.
describe("admin3 measuring is deliberately lopsided", () => {
    it("keeps well under a fifth of hiding zones on average", () => {
        const fc = LEVELS["stockholm-admin3"];
        const pts = [...STATIONS.values()].map(([lng, lat]) => turf.point([lng, lat]));
        const linesFor = new Map(
            fc.features.map((f) => [f.properties?.name as string, borderLines(f)]),
        );
        let total = 0;
        for (const p of pts) {
            const own = fc.features.find((f) => turf.booleanPointInPolygon(p, f));
            if (!own) continue;
            const lines = linesFor.get(own.properties?.name as string)!;
            const d = distToBorder(p, lines, "kilometers");
            const closer = pts.filter(
                (q) => distToBorder(q, lines, "kilometers") <= d,
            ).length;
            total += closer / pts.length;
        }
        const mean = total / pts.length;
        expect(mean).toBeLessThan(0.2);
        expect(mean).toBeGreaterThan(0.02);
    }, 300_000);
});

// ── the custom IKEA POI ─────────────────────────────────────────────────────
// "ikea" is a game-specific category, not one of the 13 rulebook ones. It is
// the budapest-stadium / london-stadium shape: one type, both families, read
// from gamePOIData via CATEGORY_ALIASES in poiOverride.ts.
const IKEAS = [
    { name: "IKEA Barkarby", lat: 59.4211, lon: 17.8591 },
    { name: "IKEA City - Stockholm Gallerian", lat: 59.3323, lon: 18.0673 },
    { name: "IKEA Stockholm - Mall of Scandinavia", lat: 59.3703, lon: 18.0034 },
    { name: "IKEA Stockholm - Kungens Kurva", lat: 59.271, lon: 17.9153 },
    { name: "IKEA Planera och beställ Stockholm - Täby", lat: 59.4453, lon: 18.0719 },
];

// Södermalm — a few km from the nearest IKEA in every direction.
const SEEKER_OFF_POI: [number, number] = [18.06, 59.313];

describe("stockholm-ikea uses the bundled POIs, never Overpass", () => {
    beforeEach(() => {
        gamePOIData.set({ ikea: IKEAS } as never);
    });

    it("matching resolves against the 5 bundled IKEAs with no fetch to Overpass", async () => {
        const base = boundary(17.85, 59.25, 18.15, 59.45);
        // Deliberately NOT on top of an IKEA: a seeker sitting exactly on a POI
        // makes the nearest-target distance zero, so turf.buffer returns an
        // empty collection and there is nothing to intersect.
        const seeker: [number, number] = SEEKER_OFF_POI;
        const mask = await matchMask("stockholm-ikea", base, seeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
        // The stubbed fetch only ever serves local asset files; an Overpass call
        // would go to the /overpass proxy.
        const calls = (globalThis.fetch as any).mock?.calls ?? [];
        expect(
            calls.filter((c: any[]) => String(c[0]).includes("overpass")),
        ).toEqual([]);
    }, 120_000);

    it("measuring resolves against the bundled IKEAs", async () => {
        const base = boundary(17.85, 59.25, 18.15, 59.45);
        const seeker: [number, number] = SEEKER_OFF_POI;
        const mask = await measureMask("stockholm-ikea", base, seeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
        const calls = (globalThis.fetch as any).mock?.calls ?? [];
        expect(
            calls.filter((c: any[]) => String(c[0]).includes("overpass")),
        ).toEqual([]);
    }, 120_000);
});
