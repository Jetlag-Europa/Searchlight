import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import { GAME_REGISTRY } from "@taibled/shared";
import { isQuestionTypeHidden } from "@/lib/games";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

const LONDON = "__bundled-london-2026__";
const ACCESSIBLE = "__bundled-accessible-london-2026__";
const PUBLIC = resolve(__dirname, "..", "..", "public");
const read = (f: string) => readFileSync(resolve(PUBLIC, f), "utf8");

function pickerTypes(
    schema: typeof matchingQuestionSchema | typeof measuringQuestionSchema,
    kind: "matching" | "measuring",
    sentinel: string,
) {
    return (schema.options as any[])
        .filter((x) => x.description === NO_GROUP)
        .flatMap((x) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter(
            (value: string) =>
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind),
        );
}
const matchingFor = (s: string) => pickerTypes(matchingQuestionSchema, "matching", s);
const measuringFor = (s: string) => pickerTypes(measuringQuestionSchema, "measuring", s);

const london = GAME_REGISTRY.find((g) => g.sentinel === LONDON)!;
const accessible = GAME_REGISTRY.find((g) => g.sentinel === ACCESSIBLE)!;

describe("Accessible London 02-08 manifest", () => {
    it("is registered on the UK server with the same radius as the base game", () => {
        expect(accessible).toBeDefined();
        expect(accessible.name).toBe("Accessible London 02-08");
        expect(accessible.serverId).toBe(london.serverId);
        expect(accessible.hidingRadius).toBe(400);
        expect(accessible.hidingRadiusUnits).toBe("meters");
        expect(accessible.size).toBe(london.size);
    });

    // The two source KMZs are identical layer for layer except Station, so the
    // POI / boundary assets are SHARED rather than duplicated. If these ever
    // need to diverge, generate separate files — don't quietly copy them.
    it("shares every asset with London 02-08 except the hiding zones", () => {
        expect(accessible.kmlPath).toBe(london.kmlPath);
        expect(accessible.boundaryGeoJson).toBe(london.boundaryGeoJson);
        expect(accessible.poiFolders).toEqual(london.poiFolders);
        expect(accessible.stationsKml).toBe("accessible-london-stations.kml");
        expect(accessible.stationsKml).not.toBe(london.stationsKml);
    });

    it("hides the same question types as the base game", () => {
        expect(accessible.hiddenQuestionTypes).toEqual(london.hiddenQuestionTypes);
    });

    it("uses a distinct sentinel and name", () => {
        expect(accessible.sentinel).not.toBe(london.sentinel);
        expect(accessible.name).not.toBe(london.name);
    });
});

describe("accessible-london-stations.kml", () => {
    const body = read("accessible-london-stations.kml");
    const base = read("london-stations.kml");

    // 90 stations are classed accessible_type "Full" (70) or "Partial" (20);
    // 5 of those are also marked "Not Allowed" for proximity and are dropped.
    // The map's "Interchange" and "Travel" classes are excluded entirely.
    it("has the 85 step-free hiding zones", () => {
        expect(body.match(/<Placemark>/g)!.length).toBe(85);
    });

    it("excludes the Full stations the map marks 'Not Allowed'", () => {
        for (const name of ["Heron Quays", "Shadwell", "West India Quay"]) {
            expect(body).not.toContain(`<name>${name}</name>`);
        }
        // Canary Wharf is three separate stations (DLR / Jubilee / Elizabeth).
        // Two are "Not Allowed" for proximity; the third is a valid step-free
        // zone, so exactly one survives — the name alone doesn't disqualify it.
        expect(body.match(/<name>Canary Wharf<\/name>/g)).toHaveLength(1);
    });

    it("is a strict subset of the base game's stations", () => {
        const coords = (kml: string) =>
            new Set(
                [...kml.matchAll(/<coordinates>([^<]+)<\/coordinates>/g)].map((m) =>
                    m[1].trim(),
                ),
            );
        const acc = coords(body);
        const all = coords(base);
        expect(acc.size).toBe(85);
        // Every accessible station is also a station in the base game — the two
        // maps share a station list and differ only in which ones qualify.
        expect([...acc].filter((c) => !all.has(c))).toEqual([]);
    });

    it("all 85 sit inside the shared game boundary", () => {
        const fc = JSON.parse(read("london-border.geojson")) as FeatureCollection<Polygon>;
        const pts = [...body.matchAll(/<coordinates>([^,]+),([^,]+),/g)].map((m) =>
            turf.point([parseFloat(m[1]), parseFloat(m[2])]),
        );
        expect(pts).toHaveLength(85);
        for (const pt of pts) {
            expect(turf.booleanPointInPolygon(pt, fc.features[0])).toBe(true);
        }
    });
});

// GAME_GATED_TYPES was Record<string, string> — one sentinel per type — which
// would have made the three London question types invisible in this game. It
// now accepts an array, read through gateAllows().
describe("shared gating across the two London games", () => {
    it.each(["london-borough", "london-stadium", "london-rail"])(
        "%s is offered in BOTH London games, matching and measuring",
        (type) => {
            for (const sentinel of [LONDON, ACCESSIBLE]) {
                expect(matchingFor(sentinel)).toContain(type);
                expect(measuringFor(sentinel)).toContain(type);
            }
        },
    );

    it.each(["__bundled-belgium-2026__", "__bundled-budapest-2025__"])(
        "the London types stay hidden in %s",
        (sentinel) => {
            for (const type of ["london-borough", "london-stadium", "london-rail"]) {
                expect(matchingFor(sentinel)).not.toContain(type);
                expect(measuringFor(sentinel)).not.toContain(type);
            }
        },
    );

    it("a single-sentinel gate still restricts to exactly one game", () => {
        // Guards the array widening against over-permissiveness.
        expect(gateAllows("belgium-province", "__bundled-belgium-2026__")).toBe(true);
        expect(gateAllows("belgium-province", ACCESSIBLE)).toBe(false);
        expect(gateAllows("budapest-castle", LONDON)).toBe(false);
    });

    it("an ungated type is allowed everywhere", () => {
        expect(gateAllows("major-city", ACCESSIBLE)).toBe(true);
        expect(gateAllows("major-city", "__bundled-belgium-2026__")).toBe(true);
    });
});
