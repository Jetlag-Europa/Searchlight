import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { describe, expect, it } from "vitest";

import { isQuestionTypeHidden } from "@/lib/games";
import { parseKMLFolderPOI } from "@/maps/api/importers";
import { categoryForQuestionType } from "@/lib/poiOverride";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";
import { GAME_REGISTRY } from "@taibled/shared";

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
});
