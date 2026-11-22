import type { PlayAreaFeatureCollection } from "@searchlight/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildBatchedPoiOverpassQuery,
  buildStationOverpassQuery,
  buildValidatedDrawnPlayArea,
  dedupePointItems,
  DEFAULT_OVERPASS_ENDPOINTS,
  expandBoundsKm,
  fetchPoiLayersFromOsm,
  fetchRawPoiQueryFromOsm,
  fetchStationsFromOsm,
  fetchStationsFromTransitous,
  matchesOsmPredicates,
  parseSimpleOsmFilter,
  rectanglePlayArea,
  runOverpassQuery,
  searchPlaces,
  TRANSITOUS_STOPS_URL,
  validateCustomOsmFilter,
} from "@/lib/creator/overpass";
import {
  getOsmFiltersForStationTypes,
  getTransitousModesForStationTypes,
} from "@/lib/creator/presets";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OSM tag filter parser & validator", () => {
  it("parses and evaluates compound Overpass tag filters", () => {
    const airport = parseSimpleOsmFilter('["aeroway"="aerodrome"]["iata"]')!;
    expect(airport).not.toBeNull();
    expect(
      matchesOsmPredicates({ aeroway: "aerodrome", iata: "ZRH", name: "Zurich" }, airport),
    ).toBe(true);
    expect(matchesOsmPredicates({ aeroway: "aerodrome", name: "Airfield" }, airport)).toBe(false);

    const rail = parseSimpleOsmFilter('["railway"="station"]["station"!="subway"][!"disused"]')!;
    expect(matchesOsmPredicates({ railway: "station", name: "HB" }, rail)).toBe(true);
    expect(
      matchesOsmPredicates({ railway: "station", station: "subway", name: "Metro" }, rail),
    ).toBe(false);
    expect(matchesOsmPredicates({ railway: "station", disused: "yes", name: "Old" }, rail)).toBe(
      false,
    );
  });

  it("matches Overpass regex filters as substrings unless anchored", () => {
    const sub = parseSimpleOsmFilter('["name"~"Central"]')!;
    expect(matchesOsmPredicates({ name: "Central Station" }, sub)).toBe(true);
    const anchored = parseSimpleOsmFilter('["name"~"^Central$"]')!;
    expect(matchesOsmPredicates({ name: "Central Station" }, anchored)).toBe(false);
    expect(matchesOsmPredicates({ name: "Central" }, anchored)).toBe(true);
  });

  it("rejects Overpass QL injection or malformed filters", () => {
    expect(validateCustomOsmFilter('["historic"="castle"]').ok).toBe(true);
    expect(validateCustomOsmFilter('["tourism"="museum"];out;').ok).toBe(false);
    expect(validateCustomOsmFilter("tourism=museum").ok).toBe(false);
    expect(validateCustomOsmFilter("").ok).toBe(false);
  });
});

describe("dedupePointItems", () => {
  it("merges same-name stations within dedupe distance and keeps distant ones", () => {
    const { items, mergedCount } = dedupePointItems(
      [
        {
          uid: "1",
          name: "Zürich HB",
          lng: 8.5402,
          lat: 47.3779,
          enabled: true,
        },
        {
          uid: "2",
          name: "Zurich HB",
          lng: 8.5408,
          lat: 47.3782, // ~55 m away, same normalized name
          enabled: true,
        },
        {
          uid: "3",
          name: "Zurich HB",
          lng: 8.56,
          lat: 47.39, // > 1.5 km away
          enabled: true,
        },
        {
          uid: "4",
          name: "Different Name Same Spot",
          lng: 8.54025,
          lat: 47.37792, // ~5 m away
          enabled: true,
        },
      ],
      { sameNameMeters: 250, nearCoordMeters: 25 },
    );

    expect(mergedCount).toBe(2);
    expect(items.map((i) => i.uid)).toEqual(["1", "3"]);
  });
});

describe("fetchStationsFromOsm & fetchPoiLayersFromOsm", () => {
  const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("filters outside stations, prefers nodes over ways, and merges duplicates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          elements: [
            // Outside play area
            {
              type: "node",
              id: 1,
              lon: 8.4,
              lat: 47.38,
              tags: { name: "Outside Stop" },
            },
            // Way + Node for same station inside play area
            {
              type: "way",
              id: 2,
              center: { lon: 8.5406, lat: 47.3781 },
              tags: { name: "Main Station" },
            },
            {
              type: "node",
              id: 3,
              lon: 8.5402,
              lat: 47.3779,
              tags: { name: "Main Station" },
            },
            {
              type: "node",
              id: 4,
              lon: 8.55,
              lat: 47.39,
              tags: { name: "North Stop" },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchStationsFromOsm({
      filters: ['["railway"="station"]'],
      playArea,
      dedupeMeters: 250,
    });

    expect(result.outsideCount).toBe(1);
    expect(result.mergedCount).toBe(1);
    expect(result.stations.map((s) => [s.name, s.osmId])).toEqual([
      ["Main Station", "node/3"],
      ["North Stop", "node/4"],
    ]);
  });

  it("fetches multiple POI layers in a single batched Overpass query and respects notableOnly", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 10,
              lon: 8.54,
              lat: 47.37,
              tags: {
                tourism: "museum",
                name: "Kunsthaus",
                wikidata: "Q123",
              },
            },
            {
              type: "node",
              id: 11,
              lon: 8.55,
              lat: 47.38,
              tags: {
                tourism: "museum",
                name: "Tiny Plaque Museum",
              },
            },
            {
              type: "way",
              id: 12,
              center: { lon: 8.53, lat: 47.36 },
              tags: {
                amenity: "hospital",
                name: "University Hospital",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await fetchPoiLayersFromOsm({
      layers: [
        {
          id: "museum",
          name: "Museum",
          osmFilter: '["tourism"="museum"]',
          notableOnly: true,
        },
        {
          id: "hospital",
          name: "Hospital",
          osmFilter: '["amenity"="hospital"]',
          notableOnly: false,
        },
      ],
      playArea,
      bufferKm: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.byLayerId.museum.map((m) => m.name)).toEqual(["Kunsthaus"]);
    expect(result.byLayerId.hospital.map((h) => h.name)).toEqual(["University Hospital"]);
  });

  it("clips Overpass POIs to the play-area polygon + margin rather than its bounding box", async () => {
    const triangleArea: PlayAreaFeatureCollection = {
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
    const mockElements = {
      elements: [
        {
          type: "node",
          id: 21,
          lon: 8.52,
          lat: 47.36,
          tags: { tourism: "museum", name: "Inside Museum" },
        },
        {
          // Inside bbox, ~1.5 km outside the triangle hypotenuse
          type: "node",
          id: 22,
          lon: 8.56,
          lat: 47.39,
          tags: { tourism: "museum", name: "Near Border Museum" },
        },
        {
          // Inside bbox far corner (~4 km outside hypotenuse)
          type: "node",
          id: 23,
          lon: 8.595,
          lat: 47.415,
          tags: { tourism: "museum", name: "Far Corner Museum" },
        },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(mockElements), { status: 200 }),
    );

    const zeroMargin = await fetchPoiLayersFromOsm({
      layers: [{ id: "museum", name: "Museum", osmFilter: '["tourism"="museum"]' }],
      playArea: triangleArea,
      bufferKm: 0,
    });
    expect(zeroMargin.byLayerId.museum.map((m) => m.name)).toEqual(["Inside Museum"]);

    const twoKmMargin = await fetchPoiLayersFromOsm({
      layers: [{ id: "museum", name: "Museum", osmFilter: '["tourism"="museum"]' }],
      playArea: triangleArea,
      bufferKm: 2,
    });
    expect(twoKmMargin.byLayerId.museum.map((m) => m.name)).toEqual([
      "Inside Museum",
      "Near Border Museum",
    ]);
  });

  it("expands bounds symmetrically and clamps to world bounds", () => {
    const expanded = expandBoundsKm([8.5, 47.35, 8.6, 47.42], 2);
    expect(expanded[0]).toBeLessThan(8.5);
    expect(expanded[1]).toBeLessThan(47.35);
    expect(expanded[2]).toBeGreaterThan(8.6);
    expect(expanded[3]).toBeGreaterThan(47.42);
  });

  it("deduplicates non-Latin station names and high-latitude stations accurately", () => {
    const tokyo = dedupePointItems(
      [
        { uid: "1", name: "東京", lat: 35.6812, lng: 139.7671, enabled: true },
        { uid: "2", name: "東京", lat: 35.6822, lng: 139.7671, enabled: true },
      ],
      { sameNameMeters: 250 },
    );
    expect(tokyo.items).toHaveLength(1);
    expect(tokyo.mergedCount).toBe(1);

    // At 65°N, 0.035° longitude is ~1,645 m — must merge under 2,000 m.
    const nordic = dedupePointItems(
      [
        { uid: "1", name: "Town", lat: 65.0, lng: 25.0, enabled: true },
        { uid: "2", name: "Town", lat: 65.0, lng: 25.035, enabled: true },
      ],
      { sameNameMeters: 2000 },
    );
    expect(nordic.items).toHaveLength(1);
  });

  it("fails over immediately across Overpass mirrors in order on 504/429", async () => {
    const calledUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calledUrls.push(url);
      if (url === DEFAULT_OVERPASS_ENDPOINTS[0]) {
        return new Response("", { status: 504 });
      }
      if (url === DEFAULT_OVERPASS_ENDPOINTS[1]) {
        return new Response("", { status: 429 });
      }
      return new Response(
        JSON.stringify({ elements: [{ type: "node", id: 1, lat: 47.37, lon: 8.54 }] }),
        { status: 200 },
      );
    });

    const res = await runOverpassQuery("[out:json];node(1);out;");
    expect(calledUrls).toEqual([...DEFAULT_OVERPASS_ENDPOINTS]);
    expect(res.endpoint).toBe(DEFAULT_OVERPASS_ENDPOINTS[2]);
    expect(res.elements).toHaveLength(1);
  });

  it("supports custom rawQueryOverride for stations and raw Overpass QL POI fetches", async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 50,
              lon: 8.54,
              lat: 47.37,
              tags: { name: "Custom Spot" },
            },
            {
              type: "way",
              id: 51,
              center: { lon: 8.5401, lat: 47.3701 },
              tags: { name: "Custom Spot" },
            },
            {
              type: "node",
              id: 52,
              lon: 8.4, // outside playArea
              lat: 47.37,
              tags: { name: "Outside Spot" },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const customQl = "[out:json];node[custom=yes](47.35,8.5,47.42,8.6);out;";
    const stationRes = await fetchStationsFromOsm({
      filters: [],
      playArea,
      rawQueryOverride: customQl,
    });
    expect(decodeURIComponent(bodies[0] ?? "")).toContain(customQl);
    expect(stationRes.stations.map((s) => s.name)).toEqual(["Custom Spot"]);
    expect(stationRes.outsideCount).toBe(1);
    expect(stationRes.mergedCount).toBe(1);

    const poiRes = await fetchRawPoiQueryFromOsm({ query: customQl });
    expect(poiRes.items.map((i) => i.name)).toEqual(["Custom Spot", "Outside Spot"]);

    const notableQl = buildBatchedPoiOverpassQuery(
      [
        {
          id: "park",
          name: "Park",
          osmFilter: '["leisure"="park"]',
          notableOnly: true,
        },
      ],
      [8.5, 47.35, 8.6, 47.42],
    );
    expect(notableQl).toContain('["wikidata"]');
    expect(notableQl).toContain('["wikipedia"]');
  });
});

describe("searchPlaces", () => {
  it("parses Nominatim polygon_geojson and boundingbox fallback results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            place_id: 1,
            osm_type: "relation",
            osm_id: 100,
            name: "Zurich",
            display_name: "Zurich, Switzerland",
            type: "administrative",
            geojson: {
              type: "Polygon",
              coordinates: [
                [
                  [8.45, 47.32],
                  [8.62, 47.32],
                  [8.62, 47.43],
                  [8.45, 47.43],
                  [8.45, 47.32],
                ],
              ],
            },
          },
          {
            place_id: 2,
            name: "Small Village",
            display_name: "Small Village",
            boundingbox: ["47.3", "47.32", "8.4", "8.42"],
          },
        ]),
        { status: 200 },
      ),
    );

    const results = await searchPlaces("Zurich");
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("Zurich");
    expect(results[0].osmRelationId).toBe(100);
    expect(results[0].playArea.features[0].geometry.type).toBe("Polygon");
    expect(results[1].name).toBe("Small Village");
    expect(results[1].osmRelationId).toBeUndefined();
    expect(results[1].bounds).toEqual([8.4, 47.3, 8.42, 47.32]);
  });
});

describe("buildValidatedDrawnPlayArea", () => {
  it("accepts a simple polygon and rejects collinear or self-intersecting rings", () => {
    const good = buildValidatedDrawnPlayArea([
      [47.35, 8.5],
      [47.35, 8.6],
      [47.42, 8.6],
      [47.42, 8.5],
    ]);
    expect(good.ok).toBe(true);

    const collinear = buildValidatedDrawnPlayArea([
      [47.35, 8.5],
      [47.36, 8.51],
      [47.37, 8.52],
    ]);
    expect(collinear).toMatchObject({
      ok: false,
      error: expect.stringContaining("straight line"),
    });

    // Bow-tie self-intersection
    const bowtie = buildValidatedDrawnPlayArea([
      [47.35, 8.5],
      [47.42, 8.6],
      [47.35, 8.6],
      [47.42, 8.5],
    ]);
    expect(bowtie).toMatchObject({
      ok: false,
      error: expect.stringContaining("cross each other"),
    });
  });
});

describe("Transitous GTFS station fetching & station types", () => {
  const playArea = rectanglePlayArea([8.5, 47.35, 8.6, 47.42], "Zurich");

  it("maps multi-selected station types to Transitous modes and fast node-only Overpass queries", () => {
    const modes = getTransitousModesForStationTypes(["rail", "suburban", "metro", "ferry"]);
    expect(modes).toEqual([
      "HIGHSPEED_RAIL",
      "LONG_DISTANCE",
      "NIGHT_RAIL",
      "REGIONAL_RAIL",
      "SUBURBAN",
      "SUBWAY",
      "FERRY",
    ]);

    const filters = getOsmFiltersForStationTypes(["metro", "ferry"]);
    const ql = buildStationOverpassQuery(filters, [8.5, 47.35, 8.6, 47.42]);
    expect(ql).toContain("[timeout:25]");
    expect(ql).toContain('node["railway"="station"]["station"="subway"]');
    expect(ql).toContain('node["amenity"="ferry_terminal"]');
    expect(ql).toContain("out qt;");
    expect(ql).not.toContain("nwr");
  });

  it("fetches grouped mode-filtered stops from Transitous, clips to play area, and prefers mixed-case high-importance names", async () => {
    const calledUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calledUrls.push(String(input));
      return new Response(
        JSON.stringify([
          // Outside play area
          {
            name: "Outside Station",
            stopId: "ext-1",
            lat: 47.38,
            lon: 8.4,
            importance: 0.05,
            modes: ["REGIONAL_RAIL"],
          },
          // Cross-feed duplicate with ALL-CAPS name first
          {
            name: "ZUERICH HB",
            stopId: "it-8503000",
            lat: 47.378,
            lon: 8.54,
            importance: 0.0734,
            modes: ["LONG_DISTANCE"],
          },
          // Canonical mixed-case name at same hub
          {
            name: "Zürich HB",
            stopId: "ch-8503000",
            lat: 47.37805,
            lon: 8.5401,
            importance: 0.0734,
            modes: ["REGIONAL_RAIL", "SUBURBAN"],
          },
          {
            name: "Zürich Stadelhofen",
            stopId: "ch-8503003",
            lat: 47.3667,
            lon: 8.5485,
            importance: 0.02,
            modes: ["SUBURBAN"],
          },
        ]),
        { status: 200 },
      );
    });

    const result = await fetchStationsFromTransitous({
      modes: ["REGIONAL_RAIL", "SUBURBAN"],
      playArea,
      dedupeMeters: 250,
      preferEnglishName: true,
    });

    expect(calledUrls).toHaveLength(1);
    const parsed = new URL(calledUrls[0]);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(TRANSITOUS_STOPS_URL);
    expect(parsed.searchParams.get("grouped")).toBe("true");
    expect(parsed.searchParams.get("modes")).toBe("REGIONAL_RAIL,SUBURBAN");
    expect(parsed.searchParams.get("language")).toBe("en");
    expect(parsed.searchParams.get("min")).toBe("47.35,8.5");
    expect(parsed.searchParams.get("max")).toBe("47.42,8.6");

    expect(result.outsideCount).toBe(1);
    expect(result.mergedCount).toBe(1);
    expect(result.stations.map((s) => [s.name, s.osmId])).toEqual([
      ["Zürich HB", "transitous:ch-8503000"],
      ["Zürich Stadelhofen", "transitous:ch-8503003"],
    ]);
  });

  it("returns an actionable error on Transitous 422 too many stops", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "too many stops" }), { status: 422 }),
    );

    await expect(
      fetchStationsFromTransitous({
        modes: ["BUS"],
        playArea,
      }),
    ).rejects.toThrow(/Too many stops.*OpenStreetMap/i);
  });
});
