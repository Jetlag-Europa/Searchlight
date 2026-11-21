import { describe, expect, it } from "vitest";
import {
  deriveFeatureQuestionId,
  resolveGameDefinitionId,
  type GameDefinition,
} from "./schema.js";
import { validateGameDefinition } from "./validate.js";
function getSampleDefinition(): GameDefinition {
  return {
    id: "paris-2026",
    name: "Paris 15-08",
    serverId: "1190673594649415730",
    map: {
      center: [2.3522, 48.8566],
      bounds: [2.15, 48.75, 2.55, 48.95],
      playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
      radius: 400,
      unit: "meters",
      tierOverrides: { Outer: 600 },
      features: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "gare-du-nord",
            geometry: { type: "Point", coordinates: [2.3553, 48.8809] },
            properties: { name: "Gare du Nord", tier: "Outer" },
          },
        ],
      },
    },
    radars: [400, 600],
    thermometer: true,
    features: [
      {
        name: "Museums",
        enabledFor: ["matching", "measuring", "tentacle"],
        data: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "louvre",
              geometry: { type: "Point", coordinates: [2.3376, 48.8606] },
              properties: { name: "Louvre" },
            },
          ],
        },
      },
    ],
  };
}

describe("Game Definition Validation", () => {
  it("validates a compliant clean GameDefinition", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails if center coordinates are invalid", () => {
    const def = getSampleDefinition();
    def.map.center = [250, 48.85]; // out of range lng
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
  });

  it("fails if bounds west is greater than east", () => {
    const def = getSampleDefinition();
    def.map.bounds = [5, 48, 2, 49];
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_BOUNDS")).toBe(true);
  });

  it("fails if feature has no embedded data", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      features: [{ name: "Broken Feature", enabledFor: ["matching"] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MISSING_FEATURE_DATA")).toBe(true);
  });

  it("fails if unknown or legacy property (such as source) is specified on a feature", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      features: [
        {
          name: "Airports",
          enabledFor: ["matching"],
          data: { type: "FeatureCollection", features: [] },
          source: "osm-commercial-airports-v1",
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.path === "/features/0/source" && e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("fails when hiding zones contains null member", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      hidingZones: {
        ...def.hidingZones,
        features: { type: "FeatureCollection", features: [null] },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "INVALID_FEATURE_OBJECT" || e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("fails when hiding zones contains MultiPoint geometry", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      hidingZones: {
        ...def.hidingZones,
        features: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "multi-pt",
              geometry: { type: "MultiPoint", coordinates: [[2.3, 48.8], [2.4, 48.9]] },
              properties: {},
            },
          ],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "UNSUPPORTED_GEOMETRY_TYPE" || e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("fails when hiding zones contains LineString geometry", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      hidingZones: {
        ...def.hidingZones,
        features: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "line-zone",
              geometry: { type: "LineString", coordinates: [[2.3, 48.8], [2.4, 48.9]] },
              properties: {},
            },
          ],
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "INVALID_HIDING_ZONE_GEOMETRY" || e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("fails when feature dataset contains MultiPoint geometry", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      features: [
        {
          name: "Points",
          enabledFor: ["matching"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: "mp1",
                geometry: { type: "MultiPoint", coordinates: [[2.3, 48.8], [2.4, 48.9]] },
                properties: {},
              },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.code === "UNSUPPORTED_GEOMETRY_TYPE" || e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("fails when polygon ring is unclosed", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      features: [
        {
          name: "Unclosed Polygon",
          enabledFor: ["matching"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [2.1, 48.7],
                      [2.2, 48.7],
                      [2.2, 48.8],
                      [2.3, 48.9],
                    ],
                  ],
                },
                properties: {},
              },
            ],
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_COORDINATES")).toBe(true);
  });

  it("fails when feature name produces an unusable question ID slug", () => {
    const def = getSampleDefinition();
    def.features = [
      {
        name: "東京",
        enabledFor: ["matching"],
        data: { type: "FeatureCollection", features: [] },
      },
    ];
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INVALID_FEATURE_QUESTION_ID")).toBe(true);
  });

  it("fails when feature names produce colliding question IDs", () => {
    const def = getSampleDefinition();
    def.features = [
      {
        name: "Metro Station",
        enabledFor: ["matching"],
        data: { type: "FeatureCollection", features: [] },
      },
      {
        name: "Metro-Station",
        enabledFor: ["matching"],
        data: { type: "FeatureCollection", features: [] },
      },
    ];
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "COLLIDING_QUESTION_ID")).toBe(true);
  });

  it("fails when two layers share a name, even for different question kinds", () => {
    const def = getSampleDefinition();
    def.features = [
      {
        name: "Water",
        enabledFor: ["matching"],
        data: { type: "FeatureCollection", features: [] },
      },
      {
        name: "Water",
        enabledFor: ["measuring"],
        data: { type: "FeatureCollection", features: [] },
      },
    ];
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(["DUPLICATE_FEATURE_NAME"]);
  });

  it("derives consistent collision-free question IDs via deriveFeatureQuestionId", () => {
    expect(deriveFeatureQuestionId("matching", "Museums")).toBe("matching-museums");
    expect(deriveFeatureQuestionId("measuring", "Rail Terminus")).toBe("measuring-rail-terminus");
    expect(deriveFeatureQuestionId("tentacle", "Shrines")).toBe("tentacle-shrines");
  });

  it("fails when feature collection mixes Point and Polygon geometries", () => {
    const def = getSampleDefinition();
    def.features![0].data = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "p1", geometry: { type: "Point", coordinates: [2.3, 48.8] }, properties: {} },
        { type: "Feature", id: "poly1", geometry: { type: "Polygon", coordinates: [[[2.1, 48.7], [2.2, 48.7], [2.2, 48.8], [2.1, 48.8], [2.1, 48.7]]] }, properties: {} },
      ],
    };
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "MIXED_GEOMETRY")).toBe(true);
  });

  it("fails when LineString layer is enabled for tentacle", () => {
    const def = getSampleDefinition();
    def.features![0].enabledFor = ["tentacle"];
    def.features![0].data = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "line1", geometry: { type: "LineString", coordinates: [[2.1, 48.7], [2.2, 48.8]] }, properties: {} },
      ],
    };
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "INCOMPATIBLE_QUESTION_TYPE")).toBe(true);
  });

  it("resolves canonical game ID via resolveGameDefinitionId", () => {
    expect(resolveGameDefinitionId({ id: "my-game", name: "My Game" })).toBe("my-game");
    expect(resolveGameDefinitionId({ name: "Paris 15-08" })).toBe("paris-15-08");
    expect(resolveGameDefinitionId({ name: "Zürich & Bern!" })).toBe("zurich-bern");
  });

  it("validates game definition when id is omitted (derived from name)", () => {
    const def = getSampleDefinition();
    delete def.id;
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts lowercase slug ids", () => {
    for (const id of ["paris-2026", "luxembourg-2026-10-02", "a1"]) {
      const def = { ...getSampleDefinition(), id };
      expect(validateGameDefinition(def).valid, id).toBe(true);
    }
  });

  it("rejects ids that are not lowercase slugs", () => {
    for (const id of ["Paris-2026", "paris 2026", "zürich-2026", "東京-2026", "-paris", "paris--2026", "paris_2026"]) {
      const result = validateGameDefinition({ ...getSampleDefinition(), id });
      expect(result.valid, id).toBe(false);
      expect(result.errors.some((e) => e.path === "/id"), id).toBe(true);
    }
  });

  it("rejects a revision beyond the 32-bit integer the database stores", () => {
    expect(validateGameDefinition({ ...getSampleDefinition(), revision: 2147483647 }).valid).toBe(true);
    const result = validateGameDefinition({ ...getSampleDefinition(), revision: 2147483648 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "/revision")).toBe(true);
  });

  it("rejects unknown root property (such as legacy gameId alias)", () => {
    const def = getSampleDefinition();
    const withGameId = { ...def, gameId: "legacy-game-id" };
    const result = validateGameDefinition(withGameId);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.path === "/gameId" && e.code === "SCHEMA_VALIDATION_ERROR",
      ),
    ).toBe(true);
  });

  it("reports allowed values for all-literal union errors (unit, size, enabledFor)", () => {
    const badUnit = validateGameDefinition({ ...getSampleDefinition(), unit: "km" });
    expect(badUnit.valid).toBe(false);
    expect(badUnit.errors).toEqual([
      {
        path: "/unit",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "must be one of meters, kilometers, miles",
      },
    ]);

    const badSize = validateGameDefinition({ ...getSampleDefinition(), size: "huge" });
    expect(badSize.valid).toBe(false);
    expect(badSize.errors).toEqual([
      {
        path: "/size",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "must be one of small, medium, large",
      },
    ]);

    const def = getSampleDefinition();
    const badEnabledFor = validateGameDefinition({
      ...def,
      features: [{ ...def.features![0], enabledFor: ["radius"] }],
    });
    expect(badEnabledFor.valid).toBe(false);
    expect(badEnabledFor.errors).toEqual([
      {
        path: "/features/0/enabledFor/0",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "must be one of matching, measuring, tentacle",
      },
    ]);
  });

  it("reports actionable position error for 3D KML and 1-number coordinates", () => {
    const def = getSampleDefinition();
    const inPlayArea = validateGameDefinition({
      ...def,
      map: {
        ...def.map,
        playArea: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [2.1, 48.7, 100],
                    [2.2, 48.7, 100],
                    [2.2, 48.8, 100],
                    [2.1, 48.7, 100],
                  ],
                ],
              },
            },
          ],
        },
      },
    });
    expect(inPlayArea.valid).toBe(false);
    expect(inPlayArea.errors).toEqual([
      {
        path: "/map/playArea/features/0/geometry/coordinates/0/0",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "position must be [lng, lat] (exactly 2 numbers)",
      },
    ]);

    const inFeatureLine = validateGameDefinition({
      ...def,
      features: [
        {
          name: "Rail",
          enabledFor: ["measuring"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [2.1, 48.7, 10],
                    [2.2, 48.8, 10],
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(inFeatureLine.valid).toBe(false);
    expect(inFeatureLine.errors).toEqual([
      {
        path: "/features/0/data/features/0/geometry/coordinates/0",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "position must be [lng, lat] (exactly 2 numbers)",
      },
    ]);

    const oneNumberCenter = validateGameDefinition({
      ...def,
      map: { ...def.map, center: [2.35] },
    });
    expect(oneNumberCenter.valid).toBe(false);
    expect(oneNumberCenter.errors).toEqual([
      {
        path: "/map/center",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "position must be [lng, lat] (exactly 2 numbers)",
      },
    ]);
  });

  it("reports allowed geometry types for disallowed geometry variants while preserving MultiPoint", () => {
    const def = getSampleDefinition();

    const lineInHidingZones = validateGameDefinition({
      ...def,
      hidingZones: {
        ...def.hidingZones,
        features: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "LineString", coordinates: [[2.3, 48.8], [2.4, 48.9]] },
            },
          ],
        },
      },
    });
    expect(lineInHidingZones.valid).toBe(false);
    expect(lineInHidingZones.errors).toEqual([
      {
        path: "/hidingZones/features/features/0/geometry",
        code: "SCHEMA_VALIDATION_ERROR",
        message: 'Unsupported geometry type "LineString"; must be one of Point, Polygon, MultiPolygon',
      },
    ]);

    const geomCollection = validateGameDefinition({
      ...def,
      map: {
        ...def.map,
        playArea: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "GeometryCollection", geometries: [] },
            },
          ],
        },
      },
    });
    expect(geomCollection.valid).toBe(false);
    expect(geomCollection.errors).toEqual([
      {
        path: "/map/playArea/features/0/geometry",
        code: "SCHEMA_VALIDATION_ERROR",
        message: 'Unsupported geometry type "GeometryCollection"; must be one of Polygon, MultiPolygon',
      },
    ]);

    const nullGeometry = validateGameDefinition({
      ...def,
      hidingZones: {
        ...def.hidingZones,
        features: {
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: null }],
        },
      },
    });
    expect(nullGeometry.valid).toBe(false);
    expect(nullGeometry.errors).toEqual([
      {
        path: "/hidingZones/features/features/0/geometry",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "Geometry type must be one of Point, Polygon, MultiPolygon",
      },
    ]);

    const multiPoint = validateGameDefinition({
      ...def,
      features: [
        {
          name: "Points",
          enabledFor: ["matching"],
          data: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "MultiPoint", coordinates: [[2.3, 48.8]] },
              },
            ],
          },
        },
      ],
    });
    expect(multiPoint.valid).toBe(false);
    expect(multiPoint.errors).toEqual([
      {
        path: "/features/0/data/features/0/geometry",
        code: "UNSUPPORTED_GEOMETRY_TYPE",
        message: "MultiPoint geometry is not supported",
      },
    ]);

    // Non-geometry field carrying "MultiPoint" should not misreport as UNSUPPORTED_GEOMETRY_TYPE
    const multiPointUnit = validateGameDefinition({ ...def, unit: "MultiPoint" });
    expect(multiPointUnit.valid).toBe(false);
    expect(multiPointUnit.errors).toEqual([
      {
        path: "/unit",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "must be one of meters, kilometers, miles",
      },
    ]);
  });

  it("reports actionable errors for visibility and radars unions", () => {
    const def = getSampleDefinition();

    const badVisKind = validateGameDefinition({ ...def, visibility: { kind: "public" } });
    expect(badVisKind.valid).toBe(false);
    expect(badVisKind.errors[0].path).toBe("/visibility");
    expect(badVisKind.errors[0].message).toContain('"public"');
    expect(badVisKind.errors[0].message).toContain("server-members");
    expect(badVisKind.errors[0].message).toContain("discord-role");

    const badVisMissingRole = validateGameDefinition({
      ...def,
      visibility: { kind: "discord-role", guildId: "123" },
    });
    expect(badVisMissingRole.valid).toBe(false);
    expect(badVisMissingRole.errors).toEqual([
      {
        path: "/visibility/roleId",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "Expected required property",
      },
    ]);

    const badVisNonObject = validateGameDefinition({ ...def, visibility: "public" });
    expect(badVisNonObject.valid).toBe(false);
    expect(badVisNonObject.errors[0].path).toBe("/visibility");
    expect(badVisNonObject.errors[0].message).toContain("server-members");

    const badRadarsString = validateGameDefinition({ ...def, radars: "yes" });
    expect(badRadarsString.valid).toBe(false);
    expect(badRadarsString.errors[0].path).toBe("/radars");
    expect(badRadarsString.errors[0].message).toContain("boolean");
    expect(badRadarsString.errors[0].message).toContain("positive numbers");

    const badRadarsEmpty = validateGameDefinition({ ...def, radars: [] });
    expect(badRadarsEmpty.valid).toBe(false);
    expect(badRadarsEmpty.errors[0].path).toBe("/radars");
    expect(badRadarsEmpty.errors[0].message).toContain("non-empty array");

    const badRadarsNegative = validateGameDefinition({ ...def, radars: [400, -5] });
    expect(badRadarsNegative.valid).toBe(false);
    expect(badRadarsNegative.errors).toEqual([
      {
        path: "/radars/1",
        code: "SCHEMA_VALIDATION_ERROR",
        message: "Expected number to be greater than 0",
      },
    ]);
  });

  it("deduplicates MISSING_FEATURE_DATA per feature path", () => {
    const def = getSampleDefinition();
    const result = validateGameDefinition({
      ...def,
      features: [{ name: "Broken Feature", enabledFor: ["matching"] }],
    });
    expect(result.valid).toBe(false);
    const missingDataErrors = result.errors.filter((e) => e.code === "MISSING_FEATURE_DATA");
    expect(missingDataErrors).toEqual([
      {
        path: "/features/0/data",
        code: "MISSING_FEATURE_DATA",
        message: "Feature must provide embedded GeoJSON data",
      },
    ]);
  });

  it("mentions the 2-character minimum in INVALID_GAME_ID for short or non-ASCII derived ids", () => {
    const shortId = validateGameDefinition({ ...getSampleDefinition(), id: "a" });
    expect(shortId.valid).toBe(false);
    expect(shortId.errors).toEqual([
      {
        path: "/id",
        code: "INVALID_GAME_ID",
        message: expect.stringMatching(/at least 2 characters/i),
      },
    ]);

    const defNoId = getSampleDefinition();
    delete defNoId.id;
    const emptyDerived = validateGameDefinition({ ...defNoId, name: "東京" });
    expect(emptyDerived.valid).toBe(false);
    expect(emptyDerived.errors).toEqual([
      {
        path: "/id",
        code: "INVALID_GAME_ID",
        message: expect.stringMatching(/at least 2 characters/i),
      },
    ]);
  });

  it("reports duplicate entries in features[i].enabledFor at /features/i/enabledFor instead of self-collision", () => {
    const def = getSampleDefinition();
    def.features = [
      {
        name: "Museums",
        enabledFor: ["matching", "matching", "matching"],
        data: { type: "FeatureCollection", features: [] },
      },
    ];
    const result = validateGameDefinition(def);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      {
        path: "/features/0/enabledFor",
        code: "DUPLICATE_ENABLED_FOR",
        message: 'Feature "Museums" lists "matching" more than once in enabledFor',
      },
    ]);
  });
});
