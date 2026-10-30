import * as turf from "@turf/turf";
import type { MultiPolygon } from "geojson";
import { describe, expect, it } from "vitest";

import type { StationCircle, StationPlace } from "@/maps/api";
import { hidingZoneLayer, type ZoneDisplayStyle } from "@/maps/geo-utils";

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

    it("merges the zones into one feature in no-overlap", () => {
        const overlapping = [zone("a", 0), zone("b", 350)];
        const merged = hidingZoneLayer(overlapping, "no-overlap");
        expect(merged.features).toHaveLength(1);
        expect(merged.features[0].geometry.type).toBe("Polygon");

        const apart = hidingZoneLayer(
            [...overlapping, zone("c", 10_000)],
            "no-overlap",
        );
        expect(apart.features).toHaveLength(1);
        const { geometry } = apart.features[0];
        expect(geometry.type).toBe("MultiPolygon");
        // The overlapping pair is one part, the far zone the other.
        expect((geometry as MultiPolygon).coordinates).toHaveLength(2);
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
