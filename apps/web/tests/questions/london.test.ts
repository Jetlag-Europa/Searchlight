import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { FeatureCollection, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import { GAME_REGISTRY } from "@taibled/shared";
import { isQuestionTypeHidden } from "@/lib/games";
import { categoryForQuestionType } from "@/lib/poiOverride";
import {
    determineUnionizedStrings,
    gateAllows,
    matchingQuestionSchema,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

const LONDON = "__bundled-london-2026__";
const PUBLIC = resolve(__dirname, "..", "..", "public");

const read = (f: string) => readFileSync(resolve(PUBLIC, f), "utf8");

// Mirrors the filters in components/cards/{matching,measuring}.tsx: an
// ungrouped type is offered only when it is ungated or gated to the active
// game, and not hidden by the manifest.
function pickerTypes(
    schema: typeof matchingQuestionSchema | typeof measuringQuestionSchema,
    kind: "matching" | "measuring",
    sentinel: string,
) {
    return (schema.options as any[])
        .filter((x) => x.description === NO_GROUP)
        .flatMap((x) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter((value: string) => {
            return (
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, kind)
            );
        });
}

const matchingFor = (s: string) =>
    pickerTypes(matchingQuestionSchema, "matching", s);
const measuringFor = (s: string) =>
    pickerTypes(measuringQuestionSchema, "measuring", s);

// ── Manifest ─────────────────────────────────────────────────────────────────

describe("London 02-08 manifest", () => {
    const manifest = GAME_REGISTRY.find((g) => g.sentinel === LONDON)!;

    it("is registered on the UK server with a 400 m hiding radius", () => {
        expect(manifest).toBeDefined();
        expect(manifest.name).toBe("London 02-08");
        expect(manifest.serverId).toBe("1059625399979606166");
        expect(manifest.hidingRadius).toBe(400);
        expect(manifest.hidingRadiusUnits).toBe("meters");
        // No tier data in the source KMZ — every station is a uniform 400 m.
        expect(manifest.tierRadiusOverrides).toBeUndefined();
    });

    it("points at the three bundled assets", () => {
        expect(manifest.kmlPath).toBe("london-poi.kml");
        expect(manifest.stationsKml).toBe("london-stations.kml");
        expect(manifest.boundaryGeoJson).toBe("london-border.geojson");
        expect(manifest.poiFolders).toEqual({});
    });
});

// ── Assets ───────────────────────────────────────────────────────────────────

describe("london-stations.kml", () => {
    const body = read("london-stations.kml");

    it("has the 271 allowed stations", () => {
        expect(body.match(/<Placemark>/g)!.length).toBe(271);
    });

    it("excludes every station the source marked 'Not Allowed'", () => {
        // Spot-check three of the 99, including Streatham Common — the one row
        // where the source's `allowed` field (Yes) disagrees with `category`
        // (Not Allowed). The hiding-zone circle layer agrees with `category`,
        // so `category` wins and this station is out.
        for (const name of ["Catford", "Streatham Common", "Bowes Park"]) {
            expect(body).not.toContain(`<name>${name}</name>`);
        }
    });
});

describe("london-border.geojson", () => {
    const fc = JSON.parse(read("london-border.geojson")) as FeatureCollection<Polygon>;

    // A bare Feature throws on the custom-boundary path and the error is
    // swallowed silently, so boundary questions stop eliminating zones with no
    // visible failure. See docs/ADDING_GAMES.md.
    it("is a FeatureCollection with one polygon", () => {
        expect(fc.type).toBe("FeatureCollection");
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry.type).toBe("Polygon");
    });

    it("is the Zone 1-3 circle: r = 14.5 km around Charing Cross", () => {
        const ring = fc.features[0].geometry.coordinates[0];
        expect(ring).toHaveLength(361); // 360 vertices + closing point
        const centre = turf.point([-0.12807, 51.50795]);
        const radii = ring
            .slice(0, -1)
            .map((c) => turf.distance(centre, turf.point(c), { units: "kilometers" }));
        expect(Math.min(...radii)).toBeGreaterThan(14.4);
        expect(Math.max(...radii)).toBeLessThan(14.6);
    });

    it("winds counter-clockwise (RFC 7946)", () => {
        expect(turf.booleanClockwise(fc.features[0].geometry.coordinates[0])).toBe(
            false,
        );
    });

    it("contains every station", () => {
        const poly = fc.features[0];
        const coords = [
            ...read("london-stations.kml").matchAll(
                /<coordinates>([^,]+),([^,]+),/g,
            ),
        ].map((m) => turf.point([parseFloat(m[1]), parseFloat(m[2])]));
        expect(coords).toHaveLength(271);
        const outside = coords.filter((p) => !turf.booleanPointInPolygon(p, poly));
        expect(outside).toHaveLength(0);
    });
});

describe("london-poi.kml", () => {
    const body = read("london-poi.kml");
    const counts = Object.fromEntries(
        [...body.matchAll(/<Folder>\s*<name>([^<]+)<\/name>([\s\S]*?)<\/Folder>/g)].map(
            (m) => [m[1], (m[2].match(/<Placemark>/g) ?? []).length],
        ),
    );

    it("splits the mixed source folders into the right categories", () => {
        expect(counts).toEqual({
            zoo: 3,
            aquarium: 2,
            golf_course: 20,
            museum: 176,
            cinema: 111,
            hospital: 39,
            library: 225,
            stadium: 12,
            rail_terminus: 14,
        });
    });

    // Putting the 14 termini under "train_station" would override the generic
    // same-train-line / same-length-station questions (matching.ts), which must
    // see all 271 London stations. Keep them in their own category.
    it("does NOT use the train_station category", () => {
        expect(body).not.toContain("<name>train_station</name>");
    });
});

// ── Question wiring ──────────────────────────────────────────────────────────

describe("London custom questions", () => {
    it("offers all three London types for matching AND measuring", () => {
        for (const type of ["london-borough", "london-stadium", "london-rail"]) {
            expect(matchingFor(LONDON)).toContain(type);
            expect(measuringFor(LONDON)).toContain(type);
        }
    });

    it.each([
        "__bundled-belgium-2026__",
        "__bundled-budapest-2025__",
        "__bundled-south-limburg-2026__",
    ])("does not offer them for %s", (sentinel) => {
        for (const type of ["london-borough", "london-stadium", "london-rail"]) {
            expect(matchingFor(sentinel)).not.toContain(type);
            expect(measuringFor(sentinel)).not.toContain(type);
        }
    });

    it("resolves both types to their bundled POI category", () => {
        expect(categoryForQuestionType("london-stadium")).toBe("stadium");
        expect(categoryForQuestionType("london-rail")).toBe("rail_terminus");
    });
});

describe("London hidden question types", () => {
    it("hides the categories the source map does not provide", () => {
        const offered = [...matchingFor(LONDON), ...measuringFor(LONDON)];
        for (const type of [
            "airport",
            "theme_park-full",
            "peak-full",
            "consulate-full",
            "park-full",
            "coastline",
        ]) {
            expect(offered).not.toContain(type);
        }
    });

    it("keeps the categories it does provide", () => {
        const offered = [...matchingFor(LONDON), ...measuringFor(LONDON)];
        for (const type of [
            "zoo-full",
            "aquarium-full",
            "golf_course-full",
            "museum-full",
            "cinema-full",
            "hospital-full",
            "library-full",
        ]) {
            expect(offered).toContain(type);
        }
    });

    it("hides the theme_park tentacle", () => {
        expect(isQuestionTypeHidden("theme_park", LONDON, "tentacle")).toBe(true);
        expect(isQuestionTypeHidden("zoo", LONDON, "tentacle")).toBe(false);
    });
});
