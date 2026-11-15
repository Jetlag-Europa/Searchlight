import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import { calculateClip } from "@/maps/geo-utils/clipGeometry";

// From a generated Belgium 2026 session, cut down to the vertices that
// matter. `remaining` is what earlier questions left: two of its vertices are
// where they cut the play area's border near Bastogne. `region` is a later
// question's region with that border as one long edge, so those vertices lie
// on the edge to within floating-point rounding. Turf alone throws "Unable to
// complete output ring" on both operations below.
const remaining = turf.polygon([
    [
        [5.766071733052178, 49.88806803254891],
        [5.76497271875, 49.888243],
        [5.763374, 49.888243],
        [5.761815051892258, 49.888745713131584],
        [5.766071733052178, 49.88806803254891],
    ],
]);
const region = turf.polygon([
    [
        [5.772405, 49.884737],
        [5.770607, 49.887346],
        [5.757341, 49.889458],
        [5.772405, 49.884737],
    ],
]);

describe("clipping where a vertex lies on the other polygon's edge", () => {
    it("intersects instead of throwing", () => {
        // The region's border edge runs along the top of `remaining`, so
        // all of it but a sliver is inside the region.
        const inside = calculateClip({
            kind: "clip",
            mapData: turf.featureCollection([remaining]),
            modifications: region,
            within: true,
        });
        expect(turf.area(inside!)).toBeCloseTo(turf.area(remaining), 0);
    });

    it("subtracts instead of throwing", () => {
        const rest = calculateClip({
            kind: "clip",
            mapData: turf.featureCollection([region]),
            modifications: remaining,
            within: false,
        });
        // All of `remaining` but a sliver lies inside the region.
        const expected = turf.area(region) - turf.area(remaining);
        expect(Math.abs(turf.area(rest!) - expected)).toBeLessThan(2);
    });
});
