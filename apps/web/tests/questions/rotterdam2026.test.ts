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

// Same faithful arcBufferToPoint stub as londonBorough.test.ts: the surviving
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
import { categoryForQuestionType } from "@/lib/poiOverride";
import { parseKMLFolderPOI } from "@/maps/api/importers";
import { adjustPerMeasuring } from "@/maps/questions/measuring";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";
import { GAME_REGISTRY } from "@taibled/shared";

import { boundary, gridAgreement, sampleGrid } from "./oracleCommon";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const read = (f: string) => readFileSync(resolve(PUBLIC, f), "utf8");

const SENTINEL = "__bundled-rotterdam-2026-09__";
const EXTER = "__bundled-exter-rotterdam-2026__";

const manifest = GAME_REGISTRY.find((g) => g.sentinel === SENTINEL)!;
const exter = GAME_REGISTRY.find((g) => g.sentinel === EXTER)!;

const poi = parseKMLFolderPOI(read("rotterdam-2026-poi.kml"), manifest.poiFolders);
const border = JSON.parse(
    read("exter-rotterdam-border.geojson"),
) as FeatureCollection<Polygon | MultiPolygon>;
const lines = JSON.parse(
    read("rotterdam-2026-municipality-lines.geojson"),
) as FeatureCollection<LineString>;
const munis = JSON.parse(
    read("exter-rotterdam-municipalities.geojson"),
) as FeatureCollection<Polygon | MultiPolygon>;

// ── Manifest ─────────────────────────────────────────────────────────────────

describe("Rotterdam 12-09 manifest", () => {
    it("is registered on JetLag BNL with no role gate", () => {
        expect(manifest.name).toBe("Rotterdam 12-09");
        expect(manifest.serverId).toBe("1369664929975767120");
        // Deliberately ungated, unlike Exter Rotterdam 26, which is a HOME game
        // behind an EU role.
        expect(manifest.gate).toBeUndefined();
    });

    it("reuses every Exter Rotterdam asset except the POI file", () => {
        // The two games are the same board. If these ever diverge, the shared
        // rotterdam-municipality / -rail / -coastline questions are reading
        // geometry that no longer matches this game's hiding zones.
        expect(manifest.stationsKml).toBe(exter.stationsKml);
        expect(manifest.boundaryGeoJson).toBe(exter.boundaryGeoJson);
        expect(manifest.hidingRadius).toBe(exter.hidingRadius);
        expect(manifest.size).toBe(exter.size);
        expect(manifest.osm).toEqual(exter.osm);
        expect(manifest.kmlPath).toBe("rotterdam-2026-poi.kml");
        expect(manifest.kmlPath).not.toBe(exter.kmlPath);
    });

    it("claims rail_station, never train_station", () => {
        // "train_station" overrides the generic same-train-line and
        // same-length-station questions, which must see all 206 of the map's
        // stops — not these 9. Fails silently if ever renamed.
        expect(Object.values(manifest.poiFolders!)).toContain("rail_station");
        expect(Object.values(manifest.poiFolders!)).not.toContain("train_station");
        expect(categoryForQuestionType("rotterdam-ns")).toBe("rail_station");
    });
});

// ── Assets ───────────────────────────────────────────────────────────────────

describe("Rotterdam 12-09 POI asset", () => {
    it("carries the 9 Exter categories plus rail_station", () => {
        const exterPoi = parseKMLFolderPOI(
            read("exter-rotterdam-poi.kml"),
            exter.poiFolders,
        );
        expect(Object.keys(poi).sort()).toEqual(
            [...Object.keys(exterPoi), "rail_station"].sort(),
        );
        // The shared categories must be identical — the generator copies the
        // source folders verbatim rather than re-deriving them.
        for (const [cat, pts] of Object.entries(exterPoi)) {
            expect(poi[cat], cat).toEqual(pts);
        }
    });

    it("ships the 9 NS stations, named and unique", () => {
        expect(poi.rail_station).toHaveLength(9);
        const names = poi.rail_station.map((p) => p.name);
        expect(new Set(names).size).toBe(9);
        expect(names).toContain("Rotterdam Centraal");
        expect(names).toContain("Schiedam Centrum");
        for (const p of poi.rail_station) {
            expect(Number.isFinite(p.lat) && Number.isFinite(p.lon)).toBe(true);
        }
    });

    it("puts every NS station inside the play area", () => {
        // Unlike Stockholm's Arlanda and Paris's four stray parks, nothing here
        // spills outside — so a future source that moves one out should be
        // looked at rather than waved through.
        for (const p of poi.rail_station) {
            const inside = border.features.some((f) =>
                turf.booleanPointInPolygon(turf.point([p.lon, p.lat]), f as never),
            );
            expect(inside, p.name).toBe(true);
        }
    });
});

// ── Picker gating ────────────────────────────────────────────────────────────

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

/** The "Hiding Zone Mode" style groups, which filter on hidden types only. */
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

describe("Rotterdam 12-09 question picker gating", () => {
    it("offers rotterdam-ns for both matching and measuring", () => {
        expect(pickerTypes(matchingQuestionSchema, "matching", SENTINEL)).toContain(
            "rotterdam-ns",
        );
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", SENTINEL),
        ).toContain("rotterdam-ns");
    });

    it("still offers the three inherited Rotterdam questions", () => {
        const matching = pickerTypes(matchingQuestionSchema, "matching", SENTINEL);
        const measuring = pickerTypes(
            measuringQuestionSchema as never,
            "measuring",
            SENTINEL,
        );
        expect(matching).toContain("rotterdam-municipality");
        expect(measuring).toContain("rotterdam-rail");
        expect(measuring).toContain("rotterdam-coastline");
    });

    it("does not leak rotterdam-ns into Exter Rotterdam 26 or other games", () => {
        for (const s of [EXTER, "__bundled-milan-2026__", "__bundled-brighton-2026__"]) {
            expect(
                pickerTypes(matchingQuestionSchema, "matching", s),
                s,
            ).not.toContain("rotterdam-ns");
            expect(
                pickerTypes(measuringQuestionSchema as never, "measuring", s),
                s,
            ).not.toContain("rotterdam-ns");
        }
    });

    // The municipality question is matching-only on Exter Rotterdam 26 and
    // matching + measuring here. The measuring half is a SEPARATE literal on
    // purpose: gateAllows() is keyed by type alone and knows nothing about
    // families, so narrowing "rotterdam-municipality" to this sentinel would
    // have taken the matching question away from the older game too.
    it("offers rotterdam-municipality-border for measuring, this game only", () => {
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", SENTINEL),
        ).toContain("rotterdam-municipality-border");
        for (const s of [EXTER, "__bundled-milan-2026__", "__bundled-brighton-2026__"]) {
            expect(
                pickerTypes(measuringQuestionSchema as never, "measuring", s),
                s,
            ).not.toContain("rotterdam-municipality-border");
        }
    });

    // Where a bundled question answers the same thing as a generic one, the
    // generic one is hidden — otherwise the two sit a line apart in the picker
    // and the worse of the pair is one misclick away.
    it("hides the generic coastline and HSL questions in favour of the bundled pair", () => {
        const measuring = pickerTypes(
            measuringQuestionSchema as never,
            "measuring",
            SENTINEL,
        );
        expect(measuring).not.toContain("coastline");
        expect(measuring).not.toContain("highspeed-measure-shinkansen");
        // ...and the questions they were hidden for are still there.
        expect(measuring).toContain("rotterdam-coastline");
        expect(measuring).toContain("rotterdam-rail");
    });

    it("keeps the station questions, which are NOT duplicates of rotterdam-ns", () => {
        // rotterdam-ns is the 9 NS heavy-rail stations. These see all 206 stops
        // on the board, which is a different question and the reason the POI
        // folder is "rail_station" rather than "train_station".
        expect(groupedTypes(matchingQuestionSchema, "matching", SENTINEL)).toEqual(
            expect.arrayContaining([
                "same-train-line",
                "same-length-station",
                "same-first-letter-station",
            ]),
        );
        expect(
            groupedTypes(measuringQuestionSchema as never, "measuring", SENTINEL),
        ).toContain("rail-measure");
    });

    it("keeps every POI-backed generic question, which the custom POIs override in place", () => {
        // These resolve from gamePOIData rather than Overpass, so there is no
        // second copy to hide — hiding them would delete the question outright.
        const measuring = pickerTypes(
            measuringQuestionSchema as never,
            "measuring",
            SENTINEL,
        );
        for (const t of [
            "library-full",
            "museum-full",
            "hospital-full",
            "zoo-full",
            "cinema-full",
            "golf_course-full",
            "consulate-full",
            "theme_park-full",
        ]) {
            expect(measuring, t).toContain(t);
        }
        expect(
            pickerTypes(matchingQuestionSchema, "matching", SENTINEL),
        ).toContain("airport");
    });

    it("leaves Exter Rotterdam 26's municipality matching untouched", () => {
        expect(pickerTypes(matchingQuestionSchema, "matching", EXTER)).toContain(
            "rotterdam-municipality",
        );
        // ...and does not hand it a measuring counterpart under either name.
        const exterMeasuring = pickerTypes(
            measuringQuestionSchema as never,
            "measuring",
            EXTER,
        );
        expect(exterMeasuring).not.toContain("rotterdam-municipality");
        expect(exterMeasuring).not.toContain("rotterdam-municipality-border");
    });
});

function flatLines(div: Feature): Feature<LineString>[] {
    const l = turf.polygonToLine(div as never);
    const feats = (l.type === "FeatureCollection" ? l.features : [l]) as Feature[];
    return feats.flatMap((f) =>
        f.geometry.type === "MultiLineString"
            ? f.geometry.coordinates.map((c) => turf.lineString(c))
            : [f as Feature<LineString>],
    );
}

const distTo = (
    pt: Feature<Point>,
    ls: Feature<LineString>[],
    units: "kilometers" | "miles",
) => Math.min(...ls.map((l) => turf.pointToLineDistance(pt, l, { units })));

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
// The network is generated from the full-resolution source KML, NOT from
// exter-rotterdam-municipalities.geojson: that asset was simplified per-polygon
// at ~0.001 (70–110 m), which re-tore the tiling — it carries 0.63 km² of
// pairwise overlap and one ring with a hole outside its shell. Fine for a
// point-in-polygon match, useless as a border network. See
// scripts/gen-rotterdam-2026-assets.py.
describe("Rotterdam municipality border network", () => {
    it("is a thin, deduped LineString network", () => {
        expect(lines.type).toBe("FeatureCollection");
        expect(lines.features.length).toBeGreaterThan(10);
        for (const f of lines.features) {
            expect(f.geometry.type).toBe("LineString");
        }
        const verts = lines.features.reduce(
            (n, f) => n + f.geometry.coordinates.length,
            0,
        );
        // 1,686 as generated, from 10,098 raw. Each internal border appears once
        // — once per side would roughly double this and make the geodesic
        // buffer do the same work twice.
        expect(verts).toBeLessThan(2000);
        expect(verts).toBeGreaterThan(800);
    });

    it("covers the whole play area, not one municipality", () => {
        const [minX, minY, maxX, maxY] = turf.bbox(lines);
        const [bMinX, bMinY, bMaxX, bMaxY] = turf.bbox(munis);
        // Within ~0.01° of the municipalities' own extent on every side.
        expect(Math.abs(minX - bMinX)).toBeLessThan(0.01);
        expect(Math.abs(minY - bMinY)).toBeLessThan(0.01);
        expect(Math.abs(maxX - bMaxX)).toBeLessThan(0.01);
        expect(Math.abs(maxY - bMaxY)).toBeLessThan(0.01);
    });

    it("every arc lies on a municipality ring", () => {
        const rings = munis.features.flatMap((f) => flatLines(f));
        for (const arc of lines.features.slice(0, 20)) {
            const mid = turf.point(
                arc.geometry.coordinates[
                    Math.floor(arc.geometry.coordinates.length / 2)
                ],
            );
            // 150 m, not London's 100 m: the shipped polygons this is checked
            // against are the coarse ones, simplified ~10x more heavily than
            // the network.
            expect(distTo(mid, rings, "kilometers")).toBeLessThan(0.15);
        }
    });
});

// ── measuring: distance to ANY municipality border ──────────────────────────
async function measureMask(
    base: Feature<Polygon>,
    seeker: [number, number],
    hiderCloser: boolean,
) {
    mapGeoJSON.set(turf.featureCollection([base]) as never);
    return (await adjustPerMeasuring(
        {
            type: "rotterdam-municipality-border",
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

// This is the ALL-borders reading — the london-borough one, Jules' call on the
// grounds that this play area is small — NOT the "border of the division you
// are standing in" behaviour of paris-arrondissement / belgium-province. The
// seeker sits in Capelle aan den IJssel, a small municipality, precisely so the
// two readings produce very different masks: the own-division reading would see
// only Capelle's ring, and every point near a border elsewhere on the map would
// flip. The oracle measures to every arc, so it fails if the handler is ever
// switched.
describe("adjustPerMeasuring — rotterdam-municipality-border (distance to ANY municipality border)", () => {
    const base = boundary(4.49, 51.88, 4.67, 51.98);
    const seeker: [number, number] = [4.58, 51.93]; // Capelle aan den IJssel
    const oracleLines = lines.features;
    const dMin = distTo(turf.point(seeker), oracleLines, "miles");

    const verdictFor =
        (hiderCloser: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const d = distTo(pt, oracleLines, "miles");
            // 8% band, as for London and Belgium: absorbs the geodesic-vs-planar
            // and Mercator-reprojection drift around the decision boundary.
            if (Math.abs(d - dMin) <= dMin * 0.08) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const closer = d <= dMin;
            const kept = hiderCloser ? closer : !closer;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker is ~1 km from the nearest border", () => {
        const km = distTo(turf.point(seeker), oracleLines, "kilometers");
        expect(km).toBeGreaterThan(0.8);
        expect(km).toBeLessThan(1.3);
        // ...and it is inside Capelle, not Rotterdam — the small-municipality
        // scenario the all-vs-own distinction needs.
        const owner = munis.features.find((f) =>
            turf.booleanPointInPolygon(turf.point(seeker), f),
        );
        expect(owner?.properties?.name).toBe("Capelle aan den IJssel");
    });

    it("hiderCloser: keeps a band within d_min of some municipality border", async () => {
        const mask = await measureMask(base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 22), verdictFor(true));
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    }, 120_000);

    it("!hiderCloser: keeps points beyond d_min of every border", async () => {
        const mask = await measureMask(base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 22), verdictFor(false));
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

    it("is genuinely all-borders: an own-municipality reading would differ", () => {
        // Guards the scenario, not the handler: if the seeker had been placed
        // somewhere the two readings happen to agree, the oracle above would
        // pass either way and the test would be worth nothing. Count the sample
        // points whose verdict actually flips between the two.
        const capelle = munis.features.find(
            (f) => f.properties?.name === "Capelle aan den IJssel",
        )!;
        const ownRing = flatLines(capelle);
        const dMinOwn = distTo(turf.point(seeker), ownRing, "miles");
        const flips = sampleGrid(base, 14).filter((pt) => {
            const closerAll = distTo(pt, oracleLines, "miles") <= dMin;
            const closerOwn = distTo(pt, ownRing, "miles") <= dMinOwn;
            return closerAll !== closerOwn;
        });
        expect(flips.length).toBeGreaterThan(50);
    });
});
