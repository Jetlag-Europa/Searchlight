import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { expect, it } from "vitest";
import { holedMask, modifyMapData } from "@/maps/geo-utils/operators";

it("fully shades a map with no remaining area", () => {
    const empty = turf.featureCollection<Polygon>([]);
    const mask = holedMask(empty);
    expect(turf.booleanPointInPolygon(turf.point([4.5, 51.9]), mask!)).toBe(
        true,
    );
    expect(holedMask(mask!)).toBeNull();
});

it("keeps empty areas empty and distinguishes including from excluding an empty constraint", async () => {
    const empty = turf.featureCollection<Polygon>([]);
    const boundary = turf.bboxPolygon([4, 51, 5, 52]);
    const area = turf.featureCollection([boundary]);
    expect(await modifyMapData(empty, boundary, false)).toBeNull();
    expect(await modifyMapData(area, empty, true)).toBeNull();
    expect(await modifyMapData(area, empty, false)).toEqual(boundary);
});
