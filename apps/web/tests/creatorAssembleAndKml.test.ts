import { type PlayAreaFeatureCollection, validateGameDefinition } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";
import { checkGameQuality } from "@/game-definition/inspect";
import { assembleGameDefinition, validateCreatorLayers } from "@/lib/creator/assemble";
import { buildGameKml, hexToKmlColor, planKmlFolders } from "@/lib/creator/kml";
import { rectanglePlayArea } from "@/lib/creator/overpass";

describe("assembleGameDefinition", () => {
  const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("produces a valid, compilable, check-game-clean GameDefinition", async () => {
    const def = assembleGameDefinition({
      name: "Zurich Casual",
      size: "medium",
      unit: "meters",
      hidingRadius: 400,
      tierOverrides: { Outer: 600, Unused: 900 },
      radars: [250, 400, 800],
      thermometer: true,
      playArea,
      stations: [
        {
          uid: "1",
          name: "Central",
          lng: 8.540123456,
          lat: 47.377987654,
          enabled: true,
        },
        {
          uid: "2",
          name: "Central",
          lng: 8.56,
          lat: 47.39,
          enabled: true,
          tier: "Outer",
        },
        {
          uid: "3",
          name: "Disabled Stop",
          lng: 8.52,
          lat: 47.36,
          enabled: false,
        },
      ],
      layers: [
        {
          id: "museum",
          name: "Museum",
          family: "points",
          osmFilter: '["tourism"="museum"]',
          enabledFor: ["matching", "measuring", "tentacle"],
          color: "#e11d48",
          selected: true,
          sourceLabel: "OSM POI",
          vertexCount: 3,
          items: [
            {
              uid: "m1",
              name: "Art & Craft",
              geometry: { type: "Point", coordinates: [8.545, 47.37] },
              enabled: true,
            },
            {
              uid: "m2",
              name: "Science Hall",
              geometry: { type: "Point", coordinates: [8.555, 47.38] },
              enabled: true,
            },
            {
              uid: "m3",
              name: "Excluded Museum",
              geometry: { type: "Point", coordinates: [8.53, 47.36] },
              enabled: false,
            },
          ],
        },
      ],
    });

    expect(validateGameDefinition(def)).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    const compiled = compileGameDefinition(def);
    expect(compiled.hidingZones.features.features).toHaveLength(2);
    expect(def.hidingZones.features.features.map((f) => f.id)).toEqual(["central", "central-2"]);
    // Only referenced tiers are emitted.
    expect(def.hidingZones.tierOverrides).toEqual({ Outer: 600 });
    expect(def.features?.[0].data.features).toHaveLength(2);

    const issues = await checkGameQuality(def);
    expect(issues.filter((i) => i.level === "error" || i.strict)).toEqual([]);
  });

  it("flags empty-slug and colliding question IDs while allowing distinct question kinds", () => {
    const errors = validateCreatorLayers([
      { name: "博物館", selected: true, enabledFor: ["matching"] },
      { name: "Cafe", selected: true, enabledFor: ["matching"] },
      { name: "Café", selected: true, enabledFor: ["matching"] },
      { name: "博物館", selected: false, enabledFor: ["matching"] }, // unselected layers ignored
    ]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("ASCII");
    expect(errors[1]).toContain("collides");

    // Distinct question kinds with the same slug are valid in Searchlight.
    expect(
      validateCreatorLayers([
        { name: "Café", selected: true, enabledFor: ["matching"] },
        { name: "Cafe", selected: true, enabledFor: ["measuring"] },
      ]),
    ).toEqual([]);
  });

  it("preserves serverId, visibility, polygon hiding zones, and per-zone properties on round-trip", () => {
    const def = assembleGameDefinition({
      name: "Gated Game",
      id: "gated-game",
      size: "small",
      unit: "meters",
      hidingRadius: 400,
      tierOverrides: { "1": 900 },
      radars: true,
      thermometer: true,
      playArea,
      preservedMetadata: {
        serverId: "server-123",
        visibility: {
          kind: "discord-role",
          guildId: "123456789012345678",
          roleId: "987654321098765432",
        },
      },
      stations: [
        // Newly added station prepended at index 0 whose slug collides with both
        // the loaded point zone ("permanent") and polygon zone ("poly-zone").
        {
          uid: "st-new-1",
          name: "Permanent",
          lng: 8.545,
          lat: 47.375,
          tier: "DisplayOnly",
          enabled: true,
        },
        {
          uid: "st-new-2",
          name: "Poly Zone",
          lng: 8.546,
          lat: 47.376,
          enabled: true,
        },
        {
          uid: "st-1",
          name: "Gare",
          lng: 8.54,
          lat: 47.37,
          tier: "1",
          enabled: true,
          originalId: "permanent",
          originalProperties: {
            name: "Gare",
            tier: 1,
            radius: 900,
          },
        },
      ],
      extraHidingZones: [
        {
          type: "Feature",
          id: "poly-zone",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [8.51, 47.36],
                [8.52, 47.36],
                [8.52, 47.37],
                [8.51, 47.37],
                [8.51, 47.36],
              ],
            ],
          },
          properties: { name: "Polygon Zone" },
        },
      ],
      layers: [
        {
          id: "g-1",
          name: "Library",
          family: "points",
          enabledFor: ["matching"],
          color: "#2563eb",
          selected: true,
          sourceLabel: "Loaded .game.json",
          vertexCount: 1,
          items: [
            {
              uid: "f-1",
              name: "Main",
              enabled: true,
              geometry: { type: "Point", coordinates: [8.54, 47.37] },
              originalId: 91,
              originalProperties: { name: "Main", code: "UL" },
            },
          ],
        },
      ],
    });

    expect(validateGameDefinition(def).valid).toBe(true);
    expect(def.serverId).toBe("server-123");
    expect(def.visibility).toEqual({
      kind: "discord-role",
      guildId: "123456789012345678",
      roleId: "987654321098765432",
    });
    expect(def.radars).toBe(true);
    expect(def.hidingZones.features.features).toHaveLength(4);
    // Newly added stops must get disambiguated IDs without stealing loaded IDs.
    expect(def.hidingZones.features.features.map((f) => f.id)).toEqual([
      "permanent-2",
      "poly-zone-2",
      "permanent",
      "poly-zone",
    ]);
    // Tier without radius override is preserved on the station; numeric tier & radius stay intact.
    expect(def.hidingZones.features.features[0].properties).toMatchObject({
      tier: "DisplayOnly",
    });
    expect(def.hidingZones.features.features[2].properties).toMatchObject({
      tier: 1,
      radius: 900,
    });
    expect(def.hidingZones.features.features[3].geometry.type).toBe("Polygon");
    // Feature layer original ID and extra properties survive round-trip.
    expect(def.features?.[0].data.features[0]).toMatchObject({
      id: 91,
      properties: { name: "Main", code: "UL" },
    });
    // Numeric tier also serializes to KML ExtendedData.
    const kml = buildGameKml(def);
    expect(kml.kml).toContain('<Data name="tier"><value>1</value></Data>');
  });
});

describe("buildGameKml", () => {
  const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("converts hex colors to KML aabbggrr format", () => {
    expect(hexToKmlColor("#2563eb", "ff")).toBe("ffeb6325");
    expect(hexToKmlColor("#112233", "22")).toBe("22332211");
  });

  it("escapes XML, combines POIs by default, optionally emits zone circles, and warns past 10 layers", () => {
    const manyLayers = Array.from({ length: 10 }, (_, idx) => ({
      id: `l-${idx}`,
      name: `Category ${idx + 1}`,
      family: "points" as const,
      osmFilter: '["tourism"="museum"]',
      enabledFor: ["matching" as const, "measuring" as const],
      color: "#e11d48",
      selected: true,
      sourceLabel: "OSM POI",
      vertexCount: 2,
      items: [
        {
          uid: `p-${idx}-1`,
          name: `Art & Craft <${idx + 1}>`,
          geometry: {
            type: "Point" as const,
            coordinates: [8.54 + idx * 0.002, 47.37] as [number, number],
          },
          enabled: true,
        },
        {
          uid: `p-${idx}-2`,
          name: `Hall ${idx + 1}`,
          geometry: {
            type: "Point" as const,
            coordinates: [8.55 + idx * 0.002, 47.38] as [number, number],
          },
          enabled: true,
        },
      ],
    }));

    const def = assembleGameDefinition({
      name: "Zurich & Friends",
      size: "medium",
      unit: "meters",
      hidingRadius: 400,
      tierOverrides: {},
      radars: [400],
      thermometer: true,
      playArea,
      stations: [
        {
          uid: "s1",
          name: "Main <HB>\u000b",
          lng: 8.54,
          lat: 47.37,
          enabled: true,
        },
      ],
      layers: manyLayers,
    });

    // Default mobile My Maps mode (maxLayers=9) packs 10 POI categories into
    // the remaining 6 slots (Play Area + Stations + Circles = 3, + 6 POI folders = 9).
    const combined = buildGameKml(def, {
      combinePoisForMyMaps: true,
      includeHidingZoneCircles: true,
    });
    expect(combined.folderCount).toBe(9);
    expect(combined.myMapsWarnings).toEqual([]);
    expect(combined.kml).toContain("Zurich &amp; Friends");
    expect(combined.kml).toContain("Main &lt;HB&gt;");
    expect(combined.kml).toContain("Art &amp; Craft &lt;1&gt;");
    expect(combined.kml).toContain("<name>Hiding Zone Circles</name>");

    // Separate folders exceed My Maps' 9-layer mobile limit and emit a warning.
    const split = buildGameKml(def, {
      combinePoisForMyMaps: false,
      includeHidingZoneCircles: false,
    });
    expect(split.folderCount).toBe(12); // Play Area + Stations + 10 layers
    expect(split.myMapsWarnings[0]).toContain("9 layers");
  });

  it("keeps polygons/lines separate by default, fills remaining mobile 9-layer slots with thematic POIs, and allows manual overrides", () => {
    const def = assembleGameDefinition({
      name: "Randstad Style",
      size: "large",
      unit: "kilometers",
      hidingRadius: 1,
      tierOverrides: {},
      radars: [1, 5],
      thermometer: true,
      playArea,
      stations: [{ uid: "s1", name: "Central", lng: 8.54, lat: 47.37, enabled: true }],
      layers: [
        {
          id: "prov",
          name: "Province",
          family: "polygons",
          enabledFor: ["matching"],
          color: "#f59e0b",
          selected: true,
          sourceLabel: "Imported KML",
          vertexCount: 5,
          items: [
            {
              uid: "p1",
              name: "Utrecht",
              enabled: true,
              geometry: playArea.features[0].geometry,
            },
          ],
        },
        {
          id: "muni",
          name: "Municipality",
          family: "polygons",
          enabledFor: ["matching"],
          color: "#111827",
          selected: true,
          sourceLabel: "Imported KML",
          vertexCount: 5,
          items: [
            {
              uid: "m1",
              name: "Haarlem",
              enabled: true,
              geometry: playArea.features[0].geometry,
            },
          ],
        },
        {
          id: "coast",
          name: "Coastline",
          family: "lines",
          enabledFor: ["measuring"],
          color: "#0284c7",
          selected: true,
          sourceLabel: "Imported KML",
          vertexCount: 2,
          items: [
            {
              uid: "c1",
              name: "North Sea",
              enabled: true,
              geometry: {
                type: "LineString",
                coordinates: [
                  [8.5, 47.35],
                  [8.6, 47.42],
                ],
              },
            },
          ],
        },
        {
          id: "rail",
          name: "Train Line",
          family: "lines",
          enabledFor: ["measuring"],
          color: "#334155",
          selected: true,
          sourceLabel: "Imported KML",
          vertexCount: 2,
          items: [
            {
              uid: "r1",
              name: "IC",
              enabled: true,
              geometry: {
                type: "LineString",
                coordinates: [
                  [8.5, 47.36],
                  [8.6, 47.41],
                ],
              },
            },
          ],
        },
        ...["Hospital", "Airport", "University", "Museum", "Zoo", "Cinema"].map((name, i) => ({
          id: `poi-${i}`,
          name,
          family: "points" as const,
          enabledFor: ["matching" as const],
          color: "#e11d48",
          selected: true,
          sourceLabel: "OSM POI",
          vertexCount: 1,
          items: [
            {
              uid: `pt-${i}`,
              name: `${name} 1`,
              enabled: true,
              geometry: {
                type: "Point" as const,
                coordinates: [8.54 + i * 0.001, 47.37] as [number, number],
              },
            },
          ],
        })),
      ],
    });

    // Without Play Area, with Hiding Zone Circles:
    // Stations + Circles (2) + Province + Municipality + Coastline + Train Line (4) = 6 fixed -> 3 slots left for 6 POIs!
    const plan = planKmlFolders(def, {
      maxLayers: 9,
      includePlayArea: false,
      includeHidingZoneCircles: true,
    });
    expect(plan.totalFolders).toBe(9);
    expect(plan.warnings).toEqual([]);
    expect(plan.layerAssignments.Province).toBe("Province");
    expect(plan.layerAssignments.Municipality).toBe("Municipality");
    expect(plan.layerAssignments.Coastline).toBe("Coastline");
    expect(plan.layerAssignments["Train Line"]).toBe("Train Line");

    // Manual override lets a user combine a line layer and a POI layer into one folder.
    const overridden = planKmlFolders(def, {
      maxLayers: 8,
      includePlayArea: false,
      includeHidingZoneCircles: true,
      layerFolderOverrides: {
        Coastline: "Lines & Transit",
        "Train Line": "Lines & Transit",
        Airport: "Lines & Transit",
      },
    });
    expect(overridden.layerAssignments.Coastline).toBe("Lines & Transit");
    expect(overridden.layerAssignments["Train Line"]).toBe("Lines & Transit");
    expect(overridden.layerAssignments.Airport).toBe("Lines & Transit");
    expect(overridden.totalFolders).toBeLessThanOrEqual(8);
  });

  it("handles __proto__ layer names safely, omits HTML descriptions, and outputs CCW KML outer rings", () => {
    const cwPlayArea: PlayAreaFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            // Intentionally clockwise outer ring
            coordinates: [
              [
                [8.5, 47.35],
                [8.5, 47.42],
                [8.6, 47.42],
                [8.6, 47.35],
                [8.5, 47.35],
              ],
            ],
          },
          properties: { name: "CW Area" },
        },
      ],
    };
    const def = assembleGameDefinition({
      name: "Proto Safe",
      size: "small",
      unit: "meters",
      hidingRadius: 400,
      tierOverrides: {},
      radars: false,
      thermometer: false,
      playArea: cwPlayArea,
      stations: [{ uid: "s1", name: "S1", lng: 8.54, lat: 47.37, enabled: true }],
      layers: [
        {
          id: "p1",
          name: "__proto__",
          family: "points",
          osmFilter: '["amenity"="cafe"]',
          enabledFor: ["matching"],
          color: "#2563eb",
          selected: true,
          sourceLabel: "OSM POI",
          vertexCount: 1,
          items: [
            {
              uid: "i1",
              name: "<b>Spot</b>",
              geometry: { type: "Point", coordinates: [8.55, 47.38] },
              enabled: true,
            },
          ],
        },
      ],
    });

    const res = buildGameKml(def, {
      maxLayers: 9,
      layerColors: {},
      layerFolderOverrides: { __proto__: "POIs" },
    });
    expect(res.kml).not.toContain("<description>");
    // First two coordinates in Play Area should now be reversed to CCW: (8.5,47.35) -> (8.6,47.35)
    expect(res.kml).toContain("8.5,47.35,0 8.6,47.35,0 8.6,47.42,0");
  });

  it("stores layer color & semantic icon in .game.json and emits native Google My Maps KML styles", async () => {
    const def = assembleGameDefinition({
      name: "Styled Randstad",
      size: "large",
      unit: "kilometers",
      hidingRadius: 1,
      tierOverrides: {},
      radars: [1],
      thermometer: true,
      playArea,
      stations: [{ uid: "s1", name: "Utrecht", lng: 8.54, lat: 47.37, enabled: true }],
      layers: [
        {
          id: "hosp",
          name: "Hospital",
          family: "points",
          enabledFor: ["matching", "measuring"],
          color: "#FF5252",
          icon: "hospital",
          kmlFolder: "Public Amenities",
          selected: true,
          sourceLabel: "OSM POI",
          vertexCount: 2,
          items: [
            {
              uid: "h1",
              name: "UMC",
              enabled: true,
              geometry: { type: "Point", coordinates: [8.55, 47.38] },
            },
            {
              uid: "h2",
              name: "Diakonessenhuis",
              enabled: true,
              geometry: { type: "Point", coordinates: [8.56, 47.39] },
            },
          ],
        },
        {
          id: "prov",
          name: "Province",
          family: "polygons",
          enabledFor: ["matching"],
          color: "#FFD600",
          selected: true,
          sourceLabel: "Imported KML",
          vertexCount: 10,
          items: [
            {
              uid: "p1",
              name: "Utrecht",
              enabled: true,
              geometry: playArea.features[0].geometry,
            },
            {
              uid: "p2",
              name: "Flevoland",
              enabled: true,
              geometry: playArea.features[0].geometry,
            },
          ],
        },
      ],
    });

    expect(validateGameDefinition(def).valid).toBe(true);
    expect(def.features?.[0].color).toBe("#FF5252");
    expect(def.features?.[0].icon).toBe("hospital");
    expect(def.features?.[0].kmlFolder).toBe("Public Amenities");
    expect(def.features?.[1].color).toBe("#FFD600");
    expect(def.features?.[1].icon).toBeUndefined();

    const issues = await checkGameQuality(def);
    expect(issues.filter((i) => i.level === "error" || i.strict)).toEqual([]);

    const kml = buildGameKml(def, { includeHidingZoneCircles: true });
    // Stations get My Maps train icon (1739), Hospital gets 1807-FF5252 with hover-only labels
    expect(kml.kml).toContain('<StyleMap id="icon-1739-1A237E">');
    expect(kml.kml).toContain('<StyleMap id="icon-1807-FF5252">');
    expect(kml.kml).toContain("<name>Public Amenities</name>");
    expect(kml.kml).toContain("<LabelStyle><scale>0</scale></LabelStyle>");
    expect(kml.kml).toContain(
      "https://www.gstatic.com/mapspro/images/stock/503-wht-blank_maps.png",
    );
    // Explicit polygon color is honored in KML export
    expect(kml.kml).toContain("#poly-FFD600-");
    expect(kml.kml).not.toContain("#poly-7CB342-");

    // Uncolored small multi-region polygon layer falls back to distinct per-region colors
    const uncoloredDef = {
      ...def,
      features: def.features?.map((f) => (f.name === "Province" ? { ...f, color: undefined } : f)),
    };
    const uncoloredKml = buildGameKml(uncoloredDef);
    expect(uncoloredKml.kml).toContain("#poly-FFD600-");
    expect(uncoloredKml.kml).toContain("#poly-7CB342-");

    // Feature folder colliding with base "Stations" folder is disambiguated
    const collidingDef = {
      ...def,
      features: def.features?.map((f) =>
        f.name === "Hospital" ? { ...f, kmlFolder: "Stations" } : f,
      ),
    };
    const collidingStationsOnly = buildGameKml(collidingDef, {
      onlyFolder: "Stations",
    });
    expect(collidingStationsOnly.folderCount).toBe(1);

    // Single-folder KML export (for Google My Maps "Replace all items")
    const stationsOnly = buildGameKml(def, { onlyFolder: "Stations" });
    expect(stationsOnly.folderCount).toBe(1);
    expect(stationsOnly.kml).toContain("<name>Stations</name>");
    expect(stationsOnly.kml).toContain('<StyleMap id="icon-1739-1A237E">');
    expect(stationsOnly.kml).not.toContain("icon-1807-FF5252");
    expect(stationsOnly.kml).not.toContain("<name>Province</name>");

    const amenitiesOnly = buildGameKml(def, {
      onlyFolder: "Public Amenities",
    });
    expect(amenitiesOnly.folderCount).toBe(1);
    expect(amenitiesOnly.kml).toContain("<name>Public Amenities</name>");
    expect(amenitiesOnly.kml).toContain('<StyleMap id="icon-1807-FF5252">');
    expect(amenitiesOnly.kml).not.toContain("icon-1739-1A237E");
  });
});
