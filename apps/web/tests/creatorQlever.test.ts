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

    const negated = osmFilterToSparqlPatterns('["railway"="station"]["station"!="subway"]');
    expect(negated).toContain(
      'FILTER NOT EXISTS { ?s <https://www.openstreetmap.org/wiki/Key:station> "subway" . }',
    );
  });
});

describe("QLever covering regions & layer fetchers", () => {
  const zurichPlayArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("resolves admin_level=4 regions plus uncovered countries (e.g. Liechtenstein) and caches by bbox", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: {
              bindings: [
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/51701" },
                  lvl: { type: "literal", value: "2" },
                },
                {
                  r: { type: "uri", value: "https://www.openstreetmap.org/relation/1155955" },
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
                // Switzerland (51701) covers Canton Zurich (1690227); Liechtenstein (1155955) has no adm4.
                { c: { type: "uri", value: "https://www.openstreetmap.org/relation/51701" } },
              ],
            },
          }),
          { status: 200 },
        ),
      );

    const regions = await resolveQleverCoveringRegions([8.5, 47.35, 9.6, 47.42]);
    expect(regions).toEqual([
      "https://www.openstreetmap.org/relation/1690227",
      "https://www.openstreetmap.org/relation/1155955",
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call for the same bbox hits the in-memory cache (0 extra requests).
    const cached = await resolveQleverCoveringRegions([8.5, 47.35, 9.6, 47.42]);
    expect(cached).toEqual(regions);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
