import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GAME_REGISTRY, POI_CATEGORIES } from "@taibled/shared";

const PUBLIC_DIR = resolve(__dirname, "../public");

describe("GAME_REGISTRY integrity", () => {
    it("has unique sentinels and names", () => {
        const sentinels = GAME_REGISTRY.map((g) => g.sentinel);
        expect(new Set(sentinels).size).toBe(sentinels.length);
        const names = GAME_REGISTRY.map((g) => g.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it("every referenced asset file exists in public/", () => {
        const missing: string[] = [];
        for (const g of GAME_REGISTRY) {
            for (const asset of [
                g.kmlPath,
                g.stationsKml,
                g.boundaryGeoJson,
                g.hidingZoneGeoJson,
            ]) {
                if (asset && !existsSync(resolve(PUBLIC_DIR, asset))) {
                    missing.push(`${g.sentinel}: ${asset}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it("uses sane radius units and a valid OSM feature per game", () => {
        for (const g of GAME_REGISTRY) {
            expect(["meters", "kilometers", "miles"]).toContain(g.hidingRadiusUnits);
            expect(g.hidingRadius).toBeGreaterThan(0);
            expect(g.osm.type).toBe("Feature");
            expect(g.osm.properties.osm_id).toBeGreaterThan(0);
            expect(g.osm.geometry.coordinates).toHaveLength(2);
        }
    });

    it("exposes the 13 canonical rulebook POI categories", () => {
        expect(POI_CATEGORIES).toContain("mountain");
        expect(POI_CATEGORIES).toContain("rail");
        expect(POI_CATEGORIES).toHaveLength(13);
    });
});
