import { validateGameDefinition } from "@searchlight/shared";
import { afterEach, describe, expect, it } from "vitest";

import { assembleGameDefinition, type CreatorGeometryLayer } from "@/lib/creator/assemble";
import {
  buildSurroundingPlayArea,
  decodeImportedText,
  detectFolderSplitFields,
  importedFeaturesToPlayArea,
  importedFeaturesToStations,
  mergeImportedByName,
  parseCsvText,
  parseJsonImportText,
  parseKmlText,
  SPLIT_BY_STYLE_KEY,
  splitFeaturesByField,
  suggestSingularLayerName,
  unionPolygonsToPlayArea,
} from "@/lib/creator/importFile";

describe("parseCsvText", () => {
  it("parses quoted fields, UTF-8 BOM, lat/lng aliases, and tier while skipping invalid rows", () => {
    const csv = [
      '\uFEFF"Name",Latitude,Longitude,Tier',
      '"Zürich, HB",47.3779,8.5402,Center',
      "Stadelhofen,47.3667,8.5485,",
      "BadRow,not-a-number,8.54,",
      "OutOfRange,99.5,8.54,",
    ].join("\r\n");

    const result = parseCsvText(csv, "stops.csv");
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "folders") return;
    expect(result.format).toBe("csv");
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0].name).toBe("stops");
    expect(result.folders[0].counts).toEqual({
      points: 2,
      lines: 0,
      polygons: 0,
    });

    const { stations } = importedFeaturesToStations(result.folders[0].features);
    expect(stations).toHaveLength(2);
    expect(stations[0]).toMatchObject({
      name: "Zürich, HB",
      lat: 47.3779,
      lng: 8.5402,
      tier: "Center",
    });
    expect(stations[1]).toMatchObject({
      name: "Stadelhofen",
      tier: undefined,
    });
  });

  it("parses Google My Maps WKT CSV exports and semicolon-delimited CSVs", () => {
    const myMapsCsv = [
      "WKT,name,description",
      '"POINT (8.5402 47.3779)",Zürich HB,Main station',
      '"POINT Z (8.5485 47.3667 408)",Stadelhofen,',
    ].join("\n");
    const wktRes = parseCsvText(myMapsCsv, "mymaps-stations.csv");
    expect(wktRes.ok).toBe(true);
    if (!wktRes.ok || wktRes.kind !== "folders") return;
    const { stations: wktStations } = importedFeaturesToStations(wktRes.folders[0].features);
    expect(wktStations).toHaveLength(2);
    expect(wktStations[0]).toMatchObject({
      name: "Zürich HB",
      lng: 8.5402,
      lat: 47.3779,
    });
    expect(wktStations[1]).toMatchObject({
      name: "Stadelhofen",
      lng: 8.5485,
      lat: 47.3667,
    });

    const semiCsv = ["stop;lat;lon;tier", "Basel SBB;47.5474;7.5896;Hub"].join("\n");
    const semiRes = parseCsvText(semiCsv, "ch-stops.csv");
    expect(semiRes.ok).toBe(true);
    if (!semiRes.ok || semiRes.kind !== "folders") return;
    expect(importedFeaturesToStations(semiRes.folders[0].features).stations[0]).toMatchObject({
      name: "Basel SBB",
      lat: 47.5474,
      lng: 7.5896,
      tier: "Hub",
    });
  });

  it("rejects CSV missing coordinate columns or having unclosed quotes", () => {
    expect(parseCsvText("name,city\nA,B").ok).toBe(false);
    const unclosed = parseCsvText(
      'name,lat,lng\nFirst,47.37,8.54\n"Second,47.38,8.55\nThird,47.39,8.56',
    );
    expect(unclosed.ok).toBe(false);
    if (!unclosed.ok) {
      expect(unclosed.error).toContain("unclosed quote");
    }
  });
});

describe("importedFeaturesToStations", () => {
  it("takes zone radii from the station or a same-named zone circle as tier radii", () => {
    const point = (name: string, attributes?: Record<string, string>, tier?: string) => ({
      name,
      tier,
      family: "points" as const,
      geometry: { type: "Point" as const, coordinates: [6.13, 49.6] as [number, number] },
      ...(attributes && { attributes }),
    });
    const stations = [
      point("Gare", { radius_m: "1000" }, "Outer"),
      point("Ahn"),
      point("Elsewhere"),
      point("Kirchberg", { radius_m: "1000" }),
      point("Bonnevoie", { radius_m: "750" }),
    ];
    const circle = {
      name: "Ahn",
      family: "lines" as const,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [6.12, 49.6],
          [6.14, 49.6],
        ] as [number, number][],
      },
      attributes: { radius_m: "750.0" },
    };
    const result = importedFeaturesToStations(stations, [...stations, circle]);
    expect(result.stations.map((s) => s.tier)).toEqual([
      "Outer",
      "750 m",
      undefined,
      "1000 m",
      "750 m",
    ]);
    expect(result.tierRadiiMeters).toEqual({ Outer: 1000, "750 m": 750, "1000 m": 1000 });
    // The most used radius without a tier name of its own is the file's base radius.
    expect(result.baseTier).toBe("750 m");
  });
});

describe("parseJsonImportText", () => {
  it("rejects non-numeric JSON coordinates, bow-tie play areas, and formats invalid .game.json errors", () => {
    const badCoords = parseJsonImportText(
      JSON.stringify({
        type: "Feature",
        properties: { name: "Bogus" },
        geometry: { type: "Point", coordinates: [null, ""] },
      }),
    );
    expect(badCoords.ok).toBe(false);

    const bowtie = parseJsonImportText(
      JSON.stringify({
        type: "Feature",
        properties: { name: "Bowtie" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 1],
              [1, 0],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      }),
    );
    expect(bowtie.ok).toBe(true);
    if (bowtie.ok && bowtie.kind === "folders") {
      expect(importedFeaturesToPlayArea(bowtie.folders[0].features)).toBeNull();
    }

    const badGame = parseJsonImportText(
      JSON.stringify({
        name: "Broken",
        map: { center: "not-coords", playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: {
          radius: 400,
          unit: "meters",
          features: { type: "FeatureCollection", features: [] },
        },
      }),
    );
    expect(badGame.ok).toBe(false);
    if (!badGame.ok) {
      expect(badGame.error).not.toContain("[object Object]");
      expect(badGame.error).toContain("/map/center");
    }
  });
  it("normalizes FeatureCollections, MultiPoints, unclosed polygons, and GeometryCollections", () => {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Twin Stops" },
          geometry: {
            type: "MultiPoint",
            coordinates: [
              [8.54, 47.37],
              [8.55, 47.38],
            ],
          },
        },
        {
          type: "Feature",
          properties: { name: "District A" },
          geometry: {
            type: "Polygon",
            // Intentionally unclosed ring — parser should auto-close it
            coordinates: [
              [
                [8.5, 47.35],
                [8.55, 47.35],
                [8.55, 47.4],
                [8.5, 47.4],
              ],
            ],
          },
        },
        {
          type: "Feature",
          properties: { name: "District A" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [8.56, 47.35],
                [8.59, 47.35],
                [8.59, 47.4],
                [8.56, 47.4],
                [8.56, 47.35],
              ],
            ],
          },
        },
      ],
    });

    const res = parseJsonImportText(geojson, "map.geojson");
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== "folders") return;
    expect(res.folders[0].counts).toEqual({
      points: 2,
      lines: 0,
      polygons: 2,
    });

    const mergedPolys = mergeImportedByName(res.folders[0].features, "polygons");
    expect(mergedPolys).toHaveLength(1);
    expect(mergedPolys[0].name).toBe("District A");
    expect(mergedPolys[0].geometry.type).toBe("MultiPolygon");

    const paMerged = importedFeaturesToPlayArea(res.folders[0].features);
    expect(paMerged?.features).toHaveLength(1);
    expect(paMerged?.features[0].geometry.type).toBe("MultiPolygon");

    const paSeparate = importedFeaturesToPlayArea(res.folders[0].features, {
      union: false,
    });
    expect(paSeparate?.features).toHaveLength(2);
  });

  it("detects a full Searchlight .game.json and assembles layers cleanly", () => {
    const geoLayer: CreatorGeometryLayer = {
      id: "regions-1",
      name: "District",
      family: "polygons",
      // Intentionally include "tentacle" to verify assembleGameDefinition strips it on non-point layers
      enabledFor: ["matching", "measuring", "tentacle"],
      color: "#8b5cf6",
      selected: true,
      noOverlaps: true,
      sourceLabel: "OSM admin_level=9",
      vertexCount: 5,
      items: [
        {
          uid: "d-1",
          name: "Kreis 1",
          enabled: true,
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [8.53, 47.36],
                [8.55, 47.36],
                [8.55, 47.38],
                [8.53, 47.38],
                [8.53, 47.36],
              ],
            ],
          },
        },
      ],
    };

    const def = assembleGameDefinition({
      name: "Zurich With Regions",
      size: "small",
      unit: "meters",
      hidingRadius: 400,
      tierOverrides: {},
      radars: [250, 500],
      thermometer: true,
      playArea: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [8.5, 47.35],
                  [8.58, 47.35],
                  [8.58, 47.41],
                  [8.5, 47.41],
                  [8.5, 47.35],
                ],
              ],
            },
            properties: { name: "Zurich" },
          },
        ],
      },
      stations: [
        {
          uid: "s1",
          name: "HB",
          lat: 47.3779,
          lng: 8.5402,
          enabled: true,
        },
      ],
      layers: [geoLayer],
    });

    expect(validateGameDefinition(def).valid).toBe(true);
    expect(def.features).toHaveLength(1);
    expect(def.features?.[0].enabledFor).toEqual(["matching", "measuring"]);
    expect(def.features?.[0].noOverlaps).toBe(true);

    const parsed = parseJsonImportText(JSON.stringify(def), "zurich.game.json");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.kind).toBe("game-definition");
    if (parsed.kind === "game-definition") {
      expect(parsed.definition.name).toBe("Zurich With Regions");
      expect(parsed.definition.features).toHaveLength(1);
    }
  });
});

describe("parseKmlText", () => {
  const originalDomParser = globalThis.DOMParser;

  afterEach(() => {
    if (originalDomParser === undefined) {
      delete (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    } else {
      globalThis.DOMParser = originalDomParser;
    }
  });

  it("parses multi-folder KML with points, polygons with holes, and ExtendedData", () => {
    // Minimal XML DOM stub for Node Vitest environment matching DOMParser contract used by parseKmlText.
    type StubEl = {
      localName: string;
      children: StubEl[];
      textContent: string;
      getAttribute: (name: string) => string | null;
      getElementsByTagName: (tag: string) => StubEl[];
    };
    const mk = (
      localName: string,
      {
        attrs = {},
        text = "",
        children = [],
      }: {
        attrs?: Record<string, string>;
        text?: string;
        children?: StubEl[];
      } = {},
    ): StubEl => ({
      localName,
      children,
      textContent: text,
      getAttribute: (n) => attrs[n] ?? null,
      getElementsByTagName: () => [],
    });

    const fakeDoc = {
      documentElement: mk("kml", {
        children: [
          mk("Document", {
            children: [
              mk("Folder", {
                children: [
                  mk("name", { text: "Stations" }),
                  mk("Placemark", {
                    children: [
                      mk("name", { text: "Central" }),
                      mk("ExtendedData", {
                        children: [
                          mk("Data", {
                            attrs: { name: "tier" },
                            children: [
                              mk("value", {
                                text: "Inner",
                              }),
                            ],
                          }),
                        ],
                      }),
                      mk("Point", {
                        children: [
                          mk("coordinates", {
                            text: "8.5402,47.3779,0",
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              mk("Folder", {
                children: [
                  mk("name", { text: "Districts" }),
                  mk("Placemark", {
                    children: [
                      mk("name", { text: "Old Town" }),
                      mk("Polygon", {
                        children: [
                          mk("outerBoundaryIs", {
                            children: [
                              mk("LinearRing", {
                                children: [
                                  mk("coordinates", {
                                    text: "8.53,47.36 8.55,47.36 8.55,47.38 8.53,47.38 8.53,47.36",
                                  }),
                                ],
                              }),
                            ],
                          }),
                          mk("innerBoundaryIs", {
                            children: [
                              mk("LinearRing", {
                                children: [
                                  mk("coordinates", {
                                    text: "8.535,47.365 8.54,47.365 8.54,47.37 8.535,47.37",
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      getElementsByTagName: () => [],
    };

    (globalThis as unknown as { DOMParser: unknown }).DOMParser = class {
      parseFromString() {
        return fakeDoc;
      }
    };

    const res = parseKmlText("<kml/>");
    expect(res.ok).toBe(true);
    if (!res.ok || res.kind !== "folders") return;
    expect(res.format).toBe("kml");
    expect(res.folders.map((f) => f.name)).toEqual(["Stations", "Districts"]);
    expect(res.folders[0].features[0]).toMatchObject({
      name: "Central",
      tier: "Inner",
      family: "points",
    });
    expect(res.folders[1].features[0].geometry.type).toBe("Polygon");
    if (res.folders[1].features[0].geometry.type === "Polygon") {
      expect(res.folders[1].features[0].geometry.coordinates).toHaveLength(2);
    }
  });

  it("detects and splits grouped My Maps POI folders by ExtendedData type or styleUrl", () => {
    const groupedFeatures = [
      {
        name: "Diakonessenhuis",
        family: "points" as const,
        geometry: { type: "Point" as const, coordinates: [5.12, 52.08] as [number, number] },
        styleUrl: "#icon-1807-FF5252",
        attributes: { type: "hospitals" },
      },
      {
        name: "Utrecht University",
        family: "points" as const,
        geometry: { type: "Point" as const, coordinates: [5.16, 52.08] as [number, number] },
        styleUrl: "#icon-1726-FFD600",
        attributes: { type: "university" },
      },
      {
        name: "Schiphol",
        family: "points" as const,
        geometry: { type: "Point" as const, coordinates: [4.76, 52.31] as [number, number] },
        styleUrl: "#icon-1504-673AB7",
        attributes: { type: "airport" },
      },
    ];

    const opts = detectFolderSplitFields(groupedFeatures);
    expect(opts.map((o) => o.key)).toEqual(["type", SPLIT_BY_STYLE_KEY]);

    const byType = splitFeaturesByField(groupedFeatures, "type");
    expect(byType.map((g) => g.suggestedName)).toEqual(["Hospital", "University", "Airport"]);

    const byStyle = splitFeaturesByField(groupedFeatures, SPLIT_BY_STYLE_KEY);
    expect(byStyle).toHaveLength(3);
  });
});

describe("play area generation helpers", () => {
  it("unions touching polygons into a single outer boundary", () => {
    const merged = unionPolygonsToPlayArea(
      [
        {
          type: "Polygon",
          coordinates: [
            [
              [5.0, 52.0],
              [5.2, 52.0],
              [5.2, 52.2],
              [5.0, 52.2],
              [5.0, 52.0],
            ],
          ],
        },
        {
          type: "Polygon",
          coordinates: [
            [
              [5.2, 52.0],
              [5.4, 52.0],
              [5.4, 52.2],
              [5.2, 52.2],
              [5.2, 52.0],
            ],
          ],
        },
      ],
      "Provinces",
    );
    expect(merged?.features).toHaveLength(1);
    expect(merged?.features[0].geometry.type).toBe("Polygon");
    expect(merged?.features[0].properties?.name).toBe("Provinces");
  });

  it("generates a buffered play area surrounding stations and features", () => {
    const pa = buildSurroundingPlayArea(
      [
        [4.9, 52.37], // Amsterdam
        [4.48, 51.92], // Rotterdam
        [5.12, 52.09], // Utrecht
      ],
      2,
    );
    expect(pa?.features).toHaveLength(1);
    expect(pa?.features[0].geometry.type).toBe("Polygon");
  });
});

describe("decodeImportedText & suggestSingularLayerName", () => {
  it("strips CDATA wrappers and decodes single/double-encoded XML & HTML entities", () => {
    expect(decodeImportedText("Wageningen University &amp; Research")).toBe(
      "Wageningen University & Research",
    );
    expect(decodeImportedText("<![CDATA[DG&amp;J-ZHZ]]>")).toBe("DG&J-ZHZ");
    expect(decodeImportedText("Golf- &amp;amp; Country Club &#39;Liemeer&#x27;")).toBe(
      "Golf- & Country Club 'Liemeer'",
    );
  });

  it("singularizes common plural folder names without mangling non-plurals", () => {
    expect(suggestSingularLayerName("Provinces")).toBe("Province");
    expect(suggestSingularLayerName("Municipalities")).toBe("Municipality");
    expect(suggestSingularLayerName("Dutch Provinces")).toBe("Dutch Province");
    expect(suggestSingularLayerName("Theme Parks")).toBe("Theme Park");
    expect(suggestSingularLayerName("Campus")).toBe("Campus");
    expect(suggestSingularLayerName("Paris")).toBe("Paris");
  });

  it("preserves mixed geometry families when splitting by attribute and reads CSV attributes", () => {
    const csv = parseCsvText(
      "name,lat,lng,category\nCentral,52.37,4.9,Station\nZoo,52.36,4.91,Attraction",
      "places.csv",
    );
    expect(csv.ok).toBe(true);
    if (csv.ok && csv.kind === "folders") {
      expect(csv.folders[0].features[0].attributes).toEqual({
        category: "Station",
      });
    }

    const groups = splitFeaturesByField(
      [
        {
          name: "Park Pin",
          family: "points",
          geometry: { type: "Point", coordinates: [4.9, 52.37] },
          attributes: { type: "Park" },
        },
        {
          name: "Park Area",
          family: "polygons",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [4.9, 52.37],
                [4.91, 52.37],
                [4.91, 52.38],
                [4.9, 52.38],
                [4.9, 52.37],
              ],
            ],
          },
          attributes: { type: "Park" },
        },
      ],
      "type",
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.family).sort()).toEqual(["points", "polygons"]);
  });
});
