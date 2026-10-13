import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point, Polygon } from "geojson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hiderMode } from "@/lib/context";
import { adjustPerMatching } from "@/maps/questions/matching";

import { gridAgreement, sampleGrid } from "./oracleCommon";
import { failuresToBad, renderDebugSVG } from "./debugRender";

// The real South Limburg municipalities, read from the preloaded definition and
// used as a player-drawn custom zone: exercises the exact point-in-zone path
// (the Entry 34 "municipality doesn't work" class of bug) on real geometry.
const PRELOADED = resolve(__dirname, "../../../../games/preloaded");

const southLimburgGame = JSON.parse(
    readFileSync(resolve(PRELOADED, "south-limburg-2026.game.json"), "utf8"),
);

interface GameFeature {
    name: string;
    data: FeatureCollection<Polygon>;
}
const features = southLimburgGame.features as GameFeature[];
const municipalities = features.find((f) => f.name === "Municipality")!.data;


afterEach(() => {
    hiderMode.set(false);
    vi.unstubAllGlobals();
});

// The bundled border MUST be a FeatureCollection (Entry 34 / Entry 38) — assert
// the fixture itself so a regression in the asset is caught here too.
it("south-limburg municipalities is a FeatureCollection of polygons", () => {
    expect(municipalities.type).toBe("FeatureCollection");
    expect(municipalities.features.length).toBeGreaterThan(1);
    expect(municipalities.features[0].geometry.type).toMatch(/Polygon/);
});

function matchingQuestion(seeker: [number, number], same: boolean) {
    return {
        type: "custom-zone",
        geo: muniContaining(turf.point(seeker)),
        lat: seeker[1],
        lng: seeker[0],
        same,
        drag: true as const,
        color: "red" as const,
        collapsed: false,
        enabled: true,
    };
}

function muniContaining(pt: Feature<Point>): Feature<Polygon> | null {
    return (
        municipalities.features.find((f) =>
            turf.booleanPointInPolygon(pt, f),
        ) ?? null
    );
}

async function maskFor(
    base: Feature<Polygon>,
    seeker: [number, number],
    same: boolean,
) {
    return (await adjustPerMatching(
        matchingQuestion(seeker, same) as never,
        turf.featureCollection([base]),
    )) as Feature<Polygon> | null;
}

describe("adjustPerMatching — bundled municipality (exact, winding-agnostic)", () => {
    // A box over central South Limburg straddling several municipalities.
    const base = turf.bboxPolygon([5.62, 50.8, 5.82, 50.92]) as Feature<Polygon>;
    const seeker: [number, number] = [5.69, 50.86]; // Maastricht
    const seekerMuni = muniContaining(turf.point(seeker))!;

    // A point is ambiguous only if it's within ~40 m of the seeker-municipality
    // border (float noise on the shared edge) — containment is otherwise exact.
    const seekerMuniLine = turf.polygonToLine(seekerMuni);
    const verdictFor =
        (same: boolean) =>
        (pt: Feature<Point>): "survives" | "eliminated" | "ambiguous" => {
            const distToEdgeKm = turf.pointToLineDistance(pt, seekerMuniLine as never, {
                units: "kilometers",
            });
            if (distToEdgeKm <= 0.04) return "ambiguous";
            const inBase = turf.booleanPointInPolygon(pt, base);
            const inSeekerMuni = turf.booleanPointInPolygon(pt, seekerMuni);
            const kept = same ? inSeekerMuni : !inSeekerMuni;
            return inBase && kept ? "survives" : "eliminated";
        };

    it("scenario sanity: the seeker sits in a known municipality", () => {
        expect(seekerMuni).not.toBeNull();
        expect(seekerMuni.properties?.name).toBeTruthy();
    });

    it("same: keeps exactly the seeker's municipality ∩ base", async () => {
        const mask = await maskFor(base, seeker, true);
        const r = gridAgreement(mask, sampleGrid(base, 44), verdictFor(true));
        if (r.failures.length)
            renderDebugSVG("matching-municipality-same", {
                base,
                mask,
                sites: [turf.point(seeker, { name: "seeker" })],
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("!same: removes the seeker's municipality from base", async () => {
        const mask = await maskFor(base, seeker, false);
        const r = gridAgreement(mask, sampleGrid(base, 44), verdictFor(false));
        if (r.failures.length)
            renderDebugSVG("matching-municipality-different", {
                base,
                mask,
                sites: [turf.point(seeker, { name: "seeker" })],
                bad: failuresToBad(r.failures),
            });
        expect(r.failures).toEqual([]);
        expect(r.survives).toBeGreaterThan(10);
        expect(r.eliminated).toBeGreaterThan(10);
    });

    it("invariant: same-mask ⊆ base and area ≤ base", async () => {
        const mask = await maskFor(base, seeker, true);
        expect(mask).not.toBeNull();
        expect(turf.area(mask!)).toBeLessThanOrEqual(turf.area(base));
    });
});
