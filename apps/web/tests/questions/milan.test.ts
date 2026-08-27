import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import { isQuestionTypeHidden } from "@/lib/games";
import { parseKMLFolderPOI } from "@/maps/api/importers";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

const PUBLIC = resolve(__dirname, "..", "..", "public");
const read = (f: string) => readFileSync(resolve(PUBLIC, f), "utf8");

const MILAN = "__bundled-milan-2026__";

const border = JSON.parse(read("milan-border.geojson")) as FeatureCollection<Polygon>;
const poi = parseKMLFolderPOI(read("milan-poi.kml"));
const stationsKml = read("milan-stations.kml");

// ── Assets ───────────────────────────────────────────────────────────────────

describe("Milan assets", () => {
    it("border is a FeatureCollection with one CCW polygon", () => {
        // A bare Feature here throws into the swallowed try/catch in
        // adjustMapGeoDataForQuestion and silently breaks boundary questions.
        expect(border.type).toBe("FeatureCollection");
        expect(border.features).toHaveLength(1);
        expect(border.features[0].geometry.type).toBe("Polygon");

        const rewound = turf.rewind(border.features[0] as Feature<Polygon>, {
            reverse: false,
        }) as Feature<Polygon>;
        expect(rewound.geometry).toEqual(border.features[0].geometry);
    });

    it("play area is the 12 km circle from the source boundary", () => {
        const km2 = turf.area(border.features[0]) / 1e6;
        expect(km2).toBeGreaterThan(440);
        expect(km2).toBeLessThan(460);
    });

    it("ships 269 stations at a uniform radius, tiered by mode", () => {
        const tiers = [...stationsKml.matchAll(/<value>([^<]*)<\/value>/g)].map(
            (m) => m[1],
        );
        expect(tiers).toHaveLength(269);
        const counts: Record<string, number> = {};
        for (const t of tiers) counts[t] = (counts[t] ?? 0) + 1;
        // The manifest has NO tierRadiusOverrides — every station is 400 m, so
        // these tiers are carried but unread. If a future source splits the
        // radius by mode, this is the count to check the override keys against.
        expect(counts).toEqual({
            metro: 103,
            bus: 63,
            tram: 62,
            train: 26,
            trolleybus: 15,
        });
    });

    it("ships 792 POIs in the 14 expected folders", () => {
        const counts = Object.fromEntries(
            Object.entries(poi).map(([k, v]) => [k, v.length]),
        );
        expect(counts).toEqual({
            park: 300,
            library: 92,
            consulate: 90,
            museum: 87,
            castle: 47,
            hospital: 47,
            water_body: 45,
            cinema: 44,
            rail_station: 26,
            golf_course: 5,
            theme_park: 4,
            mountain: 3,
            aquarium: 1,
            airport: 1,
        });
    });

    it("keeps every station and POI inside the play area", () => {
        const inside = (lon: number, lat: number) =>
            turf.booleanPointInPolygon(turf.point([lon, lat]), border.features[0]);

        const stations = [...stationsKml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)];
        expect(stations).toHaveLength(269);
        for (const [, c] of stations) {
            const [lon, lat] = c.split(",").map(Number);
            expect(inside(lon, lat)).toBe(true);
        }

        for (const [cat, pts] of Object.entries(poi))
            for (const p of pts)
                expect(inside(p.lon, p.lat), `${cat}: ${p.name}`).toBe(true);
    });
});

// ── The two category-key traps ───────────────────────────────────────────────

describe("Milan POI category keys avoid the reserved names", () => {
    it("does NOT claim the train_station key", () => {
        // "train_station" overrides the generic same-train-line and
        // same-length-station questions, which must see all 269 of Milan's
        // stations. The source supplies only the 26 heavy-rail ones, so they
        // live under "rail_station" and are read by milan-train alone.
        expect(poi).not.toHaveProperty("train_station");
        expect(poi.rail_station).toHaveLength(26);
    });

    it("does NOT name the water folder 'water'", () => {
        // SKIPPED_POI_CATEGORIES in importers.ts drops a folder named "water"
        // outright — the 45 water bodies would vanish with no error.
        expect(poi).not.toHaveProperty("water");
        expect(poi.water_body).toHaveLength(45);
    });
});

// ── Picker gating ────────────────────────────────────────────────────────────

const MILAN_TYPES = ["milan-castle", "milan-train", "milan-water"];

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

describe("Milan question picker gating", () => {
    it.each(MILAN_TYPES)("%s is offered for both matching and measuring", (t) => {
        expect(pickerTypes(matchingQuestionSchema, "matching", MILAN)).toContain(t);
        expect(
            pickerTypes(measuringQuestionSchema as never, "measuring", MILAN),
        ).toContain(t);
    });

    it.each(["__bundled-graz-2026__", "__bundled-paris-2026__"])(
        "no Milan type is offered for %s",
        (other) => {
            const m = pickerTypes(matchingQuestionSchema, "matching", other);
            const d = pickerTypes(measuringQuestionSchema as never, "measuring", other);
            for (const t of MILAN_TYPES) {
                expect(m).not.toContain(t);
                expect(d).not.toContain(t);
            }
        },
    );

    // Jules' call, 27/08/2026: aquarium and airport have exactly ONE feature
    // each, so "is your nearest one the same as mine?" is always yes and
    // eliminates nothing. Measuring the distance to them is a real question and
    // is deliberately kept. Both halves are asserted so that neither a future
    // cleanup that hides them outright, nor one that unhides matching, passes
    // silently.
    it("hides matching for the single-POI types but keeps measuring", () => {
        const m = pickerTypes(matchingQuestionSchema, "matching", MILAN);
        const d = pickerTypes(measuringQuestionSchema as never, "measuring", MILAN);

        expect(m).not.toContain("aquarium-full");
        expect(m).not.toContain("airport");
        expect(d).toContain("aquarium-full");
        expect(d).toContain("airport");
    });

    // The inverse of the assertion most games need: Milan hides nothing else,
    // so a copy-pasted hidden list from another game would fail here. (Graz
    // hides airport and aquarium for BOTH families; Paris hides peak-full.)
    it("leaves every other supplied category available", () => {
        const m = pickerTypes(matchingQuestionSchema, "matching", MILAN);
        const d = pickerTypes(measuringQuestionSchema as never, "measuring", MILAN);
        for (const t of [
            "museum-full",
            "library-full",
            "park-full",
            "cinema-full",
            "hospital-full",
            "consulate-full",
            "golf_course-full",
            "theme_park-full",
            "peak-full",
        ]) {
            expect(m, `matching ${t}`).toContain(t);
            expect(d, `measuring ${t}`).toContain(t);
        }
    });
});
