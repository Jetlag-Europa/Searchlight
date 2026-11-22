import type { PlayAreaFeatureCollection } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rectanglePlayArea } from "@/lib/creator/overpass";
import {
  buildQleverAdminRegionsQuery,
  buildQleverPoiQuery,
  clearQleverRegionCache,
  fetchAdminRegionsFromQlever,
  fetchLineLayerFromQlever,
  fetchPoiLayerFromQlever,
  osmFilterToSparqlPatterns,
  parseWktGeometry,
  parseWktPoint,
  QLEVER_OSM_ENDPOINT,
  resolveQleverCoveringRegions,
} from "@/lib/creator/qlever";

beforeEach(() => {
  clearQleverRegionCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("QLever WKT parser & OSM filter converter", () => {
  it("parses POINT, LINESTRING, MULTILINESTRING, POLYGON (with holes), and MULTIPOLYGON", () => {
    expect(parseWktPoint("POINT(8.54021234 47.37791234)")).toEqual([8.540212, 47.377912]);
    expect(parseWktPoint("POINT(200 47)")).toBeNull();

    const line = parseWktGeometry("LINESTRING(8.5 47.3, 8.6 47.4)");
    expect(line).toEqual({
      type: "LineString",
      coordinates: [
        [8.5, 47.3],
        [8.6, 47.4],
      ],
    });

    const multiLine = parseWktGeometry(
      "MULTILINESTRING((8.5 47.3, 8.6 47.4), (8.7 47.5, 8.8 47.6))",
    );
    expect(multiLine?.type).toBe("MultiLineString");

    const poly = parseWktGeometry(
      "POLYGON((8.5 47.3, 8.6 47.3, 8.6 47.4, 8.5 47.4), (8.52 47.32, 8.54 47.32, 8.54 47.34, 8.52 47.34, 8.52 47.32))",
    );
    expect(poly?.type).toBe("Polygon");
    if (poly?.type === "Polygon") {
      // First ring was auto-closed.
      expect(poly.coordinates).toHaveLength(2);
      expect(poly.coordinates[0][0]).toEqual(poly.coordinates[0][poly.coordinates[0].length - 1]);
    }

    const multiPoly = parseWktGeometry(
      "MULTIPOLYGON(((8.5 47.3, 8.6 47.3, 8.6 47.4, 8.5 47.3)), ((8.7 47.3, 8.8 47.3, 8.8 47.4, 8.7 47.3)))",
    );
    expect(multiPoly?.type).toBe("MultiPolygon");
  });

  it("converts Overpass bracket filters into QLever SPARQL triple patterns", () => {
    const airport = osmFilterToSparqlPatterns('["aeroway"="aerodrome"]["iata"]');
    expect(airport).toContain('<https://www.openstreetmap.org/wiki/Key:aeroway> "aerodrome"');
    expect(airport).toContain("<https://www.openstreetmap.org/wiki/Key:iata> ?_ex1");

    const border = osmFilterToSparqlPatterns('["boundary"="administrative"]["admin_level"="2"]');
    expect(border).toContain("<https://www.openstreetmap.org/wiki/Key:admin_level> 2 .");

    const notAdmin8 = osmFilterToSparqlPatterns(
      '["boundary"="administrative"]["admin_level"!="8"]',
    );
    expect(notAdmin8).toContain(
      "FILTER NOT EXISTS { ?s <https://www.openstreetmap.org/wiki/Key:admin_level> 8 . }",
    );

    const negated = osmFilterToSparqlPatterns('["railway"="station"]["station"!="subway"]');
    expect(negated).toContain(
      'FILTER NOT EXISTS { ?s <https://www.openstreetmap.org/wiki/Key:station> "subway" . }',
    );

    const negRegex = osmFilterToSparqlPatterns('["railway"="station"]["station"!~"subway|tram"]');
    expect(negRegex).toContain(
      'FILTER NOT EXISTS { ?s <https://www.openstreetmap.org/wiki/Key:station> ?_rx1 . FILTER(REGEX(STR(?_rx1), "subway|tram")) }',
    );

    // Forward slashes must not be corrupted by JS RegExp.prototype.source escaping.
    const slashRegex = osmFilterToSparqlPatterns('["name"~"a/b"]');
    expect(slashRegex).toContain('REGEX(STR(?_rx0), "a/b")');
  });
});

describe("QLever covering regions & layer fetchers", () => {
  const zurichPlayArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("resolves admin_level=4 regions plus uncovered countries (e.g. Ireland, Portugal, Liechtenstein) and caches by exact WKT", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  // Switzerland (covered by Canton Zurich adm4)
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/51701" },
                  lvl: { type: "literal", value: "2" },
                },
                {
                  // Ireland (70,000+ km², no adm4) — must be retained!
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/62273" },
                  lvl: { type: "literal", value: "2" },
                },
                {
                  // Portugal (only ~2% adm4 area) — must be retained!
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/295480" },
                  lvl: { type: "literal", value: "2" },
                },
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/1690227" },
                  lvl: { type: "literal", value: "4" },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  c: { type: "uri", value: "https://www.openstreetmap.org/relation/51701" },
                  adm4Area: { type: "literal", value: "41178000000" },
                  cArea: { type: "literal", value: "41178000000" },
                  inBoxCnt: { type: "literal", value: "1" },
                },
                {
                  c: { type: "uri", value: "https://www.openstreetmap.org/relation/62273" },
                  cArea: { type: "literal", value: "108260000000" },
                  inBoxCnt: { type: "literal", value: "0" },
                },
                {
                  c: { type: "uri", value: "https://www.openstreetmap.org/relation/295480" },
                  adm4Area: { type: "literal", value: "3123000000" },
                  cArea: { type: "literal", value: "159221000000" },
                  inBoxCnt: { type: "literal", value: "1" },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );

    const regions = await resolveQleverCoveringRegions([8.5, 47.35, 9.6, 47.42]);
    expect(regions).toEqual([
      "https://www.openstreetmap.org/relation/1690227",
      "https://www.openstreetmap.org/relation/62273",
      "https://www.openstreetmap.org/relation/295480",
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call for the exact same bbox hits the in-memory cache (0 extra requests).
    const cached = await resolveQleverCoveringRegions([8.5, 47.35, 9.6, 47.42]);
    expect(cached).toEqual(regions);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back from direct relation shortcut when QLever lacks that relation, and falls back to ref on unnamed rail ways", async () => {
    const queries: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? "")).get("query") ?? "";
      queries.push(body);
      if (queries.length === 1) {
        // Direct relation query returns 0 rows (relation missing in snapshot)
        return new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 });
      }
      if (queries.length === 2) {
        // Fallback covering-region discovery returns Canton Zurich
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/1690227" },
                  lvl: { type: "literal", value: "4" },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      // Fallback line query returns an unnamed way with ref="751"
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/way/500" },
                ref: { type: "literal", value: "751" },
                wkt: { type: "literal", value: "LINESTRING(8.52 47.37, 8.56 47.39)" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const res = await fetchLineLayerFromQlever({
      layerName: "Rail Line",
      osmFilter: '["railway"="rail"]',
      playArea: zurichPlayArea,
      playAreaOsmRelationId: 99999999,
      bufferKm: 0,
      toleranceMeters: 0,
    });
    expect(queries).toHaveLength(3);
    expect(res.items.map((i) => i.name)).toEqual(["751"]);
  });

  it("uses the play-area OSM relation directly when margin is 0, and clips POIs to the polygon (not bbox)", async () => {
    // Diagonal triangle covering lower-left half of [8.5..8.6, 47.35..47.42]
    const trianglePlayArea: PlayAreaFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Triangle" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [8.5, 47.35],
                [8.6, 47.35],
                [8.5, 47.42],
                [8.5, 47.35],
              ],
            ],
          },
        },
      ],
    };

    const queries: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? "")).get("query") ?? "";
      queries.push(body);
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                // Strictly inside triangle
                s: { type: "uri", value: "https://www.openstreetmap.org/node/1" },
                name: { type: "literal", value: "Inside Museum" },
                c: { type: "literal", value: "POINT(8.52 47.36)" },
              },
              {
                // Inside bbox upper-right corner, OUTSIDE triangle
                s: { type: "uri", value: "https://www.openstreetmap.org/node/2" },
                name: { type: "literal", value: "Corner Outside Museum" },
                c: { type: "literal", value: "POINT(8.59 47.41)" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const res = await fetchPoiLayerFromQlever({
      id: "museum",
      name: "Museum",
      osmFilter: '["tourism"="museum"]',
      playArea: trianglePlayArea,
      playAreaOsmRelationId: 51701,
      bufferKm: 0,
    });

    // Only 1 query fired (skipped covering-region discovery) using relation/51701 directly.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("<https://www.openstreetmap.org/relation/51701>");
    expect(res.items.map((i) => i.name)).toEqual(["Inside Museum"]);
  });

  it("drops border-touching admin regions, keeps interior regions, and crops overhanging ones", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                // Completely inside playArea [8.5..8.6, 47.35..47.42]
                s: { type: "uri", value: "https://www.openstreetmap.org/relation/200" },
                name: { type: "literal", value: "Inner District" },
                wkt: {
                  type: "literal",
                  value: "POLYGON((8.52 47.36, 8.56 47.36, 8.56 47.40, 8.52 47.40, 8.52 47.36))",
                },
              },
              {
                // Only touches the eastern border x=8.6 (neighbor outside playArea)
                s: { type: "uri", value: "https://www.openstreetmap.org/relation/201" },
                name: { type: "literal", value: "Border Neighbor" },
                wkt: {
                  type: "literal",
                  value: "POLYGON((8.60 47.36, 8.70 47.36, 8.70 47.40, 8.60 47.40, 8.60 47.36))",
                },
              },
              {
                // Overhangs past eastern border x=8.6 out to x=8.7
                s: { type: "uri", value: "https://www.openstreetmap.org/relation/202" },
                name: { type: "literal", value: "Overhanging District" },
                wkt: {
                  type: "literal",
                  value: "POLYGON((8.57 47.36, 8.70 47.36, 8.70 47.40, 8.57 47.40, 8.57 47.36))",
                },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const res = await fetchAdminRegionsFromQlever({
      adminLevel: 8,
      playArea: zurichPlayArea,
      bufferKm: 0,
      toleranceMeters: 0,
    });

    expect(res.items.map((i) => i.name)).toEqual(["Inner District", "Overhanging District"]);
    expect(res.skippedOutside).toBe(1);
    const overhang = res.items.find((i) => i.name === "Overhanging District")!;
    expect(overhang.geometry.type).toBe("Polygon");
    if (overhang.geometry.type === "Polygon") {
      const maxLng = Math.max(...overhang.geometry.coordinates[0].map((p) => p[0]));
      expect(maxLng).toBeLessThanOrEqual(8.600001);
    }
  });

  it("crops crossing line ways down to the play area and drops lines outside the polygon", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                // Crosses from outside west (8.4) through play area to outside east (8.7)
                s: { type: "uri", value: "https://www.openstreetmap.org/way/10" },
                name: { type: "literal", value: "Cross Rail" },
                wkt: { type: "literal", value: "LINESTRING(8.4 47.38, 8.7 47.38)" },
              },
              {
                // Wiggles ±25 m (~0.0003° lng) along the eastern border x=8.6 — must stay 1 unbroken piece at bufferKm=0
                s: { type: "uri", value: "https://www.openstreetmap.org/way/12" },
                name: { type: "literal", value: "Border River" },
                wkt: {
                  type: "literal",
                  value:
                    "LINESTRING(8.5997 47.36, 8.6003 47.37, 8.5997 47.38, 8.6003 47.39, 8.5997 47.40)",
                },
              },
              {
                // Completely outside
                s: { type: "uri", value: "https://www.openstreetmap.org/way/11" },
                name: { type: "literal", value: "Outside Rail" },
                wkt: { type: "literal", value: "LINESTRING(8.65 47.38, 8.75 47.38)" },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const res = await fetchLineLayerFromQlever({
      layerName: "Rail",
      osmFilter: '["railway"="rail"]',
      playArea: zurichPlayArea,
      playAreaOsmRelationId: 1682248,
      bufferKm: 0,
      toleranceMeters: 0,
    });

    expect(res.items.map((i) => i.name)).toEqual(["Border River", "Cross Rail"]);
    const borderRiver = res.items[0].geometry;
    expect(borderRiver.type).toBe("LineString");
    if (borderRiver.type === "LineString") {
      expect(borderRiver.coordinates).toHaveLength(5);
    }
    const geom = res.items[1].geometry;
    expect(geom.type).toBe("LineString");
    if (geom.type === "LineString") {
      const lngs = geom.coordinates.map((p) => p[0]);
      // Cropped within the 100 m border tolerance (~0.0014° lng at 47.38°N)
      expect(Math.min(...lngs)).toBeGreaterThan(8.497);
      expect(Math.max(...lngs)).toBeLessThan(8.603);
    }
  });

  it("fetches POIs via QLever with notableOnly, English names, and deduplication", async () => {
    const queries: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body ?? "")).get("query") ?? "";
      queries.push(body);
      if (queries.length === 1) {
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/1690227" },
                  lvl: { type: "literal", value: "4" },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/node/10" },
                name: { type: "literal", value: "Kunsthaus Zürich" },
                name_en: { type: "literal", value: "Kunsthaus Zurich" },
                c: { type: "literal", value: "POINT(8.5483 47.3702)" },
              },
              {
                // Duplicate within 20 m
                s: { type: "uri", value: "https://www.openstreetmap.org/way/11" },
                name: { type: "literal", value: "Kunsthaus Zürich" },
                c: { type: "literal", value: "POINT(8.54835 47.37022)" },
              },
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/node/12" },
                name: { type: "literal", value: "Landesmuseum" },
                c: { type: "literal", value: "POINT(8.5405 47.3791)" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const result = await fetchPoiLayerFromQlever({
      id: "museum",
      name: "Museum",
      osmFilter: '["tourism"="museum"]',
      notableOnly: true,
      playArea: zurichPlayArea,
      bufferKm: 2,
      preferEnglishName: true,
    });

    expect(result.endpoint).toBe(QLEVER_OSM_ENDPOINT);
    expect(result.items.map((i) => i.name)).toEqual(["Kunsthaus Zurich", "Landesmuseum"]);
    expect(queries[1]).toContain("osm2rdf.cs.uni-freiburg.de/rdf/key#wikidata");
    expect(queries[1]).toContain("FILTER(BOUND(?_wd) || BOUND(?_wp))");
    expect(queries[1]).toContain("Key:name:en");
  });

  it("fetches and simplifies admin regions via QLever and skips non-intersecting polygons", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/relation/100" },
                name: { type: "literal", value: "Zürich" },
                wkt: {
                  type: "literal",
                  value: "POLYGON((8.51 47.36, 8.58 47.36, 8.58 47.41, 8.51 47.41, 8.51 47.36))",
                },
              },
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/relation/101" },
                name: { type: "literal", value: "Far Away" },
                wkt: {
                  type: "literal",
                  value: "POLYGON((9.5 47.36, 9.6 47.36, 9.6 47.41, 9.5 47.41, 9.5 47.36))",
                },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const ql = buildQleverAdminRegionsQuery({
      adminLevel: 8,
      bounds: [8.5, 47.35, 8.6, 47.42],
    });
    expect(ql).toContain("osmkey:admin_level 8");

    const res = await fetchAdminRegionsFromQlever({
      adminLevel: 8,
      playArea: zurichPlayArea,
      toleranceMeters: 15,
    });

    expect(res.items.map((i) => i.name)).toEqual(["Zürich"]);
    expect(res.skippedOutside).toBe(1);
    expect(res.vertexCount).toBeGreaterThanOrEqual(4);
  });

  it("fetches and groups line segments via QLever", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/1690227" },
                  lvl: { type: "literal", value: "4" },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          results: {
            bindings: [
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/way/1" },
                name: { type: "literal", value: "Limmat" },
                wkt: { type: "literal", value: "LINESTRING(8.54 47.37, 8.53 47.38)" },
              },
              {
                s: { type: "uri", value: "https://www.openstreetmap.org/way/2" },
                name: { type: "literal", value: "Limmat" },
                wkt: { type: "literal", value: "LINESTRING(8.53 47.38, 8.51 47.39)" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    });

    const res = await fetchLineLayerFromQlever({
      layerName: "River",
      osmFilter: '["waterway"="river"]',
      playArea: zurichPlayArea,
      bufferKm: 1,
      toleranceMeters: 10,
      groupByName: true,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0].name).toBe("Limmat");
    expect(res.items[0].geometry.type).toBe("MultiLineString");
    expect(
      buildQleverPoiQuery({
        osmFilter: '["tourism"="museum"]',
        bounds: [8.5, 47.35, 8.6, 47.42],
        regionIris: [],
      }),
    ).toContain("osmkey:name ?name");
  });
});
