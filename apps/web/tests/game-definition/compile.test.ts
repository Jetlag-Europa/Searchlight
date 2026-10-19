import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as turf from "@turf/turf";
import type { FeatureCollection, Point } from "geojson";

vi.mock("@/maps/geo-utils", async (importActual) => {
  const actual = await importActual<typeof import("@/maps/geo-utils")>();
  return {
    ...actual,
    arcBuffer: async (
      fc: FeatureCollection<Point>,
      radius: number,
      unit: turf.Units,
    ) => turf.buffer(fc.features[0], radius, { units: unit }),
    };
});

import { compileGameDefinition } from "@/game-definition/compile";
import { evaluateQuestionOperator } from "@/maps/questions/operators/base";
import type { GameDefinition } from "@searchlight/shared";
const parisDef = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../../games/preloaded/paris-2026.game.json"),
    "utf8",
  ),
);

describe("Runtime Compiler and Operator Dispatch", () => {
  it("compiles Paris 15-08 definition into runtime catalog and radius resolver", () => {
    const compiled = compileGameDefinition(parisDef);

    expect(compiled.gameId).toBe("paris-2026");
    expect(compiled.hidingZones.stations?.length).toBe(412);
    expect(compiled.questions.length).toBe(39); // one radar for its two radii
    const innerRadius = compiled.hidingZones.getRadius("zone-1", "Inner");
    expect(innerRadius.value).toBe(400);
    expect(innerRadius.unit).toBe("meters");

    const outerRadius = compiled.hidingZones.getRadius("zone-2", "Outer");
    expect(outerRadius.value).toBe(600);
    expect(outerRadius.unit).toBe("meters");
  });

  it("evaluates a radius operator on compiled definition against play area", async () => {
    const compiled = compileGameDefinition(parisDef);
    const radiusQ = compiled.questions.find((q) => q.family === "radius");
    expect(radiusQ).toBeDefined();

    const result = await evaluateQuestionOperator({
      questionDef: radiusQ!,
      datasets: compiled.datasets,
      data: {
        lat: 48.8809,
        lng: 2.3553,
        radius: 500,
        unit: "meters",
        within: true,
      },
      mapGeoData: compiled.playArea,
    });

    expect(result).toBeDefined();
    expect(result.type === "FeatureCollection" || result.type === "Feature").toBe(true);
  });

  it("compiles a brand new runtime custom game definition dynamically", () => {
    const customDef = {
      id: "tokyo-2026",
      name: "Tokyo 2026",
      serverId: "home-games",
      map: {
        center: [139.6917, 35.6895],
        playArea: { type: "FeatureCollection", features: [] },
      },
      hidingZones: {
        radius: 300,
        unit: "meters",
        tierOverrides: { Yamanote: 500 },
        features: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "shinjuku",
              geometry: { type: "Point", coordinates: [139.7003, 35.6896] },
              properties: { name: "Shinjuku", tier: "Yamanote" },
            },
          ],
        },
      },
      radars: [300, 500],
      thermometer: true,
      features: [
        {
          name: "Shrines",
          enabledFor: ["matching", "measuring", "tentacle"],
          data: { type: "FeatureCollection", features: [] },
        },
      ],
    };

    const compiled = compileGameDefinition(customDef as any);
    expect(compiled.gameId).toBe("tokyo-2026");
    expect(compiled.hidingZones.stations?.length).toBe(1);
    expect(compiled.hidingZones.getRadius("shinjuku", "Yamanote").value).toBe(500);
    expect(compiled.questions.map((q) => q.id)).toEqual([
      "radius",
      "thermometer",
      "matching-shrines",
      "measuring-shrines",
      "tentacle-shrines",
    ]);
    expect([...compiled.questionMap.keys()]).toEqual(compiled.questions.map((q) => q.id));
  });

  it("detects geometry types and assigns correct operators for polygons and lines", async () => {
    const gameWithPolysAndLines = {
      id: "hamburg-test",
      name: "Hamburg Test",
      serverId: "home-games",
      map: {
        center: [9.99, 53.55],
        playArea: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [[9.8, 53.4], [10.2, 53.4], [10.2, 53.7], [9.8, 53.7], [9.8, 53.4]],
                ],
              },
              properties: {},
            },
          ],
        },
      },
      hidingZones: {
        radius: 400,
        unit: "meters",
        features: { type: "FeatureCollection", features: [] },
      },
      features: [
        {
          name: "Administrative Divisions",
          enabledFor: ["matching", "measuring"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: "altona",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [[9.85, 53.54], [9.95, 53.54], [9.95, 53.60], [9.85, 53.60], [9.85, 53.54]],
                  ],
                },
                properties: { name: "Altona" },
              },
              {
                type: "Feature",
                id: "mitte",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [[9.95, 53.54], [10.05, 53.54], [10.05, 53.60], [9.95, 53.60], [9.95, 53.54]],
                  ],
                },
                properties: { name: "Hamburg-Mitte" },
              },
            ],
          },
        },
        {
          name: "Coastline",
          enabledFor: ["matching", "measuring"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [[9.8, 53.5], [10.1, 53.6]],
                },
                properties: { name: "Elbe Shore" },
              },
            ],
          },
        },
      ],
    };

    const compiled = compileGameDefinition(gameWithPolysAndLines as any);
    const matchAdmin = compiled.questions.find((q) => q.id === "matching-administrative-divisions");
    expect(matchAdmin).toBeDefined();
    expect(matchAdmin?.evaluator?.operator).toBe("containing-region-match");
    expect(matchAdmin?.label).toBe("Same Administrative Divisions");

    const measAdmin = compiled.questions.find((q) => q.id === "measuring-administrative-divisions");
    expect(measAdmin).toBeDefined();
    expect(measAdmin?.evaluator?.operator).toBe("distance-to-containing-region-boundary");

    const measCoast = compiled.questions.find((q) => q.id === "measuring-coastline");
    expect(measCoast).toBeDefined();
    expect(measCoast?.evaluator?.operator).toBe("distance-to-lines");

    const insideAltona = turf.point([9.90, 53.56]);
    const outsideAltona = turf.point([10.00, 53.56]);

    const sameResult = await evaluateQuestionOperator({
      questionDef: matchAdmin!,
      datasets: compiled.datasets,
      data: {
        lat: 53.56,
        lng: 9.90,
        drag: true,
        same: true,
      },
      mapGeoData: compiled.playArea,
    });
    expect(turf.booleanPointInPolygon(insideAltona, sameResult)).toBe(true);
    expect(turf.booleanPointInPolygon(outsideAltona, sameResult)).toBe(false);

    const differentResult = await evaluateQuestionOperator({
      questionDef: matchAdmin!,
      datasets: compiled.datasets,
      data: {
        lat: 53.56,
        lng: 9.90,
        drag: false,
        same: false,
      },
      mapGeoData: compiled.playArea,
    });
    expect(turf.booleanPointInPolygon(insideAltona, differentResult)).toBe(false);
    expect(turf.booleanPointInPolygon(outsideAltona, differentResult)).toBe(true);
  });
  it.each(["points", "multipart lines"])("partitions same/different %s for locked questions", async (kind) => {
    const playArea = turf.featureCollection([turf.bboxPolygon([9.8, 53.4, 10.2, 53.7])]);
    const features = kind === "points"
      ? [turf.point([9.9, 53.55]), turf.point([10.1, 53.55])]
      : [
          turf.multiLineString([[[9.9, 53.4], [9.9, 53.55]], [[9.9, 53.55], [9.9, 53.7]]]),
          turf.lineString([[10.1, 53.4], [10.1, 53.7]]),
        ];
    const compiled = compileGameDefinition({
      id: "matching-contract", name: "Matching contract", serverId: "home-games",
      map: { center: [10, 53.55], playArea },
      hidingZones: { radius: 400, unit: "meters", features: turf.featureCollection([]) },
      features: [{ name: "Targets", enabledFor: ["matching"], data: turf.featureCollection(features as any) }],
    } as any);
    const questionDef = compiled.questions.find((q) => q.family === "matching")!;
    for (const same of [true, false]) {
      const result = await evaluateQuestionOperator({
        questionDef, datasets: compiled.datasets,
        data: { lat: 53.55, lng: 9.91, drag: false, same }, mapGeoData: playArea,
      });
      expect(turf.booleanPointInPolygon(turf.point([9.91, 53.55]), result)).toBe(same);
      expect(turf.booleanPointInPolygon(turf.point([10.09, 53.55]), result)).toBe(!same);
    }
  });
  it("synthesizes radar and thermometer only when declared", () => {
    const baseGame = {
      id: "radar-test",
      name: "Radar Test",
      serverId: "home-games",
      map: {
        center: [10, 50] as [number, number],
        playArea: { type: "FeatureCollection", features: [] } as unknown as FeatureCollection,
      },
      hidingZones: {
        radius: 350,
        unit: "meters" as const,
        features: { type: "FeatureCollection", features: [] } as unknown as FeatureCollection,
      },
    };
    const families = (def: object) =>
      compileGameDefinition({ ...baseGame, ...def } as unknown as GameDefinition)
        .questions.map((q) => q.family);

    // Omitted -> nothing is enabled by default
    expect(families({})).toEqual([]);

    // Explicitly false -> none
    expect(families({ radars: false, thermometer: false })).toEqual([]);

    // Explicitly true -> one radar at the hiding radius, plus the thermometer
    const compiledTrue = compileGameDefinition({
      ...baseGame,
      radars: true,
      thermometer: true,
    } as unknown as GameDefinition);
    const trueRadar = compiledTrue.questions.find((q) => q.family === "radius");
    expect(trueRadar?.id).toBe("radius");
    expect(trueRadar?.label).toBe("Radar: any radius (starts at 350 m)");
    expect(trueRadar?.defaults?.radii).toEqual([{ value: 350, unit: "meters" }]);
    expect(compiledTrue.questionMap.get("thermometer")?.family).toBe("thermometer");

    // A list of radii -> one radar, with the radii as its presets
    const listed = compileGameDefinition({
      ...baseGame,
      radars: [350, 1000, 350],
    } as unknown as GameDefinition).questions;
    expect(listed.map((q) => q.id)).toEqual(["radius"]);
    expect(listed[0].label).toBe("Radar: any radius (presets 350 m, 1 km)");
    expect(listed[0].defaults?.radii).toEqual([
      { value: 350, unit: "meters" },
      { value: 1000, unit: "meters" },
    ]);
  });

  it("keeps a name's own Nearest/Same/Tentacles prefix only when it is a whole word", () => {
    const region = turf.featureCollection([turf.bboxPolygon([4.3, 50.8, 4.4, 50.9])]);
    const sites = turf.featureCollection([turf.point([4.35, 50.85])]);
    const layer = (name: string, enabledFor: string[], data: FeatureCollection) => ({ name, enabledFor, data });
    const compiled = compileGameDefinition({
      id: "label-prefixes", name: "Label prefixes", serverId: "home-games",
      map: { center: [4.35, 50.85], playArea: region },
      hidingZones: { radius: 400, unit: "meters", features: turf.featureCollection([]) },
      features: [
        layer("Same Arrondissement", ["matching"], region),
        layer("Samedi Market", ["matching"], region),
        layer("Nearest Hospital", ["matching"], sites),
        layer("Nearestville Stop", ["matching"], sites),
        layer("Tentacles of Doom", ["tentacle"], sites),
        layer("Tentacled Shop", ["tentacle"], sites),
      ],
    } as unknown as GameDefinition);
    expect(compiled.questions.map((q) => q.label)).toEqual([
      "Same Arrondissement",
      "Same Samedi Market",
      "Nearest Hospital",
      "Nearest Nearestville Stop",
      "Tentacles of Doom",
      "Tentacles: Tentacled Shop",
    ]);
  });

  it("reads each question's own layer when layer names share a slug", () => {
    const point = (lng: number, name: string) => turf.point([lng, 50.8], { name });
    const compiled = compileGameDefinition({
      id: "slug-collision", name: "Slug collision", serverId: "home-games",
      map: { center: [4.35, 50.85], playArea: turf.featureCollection([]) },
      hidingZones: { radius: 400, unit: "meters", features: turf.featureCollection([]) },
      features: [
        { name: "foo-bar", enabledFor: ["measuring"], data: turf.featureCollection([point(4.3, "B1")]) },
        {
          name: "Foo Bar",
          enabledFor: ["matching"],
          data: turf.featureCollection([point(4.4, "A1"), point(4.41, "A2")]),
        },
      ],
    } as unknown as GameDefinition);
    const names = (questionId: string) => {
      const { datasetId } = compiled.questionMap.get(questionId)!.evaluator.source!;
      return compiled.datasets[datasetId!].features.features.map(
        (f: { properties: { name: string } }) => f.properties.name,
      );
    };
    expect([...compiled.questionMap.keys()]).toEqual(["measuring-foo-bar", "matching-foo-bar"]);
    expect(names("measuring-foo-bar")).toEqual(["B1"]);
    expect(names("matching-foo-bar")).toEqual(["A1", "A2"]);
  });


});
