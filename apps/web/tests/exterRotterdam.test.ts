import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import { parseKMLFolderPOI } from "@/maps/api/importers";
import { GAME_GATED_TYPES } from "@/maps/schema";

const SENTINEL = "__bundled-exter-rotterdam-2026__";

function publicAsset(name: string): string {
    return readFileSync(
        fileURLToPath(new URL(`../public/${name}`, import.meta.url)),
        "utf-8",
    );
}

// The folder names in exter-rotterdam-poi.kml are the POI category keys directly
// (mirrors GAME_KML_POI_FOLDERS["__bundled-exter-rotterdam-2026__"] in games.ts).
const POI_FOLDERS: Record<string, string> = {
    library: "library",
    museum: "museum",
    hospital: "hospital",
    zoo: "zoo",
    cinema: "cinema",
    golf_course: "golf_course",
    consulate: "consulate",
    theme_park: "theme_park",
    airport: "airport",
};

describe("Exter Rotterdam 26 — bundled POI KML", () => {
    const poi = parseKMLFolderPOI(publicAsset("exter-rotterdam-poi.kml"), POI_FOLDERS);

    it("parses all 9 categories with the expected counts (108 total)", () => {
        const expected: Record<string, number> = {
            library: 41,
            museum: 23,
            hospital: 9,
            zoo: 9,
            cinema: 9,
            golf_course: 7,
            consulate: 5,
            theme_park: 4,
            airport: 1,
        };
        for (const [cat, count] of Object.entries(expected)) {
            expect(poi[cat]?.length, `category ${cat}`).toBe(count);
        }
        const total = Object.values(poi).reduce((n, arr) => n + arr.length, 0);
        expect(total).toBe(108);
    });

    it("gives every POI a finite coordinate", () => {
        for (const points of Object.values(poi)) {
            for (const p of points) {
                expect(Number.isFinite(p.lat)).toBe(true);
                expect(Number.isFinite(p.lon)).toBe(true);
            }
        }
    });
});

describe("Exter Rotterdam 26 — municipalities & border geojson", () => {
    const munis = JSON.parse(publicAsset("exter-rotterdam-municipalities.geojson"));
    const border = JSON.parse(publicAsset("exter-rotterdam-border.geojson"));

    it("has 10 named municipality polygons", () => {
        expect(munis.type).toBe("FeatureCollection");
        expect(munis.features).toHaveLength(10);
        const names = munis.features.map((f: any) => f.properties.name).sort();
        expect(names).toEqual(
            [
                "Albrandswaard",
                "Barendrecht",
                "Capelle aan den IJssel",
                "Krimpen aan den IJssel",
                "Maassluis",
                "Nissewaard",
                "Ridderkerk",
                "Rotterdam",
                "Schiedam",
                "Vlaardingen",
            ].sort(),
        );
        for (const f of munis.features) {
            expect(f.geometry.type).toBe("Polygon");
        }
    });

    it("resolves Rotterdam centrum to the Rotterdam municipality (matching question logic)", () => {
        // Mirrors determineMatchingBoundary's `rotterdam-municipality` lookup.
        const pt = turf.point([4.4777, 51.9244]);
        const hit = munis.features.find((f: any) =>
            turf.booleanPointInPolygon(pt, f),
        );
        expect(hit?.properties.name).toBe("Rotterdam");
    });

    it("border is a single Polygon FeatureCollection containing the game centre", () => {
        expect(border.type).toBe("FeatureCollection");
        expect(border.features).toHaveLength(1);
        expect(border.features[0].geometry.type).toBe("Polygon");
        const pt = turf.point([4.4777, 51.9244]);
        expect(turf.booleanPointInPolygon(pt, border.features[0])).toBe(true);
    });
});

describe("Exter Rotterdam 26 — measuring line geojson", () => {
    it.each([
        ["exter-rotterdam-hsl.geojson", "HSL"],
        ["exter-rotterdam-coastline.geojson", "Kustlijn"],
    ])("%s is a LineString FeatureCollection", (file, name) => {
        const fc = JSON.parse(publicAsset(file));
        expect(fc.type).toBe("FeatureCollection");
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry.type).toBe("LineString");
        expect(fc.features[0].properties.name).toBe(name);
        expect(fc.features[0].geometry.coordinates.length).toBeGreaterThan(100);
    });
});

describe("Exter Rotterdam 26 — question type gating", () => {
    const expectedGated = [
        "rotterdam-municipality",
        "rotterdam-rail",
        "rotterdam-coastline",
        "rotterdam-library",
        "rotterdam-museum",
        "rotterdam-hospital",
        "rotterdam-zoo",
        "rotterdam-cinema",
        "rotterdam-golf_course",
        "rotterdam-consulate",
        "rotterdam-theme_park",
        "rotterdam-airport",
    ];

    it("gates every rotterdam-* type to the Rotterdam sentinel", () => {
        for (const type of expectedGated) {
            expect(GAME_GATED_TYPES[type], type).toBe(SENTINEL);
        }
    });

    it("does not gate any rotterdam-* type to a different game", () => {
        for (const [type, sentinel] of Object.entries(GAME_GATED_TYPES)) {
            if (type.startsWith("rotterdam-")) {
                expect(sentinel).toBe(SENTINEL);
            }
        }
    });
});
