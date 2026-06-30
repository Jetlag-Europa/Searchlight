// ── Game registry — single source of truth for bundled games ──────────────────
//
// One GameManifest fully describes a bundled game. Everything else is DERIVED
// from this array:
//   - apps/api/prisma/seed.ts        → DB rows (full-field upsert)
//   - apps/api/src/lib/game-gates.ts → per-game visibility gates
//   - apps/web/src/lib/games.ts      → client asset wiring (stations / boundary
//                                       / POI folder maps)
//
// To add a standard game, add ONE manifest here, drop the asset files in
// apps/web/public/, and re-seed. See docs/ADDING_GAMES.md.

/** The 13 rulebook points-of-interest categories that questions can use. */
export const POI_CATEGORIES = [
  "airport",
  "zoo",
  "aquarium",
  "golf_course",
  "museum",
  "cinema",
  "hospital",
  "library",
  "consulate",
  "park",
  "theme_park",
  "mountain",
  "rail",
] as const;
export type POICategory = (typeof POI_CATEGORIES)[number];

/** OpenStreetMap-style location feature stored in Game.mapLocationJson. */
export interface GameOSMFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    osm_type: string;
    osm_id: number;
    extent: [number, number, number, number];
    country: string;
    osm_key: string;
    countrycode: string;
    osm_value: string;
    name: string;
    type: string;
  };
}

export interface GameVisibilityGateManifest {
  /** Real Discord guild to check the user's roles in. */
  requireGuildId: string;
  /** Role the user must hold in that guild to see the game. */
  requireRoleId: string;
}

export interface GameManifest {
  /** Unique sentinel, e.g. "__bundled-paris-2026__". */
  sentinel: string;
  /** Display name, e.g. "Paris 2026". */
  name: string;
  /** Discord server id (or "home-games" for the virtual server). */
  serverId: string;
  size: "small" | "medium" | "large";

  hidingRadius: number;
  hidingRadiusUnits: "miles" | "kilometers" | "meters";
  /** Per-tier radius overrides keyed by the KML <Data name="tier"> value. */
  tierRadiusOverrides?: Record<string, number>;

  /** mapLocationJson — the OSM feature seeded into the DB. */
  osm: GameOSMFeature;

  /**
   * DB `kmlPath` column. For POI-split games this is the POI file; for combined
   * games it is the hiding-zones file; for station-only games it is the
   * stations file.
   */
  kmlPath: string;
  /** Separate stations KML (GAME_HIDING_ZONE_KML_PATHS). Falls back to kmlPath. */
  stationsKml?: string;
  /** Custom map boundary polygon (GAME_MAP_BOUNDARY_GEOJSON_PATHS). */
  boundaryGeoJson?: string;
  /** Polygon-based hiding zone (DB hidingZoneGeoJsonPath). */
  hidingZoneGeoJson?: string;

  /**
   * POI KML <Folder> name → category. By convention folders are named with the
   * canonical category (see POI_CATEGORIES), so this is usually an identity map;
   * supply it only when the source KML uses non-canonical folder names. Folders
   * mapping to "administrative" / "water" are skipped at parse time.
   */
  poiFolders?: Record<string, string>;

  /** Per-game visibility gate (temporary, until invite links land). */
  gate?: GameVisibilityGateManifest;

  /**
   * Question types to hide from the picker for this game — e.g. a POI question
   * whose only real-world feature sits outside the play area and would
   * otherwise be matched via Overpass. Already-added questions are unaffected.
   *
   * Each entry is either a bare type (`"airport"`, hidden from every picker) or
   * a picker-scoped `"<kind>:<type>"` (`"matching:airport"`, hidden only from
   * the matching picker). Valid kinds: `matching`, `measuring`, `tentacle`.
   */
  hiddenQuestionTypes?: string[];
}

// ── Reusable OSM features ─────────────────────────────────────────────────────

const ROTTERDAM_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [51.9244, 4.4777] },
  properties: {
    osm_type: "R", osm_id: 324431, extent: [52.0045, 3.9408, 51.7828, 4.6473],
    country: "Netherlands", osm_key: "place", countrycode: "NL",
    osm_value: "city", name: "Rotterdam", type: "city",
  },
};

const SOUTH_LIMBURG_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [50.8474, 5.8666] },
  properties: {
    osm_type: "R", osm_id: 47772, extent: [50.9434, 5.6389, 50.7504, 6.0942],
    country: "Netherlands", osm_key: "place", countrycode: "NL",
    osm_value: "region", name: "South Limburg", type: "region",
  },
};

const BUCHAREST_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [44.4268, 26.1025] },
  properties: {
    osm_type: "R", osm_id: 1246893, extent: [44.5455, 25.97, 44.33, 26.29],
    country: "Romania", osm_key: "place", countrycode: "RO",
    osm_value: "city", name: "Bucharest", type: "city",
  },
};

const PARIS_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [48.8566, 2.3522] },
  properties: {
    osm_type: "R", osm_id: 71525, extent: [49.0, 2.0, 48.6, 2.7],
    country: "France", osm_key: "place", countrycode: "FR",
    osm_value: "city", name: "Paris", type: "city",
  },
};

const BRNO_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [49.1951, 16.6068] },
  properties: {
    osm_type: "R", osm_id: 438171, extent: [49.2943708, 16.4279898, 49.1098796, 16.7278346],
    country: "Czech Republic", osm_key: "place", countrycode: "CZ",
    osm_value: "city", name: "Brno", type: "city",
  },
};

const LUXEMBOURG_COUNTRY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [49.8158683, 6.1296751] },
  properties: {
    osm_type: "R", osm_id: 2171347, extent: [50.1827989, 5.7356988, 49.4478587, 6.5312481],
    country: "Luxembourg", osm_key: "place", countrycode: "LU",
    osm_value: "country", name: "Luxembourg", type: "country",
  },
};

const ESPACE_MITTELLAND_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [46.9155, 7.4747] },
  properties: {
    osm_type: "R", osm_id: 17537858, extent: [47.5045, 6.4327, 46.3265, 8.4552],
    country: "Switzerland", osm_key: "place", countrycode: "CH",
    osm_value: "region", name: "Espace Mittelland", type: "region",
  },
};

const BRUSSELS_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [50.8503, 4.3517] },
  properties: {
    osm_type: "R", osm_id: 54094, extent: [51.05, 4.0, 50.65, 4.7],
    country: "Belgium", osm_key: "place", countrycode: "BE",
    osm_value: "city", name: "Brussels", type: "city",
  },
};

const ZURICH_CANTON_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [47.4133024, 8.656394] },
  properties: {
    osm_type: "R", osm_id: 1690227, extent: [47.6944697, 8.3576934, 47.1594376, 8.984951],
    country: "Switzerland", osm_key: "place", countrycode: "CH",
    osm_value: "region", name: "Zürich", type: "region",
  },
};

// Discord server ids (mirror of SERVERS in seed.ts).
const SERVER = {
  UK: "1059625399979606166",
  EU: "1190673594649415730",
  BNL: "1369664929975767120",
  DE: "1333139120507064350",
  CH: "1458858559952523305",
  HOME: "home-games",
} as const;

export const GAME_REGISTRY: GameManifest[] = [
  {
    sentinel: "__bundled-exter-rotterdam-2026__",
    name: "Exter Rotterdam 26",
    serverId: SERVER.HOME,
    size: "medium",
    hidingRadius: 300,
    hidingRadiusUnits: "meters",
    osm: ROTTERDAM_FEATURE,
    kmlPath: "exter-rotterdam-poi.kml",
    stationsKml: "exter-rotterdam-stations.kml",
    boundaryGeoJson: "exter-rotterdam-border.geojson",
    poiFolders: {
      library: "library", museum: "museum", hospital: "hospital", zoo: "zoo",
      cinema: "cinema", golf_course: "golf_course", consulate: "consulate",
      theme_park: "theme_park", airport: "airport",
    },
    gate: { requireGuildId: SERVER.EU, requireRoleId: "1514353477231312966" },
  },
  {
    sentinel: "__bundled-south-limburg-2026__",
    name: "South Limburg 2026",
    serverId: SERVER.BNL,
    size: "medium",
    hidingRadius: 500,
    hidingRadiusUnits: "meters",
    osm: SOUTH_LIMBURG_FEATURE,
    kmlPath: "south-limburg-poi.kml",
    stationsKml: "south-limburg-stations.kml",
    boundaryGeoJson: "south-limburg-border.geojson",
    // Folders in the POI KML use canonical category names → identity mapping.
    poiFolders: {},
    // Maastricht Aachen (the only nearby airport) sits just outside the
    // boundary, but its aerodrome polygon overlaps the zone so Overpass falsely
    // matches it as "in zone" — wrong for the matching question, so hide airport
    // there. Measuring (distance to nearest airport) wants it, so leave it on.
    hiddenQuestionTypes: ["matching:airport"],
  },
  {
    sentinel: "__bundled-bucharest-2026__",
    name: "Bucharest 2026",
    serverId: SERVER.EU,
    size: "medium",
    hidingRadius: 350,
    hidingRadiusUnits: "meters",
    tierRadiusOverrides: { Metro: 350, Tram: 250 },
    osm: BUCHAREST_CITY_FEATURE,
    kmlPath: "bucharest-poi.kml",
    stationsKml: "bucharest-stations.kml",
    boundaryGeoJson: "bucharest-border.geojson",
    poiFolders: {
      cinema: "cinema", consulate: "consulate", covrigarie: "covrigarie",
      hospital: "hospital", library: "library", museum: "museum", park: "park",
      zoo: "zoo", golf_course: "golf_course", theme_park: "theme_park",
      train_station: "train_station", airport: "airport",
    },
  },
  {
    sentinel: "__bundled-paris-2026__",
    name: "Paris 2026",
    serverId: SERVER.EU,
    size: "large",
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    tierRadiusOverrides: { Outer: 600 },
    osm: PARIS_CITY_FEATURE,
    kmlPath: "paris-stations.kml",
    stationsKml: "paris-stations.kml",
    boundaryGeoJson: "paris-border.geojson",
  },
  {
    sentinel: "__bundled-brno-2026-v2__",
    name: "Brno 2026",
    serverId: SERVER.EU,
    size: "medium",
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: BRNO_CITY_FEATURE,
    kmlPath: "brno-poi-v2.kml",
    stationsKml: "brno-stations-v2.kml",
    poiFolders: {
      "5": "museum", "9": "train_station", "11": "airport", "12": "park",
      "13": "administrative", "14": "hospital", "15": "library",
      "20": "theme_park", "21": "zoo", "22": "golf_course", "23": "cinema",
      "25": "water", "26": "administrative",
    },
  },
  {
    sentinel: "__bundled-luxembourg-2026__",
    name: "Luxembourg 2026",
    serverId: SERVER.EU,
    size: "medium",
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
    osm: LUXEMBOURG_COUNTRY_FEATURE,
    kmlPath: "luxembourg-hiding-zones.kml",
  },
  {
    sentinel: "__bundled-bern-2026__",
    name: "Espace Mittelland 2026",
    serverId: SERVER.CH,
    size: "large",
    hidingRadius: 500,
    hidingRadiusUnits: "meters",
    osm: ESPACE_MITTELLAND_FEATURE,
    kmlPath: "bern-canton-poi.kml",
    stationsKml: "bern-canton-stations.kml",
    boundaryGeoJson: "bern-canton-border.geojson",
    poiFolders: {
      airport: "airport", cinema: "cinema", consulate: "consulate",
      hospital: "hospital", library: "library", mountain: "mountain",
      museum: "museum", park: "park", theme_park: "theme_park", zoo: "zoo",
    },
  },
  {
    sentinel: "__bundled-brussels-2026__",
    name: "Brussels 2026",
    serverId: SERVER.EU,
    size: "medium",
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
    osm: BRUSSELS_CITY_FEATURE,
    kmlPath: "brussels-hiding-zones.kml",
  },
  {
    sentinel: "__bundled-zurich-2026__",
    name: "Zurich 2026",
    serverId: SERVER.CH,
    size: "large",
    hidingRadius: 500,
    hidingRadiusUnits: "meters",
    osm: ZURICH_CANTON_FEATURE,
    kmlPath: "zurich-poi.kml",
    stationsKml: "zurich-stations.kml",
    boundaryGeoJson: "zurich-border.geojson",
    // POI folders use canonical category names → identity mapping.
    poiFolders: {},
    // Hide the generic (sea) coastline measuring question — Zurich is landlocked;
    // use the custom "Distance to Lake Zürich Coast" (zurich-coastline) instead.
    hiddenQuestionTypes: ["coastline"],
  },
];

export function manifestBySentinel(sentinel: string): GameManifest | undefined {
  return GAME_REGISTRY.find((g) => g.sentinel === sentinel);
}
