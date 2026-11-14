import * as turf from "@turf/turf";
import type { MultiPolygon } from "geojson";
import { describe, expect, it } from "vitest";

import type { StationCircle, StationPlace } from "@/maps/api";
import { hidingZoneLayer, type ZoneDisplayStyle } from "@/maps/geo-utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

const STYLES: ZoneDisplayStyle[] = [
    "no-overlap",
    "zones",
    "stations",
    "no-display",
];

/** A 500 m zone around a station `east` metres east of the origin. */
function zone(id: string, east: number): StationCircle {
    const centre = turf.destination([10, 50], east, 90, { units: "meters" })
        .geometry.coordinates;
    const place: StationPlace = turf.point(centre, { id, name: id });
    return turf.circle(centre, 500, {
        steps: 32,
        units: "meters",
        properties: place,
    });
}

describe("hidingZoneLayer", () => {
    // The sidebar draws this on every load, before the zones are worked
    // out, and after Disable All or with every zone ruled out.
    it.each(STYLES)("draws nothing for no zones in %s", (style) => {
        const layer = hidingZoneLayer([], style);
        expect(layer.type).toBe("FeatureCollection");
        expect(layer.features).toHaveLength(0);
    });

    it("draws a single zone as itself in no-overlap", () => {
        const only = zone("a", 0);
        const layer = hidingZoneLayer([only], "no-overlap");
        // The zone itself, so it keeps its name label.
        expect(layer.features).toEqual([only]);
    });

    // Two or more zones are merged by the worker, as the sidebar asks it to.
    it("merges the zones into one outline in no-overlap", async () => {
        const merge = (regions: StationCircle[]) =>
            requestGeometry(
                { kind: "union", regions },
                { supersede: "hiding-zone-outline" },
            );
        const overlapping = [zone("a", 0), zone("b", 350)];
        expect((await merge(overlapping))?.geometry.type).toBe("Polygon");

        const apart = await merge([...overlapping, zone("c", 10_000)]);
        expect(apart?.geometry.type).toBe("MultiPolygon");
        // The overlapping pair is one part, the far zone the other.
        expect((apart?.geometry as MultiPolygon).coordinates).toHaveLength(2);
    });

    it("draws each zone's station in stations", () => {
        const zones = [zone("a", 0), zone("b", 350)];
        const layer = hidingZoneLayer(zones, "stations");
        expect(layer.features.map((f) => f.geometry.type)).toEqual([
            "Point",
            "Point",
        ]);
        expect(layer.features.map((f) => f.properties?.id)).toEqual(["a", "b"]);
    });

    it("draws the zones unchanged in zones", () => {
        const zones = [zone("a", 0), zone("b", 350)];
        expect(hidingZoneLayer(zones, "zones").features).toEqual(zones);
    });

    it("draws nothing in no-display", () => {
        const zones = [zone("a", 0), zone("b", 350)];
        expect(hidingZoneLayer(zones, "no-display").features).toHaveLength(0);
    });
});
