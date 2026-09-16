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
  /** Display name, e.g. "Paris 15-08". */
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
    // extent is the play-area rectangle from the Map Outline layer, not
    // Nominatim's Paris bbox — the board reaches well past the city limits.
    osm_type: "R", osm_id: 71525, extent: [49.0691, 2.014, 48.6472, 2.6313],
    country: "France", osm_key: "place", countrycode: "FR",
    osm_value: "city", name: "Paris", type: "city",
  },
};

const STOCKHOLM_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [59.3336131, 18.0275091] },
  properties: {
    // Stockholms kommun, OSM relation 398021 (Nominatim). extent is the
    // play-area bbox from the supplied divisions, not Nominatim's kommun bbox —
    // the board covers the wider county, well beyond the municipality.
    osm_type: "R", osm_id: 398021, extent: [59.6891, 17.4648, 58.6184, 18.9412],
    country: "Sweden", osm_key: "place", countrycode: "SE",
    osm_value: "city", name: "Stockholm", type: "city",
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
const BUDAPEST_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [47.4978789, 19.0402383] },
  properties: {
    osm_type: "R", osm_id: 1244004, extent: [47.6131468, 18.9251057, 47.3496899, 19.3349258],
    country: "Hungary", osm_key: "place", countrycode: "HU",
    osm_value: "city", name: "Budapest", type: "city",
  },
};

const BELGIUM_COUNTRY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [50.6402809, 4.6667145] },
  properties: {
    osm_type: "R", osm_id: 52411, extent: [51.550781, 2.3889137, 49.4969821, 6.408097],
    country: "Belgium", osm_key: "place", countrycode: "BE",
    osm_value: "country", name: "Belgium", type: "country",
  },
};

// Greater London (Nominatim: relation 175342). The `extent` is deliberately
// NOT Nominatim's Greater London bbox — the play area is the Zone 1–3 circle
// drawn in the source KMZ (r = 14.5 km around Charing Cross), which sits well
// inside it, so the boundary geojson's own bbox is used instead.
const LONDON_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [51.5074456, -0.1277653] },
  properties: {
    osm_type: "R", osm_id: 175342, extent: [51.638296, -0.33735, 51.377784, 0.081206],
    country: "United Kingdom", osm_key: "place", countrycode: "GB",
    osm_value: "city", name: "London", type: "city",
  },
};

// Same relation as LONDON_CITY_FEATURE, but extent is all of Greater London —
// that is North London 26-09's play area.
const GREATER_LONDON_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [51.5074456, -0.1277653] },
  properties: {
    osm_type: "R", osm_id: 175342, extent: [51.69186, -0.51038, 51.28676, 0.33402],
    country: "United Kingdom", osm_key: "place", countrycode: "GB",
    osm_value: "city", name: "London", type: "city",
  },
};

const GRAZ_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [47.0708678, 15.4382786] },
  properties: {
    osm_type: "R", osm_id: 34719, extent: [47.1345, 15.349714, 47.0118871, 15.5342002],
    country: "Austria", osm_key: "place", countrycode: "AT",
    osm_value: "city", name: "Graz", type: "city",
  },
};

// extent is the PLAY AREA bbox (the 12 km boundary circle), not Nominatim's
// city bbox — the board reaches past the comune in every direction. Same call
// as Paris, whose extent is its play rectangle rather than the city limits.
const MILAN_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [45.4641943, 9.1896346] },
  properties: {
    osm_type: "R", osm_id: 44915, extent: [45.57667, 9.03653, 45.36073, 9.34343],
    country: "Italy", osm_key: "place", countrycode: "IT",
    osm_value: "city", name: "Milan", type: "city",
  },
};

// extent is the PLAY AREA bbox, not the city's — the board runs from Portslade
// to Saltdean and inland over the Downs, well past Brighton itself.
const BRIGHTON_CITY_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [50.8225, -0.1372] },
  properties: {
    osm_type: "R", osm_id: 114085, extent: [50.89238, -0.24505, 50.79908, -0.016],
    country: "United Kingdom", osm_key: "place", countrycode: "GB",
    osm_value: "city", name: "Brighton and Hove", type: "city",
  },
};

// OSM relation 88084 (Nominatim, 16/09/2026). extent is the PLAY AREA bbox.
const GREATER_MANCHESTER_FEATURE: GameOSMFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [53.5065, -2.3374] },
  properties: {
    osm_type: "R", osm_id: 88084, extent: [53.68574, -2.73042, 53.3272, -1.90962],
    // "place"/"city" like every other game, though OSM calls this a
    // boundary=administrative county — the board is the whole county.
    country: "United Kingdom", osm_key: "place", countrycode: "GB",
    osm_value: "city", name: "Greater Manchester", type: "city",
  },
};

const SERVER = {
  UK: "1059625399979606166",
  EU: "1190673594649415730",
  BNL: "1369664929975767120",
  DE: "1333139120507064350",
  CH: "1458858559952523305",
  NORDICS: "1376560872029290708",
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
    // Exter Rotterdam 26 plus one question: the NS heavy-rail stations, as both
    // matching and measuring (rotterdam-ns). Every other asset is SHARED with
    // that game byte-for-byte — same 206 hiding zones, same border,
    // municipalities, HSL and coastline. Only the POI file differs, and it is a
    // separate file because parseKMLFolderPOI falls back to the lowercased
    // folder name for anything poiFolders does not list, so an extra folder in
    // the shared KML would load into the older game too.
    // Regenerate with scripts/gen-rotterdam-2026-assets.py.
    sentinel: "__bundled-rotterdam-2026-09__",
    name: "Rotterdam 12-09",
    serverId: SERVER.BNL,
    size: "medium",
    hidingRadius: 300,
    hidingRadiusUnits: "meters",
    osm: ROTTERDAM_FEATURE,
    kmlPath: "rotterdam-2026-poi.kml",
    stationsKml: "exter-rotterdam-stations.kml",
    boundaryGeoJson: "exter-rotterdam-border.geojson",
    poiFolders: {
      library: "library", museum: "museum", hospital: "hospital", zoo: "zoo",
      cinema: "cinema", golf_course: "golf_course", consulate: "consulate",
      theme_park: "theme_park", airport: "airport",
      // NOT "train_station": that key overrides the generic same-train-line and
      // same-length-station questions, which must see all 206 stops, not these
      // 9. The milan-train / brighton-rail shape.
      rail_station: "rail_station",
    },
    // Both of these ask the same thing as a bundled question on this board, and
    // the bundled one is the better answer — it is the author's own geometry,
    // and it does not depend on Overpass at play time:
    //   coastline                     → rotterdam-coastline (the Kustlijn)
    //   highspeed-measure-shinkansen  → rotterdam-rail (exter-rotterdam-hsl)
    // The generic pair query Overpass live ("coastline" globally, HSL as
    // [highspeed=yes] in zone) and would sit in the picker one line from their
    // custom twins, which is how a seeker ends up asking the worse version of a
    // question they thought they had already asked. Belgium and Zürich hide
    // "coastline" for exactly this reason.
    //
    // Deliberately NOT hidden, because they are not duplicates:
    //   rail-measure / same-train-line / same-length-station — all 206 stops,
    //     where rotterdam-ns is only the 9 NS heavy-rail ones
    //   the POI categories (library, museum, …) — the custom POIs OVERRIDE the
    //     generic questions in place, so there is no second copy to hide
    hiddenQuestionTypes: ["coastline", "highspeed-measure-shinkansen"],
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
    // First game on the Nordics server. Three levels of the author's own admin
    // groupings (3 / 9 / 25), each with matching AND measuring, plus a
    // game-specific IKEA POI doing both — see stockholmAdmin.ts.
    //
    // Stockholm supplies only 3 of the 13 rulebook categories (hospital,
    // golf_course, airport), and the other ten are MEANT to fall through to
    // Overpass — which reaches the self-hosted instance first via the API
    // proxy. So the hidden list stays as short as possible.
    //
    // `coastline` is hidden for the opposite reason to every other game that
    // hides it: those are landlocked, Stockholm is an archipelago. The coast is
    // fractal and everywhere, so the question barely discriminates and the
    // Overpass query is huge.
    //
    // The rest is a per-family list from Jules. The `kind:type` prefixes matter:
    // aquariums are hidden in all three families but the literal differs
    // (`aquarium` for tentacles and inside the Hiding Zone Mode group,
    // `aquarium-full` for the ungrouped matching/measuring options), and
    // hospitals are hidden ONLY as tentacles — Stockholm bundles 15 of them, so
    // the matching/measuring hospital questions are good ones here.
    sentinel: "__bundled-stockholm-2026__",
    name: "Stockholm 15-08",
    serverId: SERVER.NORDICS,
    size: "large",
    // Uniform across all 191 zones — no tierRadiusOverrides, and the stations
    // KML carries no <Data name="tier"> at all.
    hidingRadius: 500,
    hidingRadiusUnits: "meters",
    osm: STOCKHOLM_CITY_FEATURE,
    kmlPath: "stockholm-poi.kml",
    stationsKml: "stockholm-stations.kml",
    boundaryGeoJson: "stockholm-border.geojson",
    poiFolders: {},
    hiddenQuestionTypes: [
      "coastline",
      // Tentacles
      "tentacle:theme_park",
      "tentacle:zoo",
      "tentacle:aquarium",
      "tentacle:hospital",
      // Measuring
      "measuring:city", // "Major City (1,000,000+ people)"
      "measuring:international-border",
      "measuring:aquarium-full",
      "measuring:aquarium", // the Hiding Zone Mode copy
      "measuring:mcdonalds",
      "measuring:seven11",
      // Matching
      "matching:letter-zone", // "Zone Starts With Same Letter"
      "matching:major-city",
      "matching:aquarium-full",
      "matching:aquarium", // the Hiding Zone Mode copy
    ],
  },
  {
    // Refreshed from the author's v0.1 pack (Aug 2026), replacing the original
    // "Paris 2026" in place — same sentinel, so existing sessions keep their
    // strokes. The 412 hiding zones are unchanged (same names, same Inner/Outer
    // split, same radii); what is new is the POI file — the old game shipped
    // none, so every POI question fell through to Overpass — the arrondissement
    // questions, and a larger play area (a 2,115 km² rectangle, up from the
    // old 1,556 km² polygon).
    sentinel: "__bundled-paris-2026__",
    name: "Paris 15-08",
    serverId: SERVER.EU,
    size: "large",
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    tierRadiusOverrides: { Outer: 600 },
    osm: PARIS_CITY_FEATURE,
    kmlPath: "paris-poi.kml",
    stationsKml: "paris-stations.kml",
    boundaryGeoJson: "paris-border.geojson",
    poiFolders: {},
    // Paris supplies 11 of the 13 rulebook categories; mountain and rail have no
    // POIs. Per Entry 48 only the *ungrouped* literals actually bite, so
    // "peak-full" and "coastline" are the ones doing work and bare "peak" is
    // there for intent. The generic train-station questions sit in the Hiding
    // Zone Mode group and cannot be hidden (same as London).
    hiddenQuestionTypes: ["peak", "peak-full", "coastline"],
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
  {
    sentinel: "__bundled-budapest-2025__",
    name: "Budapest 11.07.25",
    serverId: SERVER.EU,
    size: "large",
    hidingRadius: 250,
    hidingRadiusUnits: "meters",
    osm: BUDAPEST_CITY_FEATURE,
    kmlPath: "budapest-poi.kml",
    stationsKml: "budapest-stations.kml",
    boundaryGeoJson: "budapest-border.geojson",
    // POI folders use canonical category names → identity mapping. The custom
    // categories castle / stadium load into gamePOIData for the Budapest-only
    // matching/measuring questions; train_station backs the Budapest railway
    // question; bodies of water are bundled separately (budapest-water.geojson)
    // because the importer skips a "water" folder.
    poiFolders: {},
    // Budapest is landlocked — hide the generic sea-coastline measuring question.
    hiddenQuestionTypes: ["coastline"],
  },
  {
    sentinel: "__bundled-belgium-2026__",
    name: "Belgium 01.08",
    serverId: SERVER.BNL,
    size: "large",
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
    osm: BELGIUM_COUNTRY_FEATURE,
    kmlPath: "belgium-poi.kml",
    stationsKml: "belgium-stations.kml",
    boundaryGeoJson: "belgium-border.geojson",
    // POI folders use canonical category names → identity mapping. The custom
    // "castle" folder passes through the importer into gamePOIData["castle"] for
    // the Belgium-only castle/fort matching + measuring questions.
    poiFolders: {},
    // Not available in this game (no parks / mountains / aquariums). The custom
    // belgium-coastline question replaces the generic global sea-coastline one.
    hiddenQuestionTypes: ["park", "mountain", "aquarium", "coastline"],
  },
  {
    sentinel: "__bundled-london-2026__",
    name: "London 02-08",
    serverId: SERVER.UK,
    size: "large",
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: LONDON_CITY_FEATURE,
    kmlPath: "london-poi.kml",
    stationsKml: "london-stations.kml",
    boundaryGeoJson: "london-border.geojson",
    // POI folders use canonical category names → identity mapping. The two
    // custom folders pass through the importer into gamePOIData for the
    // London-only matching + measuring questions: "stadium" → london-stadium,
    // "rail_terminus" → london-rail. The termini are deliberately NOT in a
    // "train_station" folder — that key overrides the generic same-train-line /
    // same-length-station questions, which must see all London rail, not 14
    // terminals.
    poiFolders: {},
    // Categories the source map does not provide, so the generic questions
    // would fall through to Overpass and match features outside the play area.
    // These are the ungrouped picker literals — the "Hiding Zone Mode" group is
    // not filtered by hiddenQuestionTypes, so bare peak/park/consulate entries
    // would be inert. "coastline": the play area is inland (the Thames is not
    // sea coast). "theme_park" covers the tentacle picker, which does filter
    // grouped entries.
    hiddenQuestionTypes: [
      "airport",
      "theme_park",
      "theme_park-full",
      "peak-full",
      "consulate-full",
      "park-full",
      "coastline",
    ],
  },
  {
    // Same map as London 02-08, restricted to step-free stations: the source
    // KMZ is identical layer for layer except Station, so every asset except
    // the hiding zones is SHARED with that game rather than duplicated
    // (scripts/gen-accessible-london-assets.py asserts they stay identical).
    // 90 zones = every station the map classes accessible_type "Full" (70) or
    // "Partial" (20). Unlike the base game this does NOT also filter on
    // category="Not Allowed", so it keeps 5 zones London 02-08 drops for
    // proximity — the step-free set is sparse enough that proximity stops
    // mattering. "Interchange" and "Travel" stay excluded.
    sentinel: "__bundled-accessible-london-2026__",
    name: "Accessible London 02-08",
    serverId: SERVER.UK,
    size: "large",
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: LONDON_CITY_FEATURE,
    kmlPath: "london-poi.kml",
    stationsKml: "accessible-london-stations.kml",
    boundaryGeoJson: "london-border.geojson",
    poiFolders: {},
    hiddenQuestionTypes: [
      "airport",
      "theme_park",
      "theme_park-full",
      "peak-full",
      "consulate-full",
      "park-full",
      "coastline",
    ],
  },
  {
    sentinel: "__bundled-graz-2026__",
    name: "Graz 08-08",
    serverId: SERVER.EU,
    size: "medium",
    // 250 m everywhere except the 7 train stations, which get 400 m. The tier
    // keys are the "mode" column of the source CSV, written into the stations
    // KML as <Data name="tier"> — bus (95) and tram (72) take the base radius.
    hidingRadius: 250,
    hidingRadiusUnits: "meters",
    tierRadiusOverrides: { train: 400 },
    osm: GRAZ_CITY_FEATURE,
    kmlPath: "graz-poi.kml",
    stationsKml: "graz-stations.kml",
    boundaryGeoJson: "graz-border.geojson",
    // POI folders use canonical category names → identity mapping.
    poiFolders: {},
    // Graz supplies 10 of the 13 rulebook categories. Airport and aquarium have
    // no POIs here, and the city is landlocked. (Only the ungrouped literals
    // actually bite — the Hiding Zone Mode group is never filtered — so bare
    // "aquarium" is listed for intent while "airport"/"coastline" are the ones
    // that do the work.)
    hiddenQuestionTypes: ["airport", "aquarium", "aquarium-full", "coastline"],
  },
  {
    sentinel: "__bundled-milan-2026__",
    name: "Milan 29-08",
    serverId: SERVER.EU,
    // 451 km² — a 12 km circle around the Duomo.
    size: "medium",
    // Uniform across all 269 stations. The source CSV's hiding_radius_m is
    // 400.0 for every row, so there are no tierRadiusOverrides; the mode
    // (metro 103 / bus 63 / tram 62 / train 26 / trolleybus 15) is still
    // carried as <Data name="tier"> but nothing reads it.
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: MILAN_CITY_FEATURE,
    kmlPath: "milan-poi.kml",
    stationsKml: "milan-stations.kml",
    boundaryGeoJson: "milan-border.geojson",
    // POI folders use canonical category names → identity mapping. Milan
    // supplies 11 of the 13 rulebook categories (no zoo, and "rail" is served
    // by the custom milan-train instead), plus three game-specific ones:
    // castle, rail_station and water_body — see GAME_GATED_TYPES in schema.ts.
    // The 12 admin divisions ship separately as milan-municipi.geojson and are
    // read by milan-municipio (milanAdmin.ts), not through poiFolders.
    poiFolders: {},
    // Aquarium and airport have exactly ONE feature each (Acquario Civico,
    // Linate). Measuring them is a good question; MATCHING them is degenerate —
    // with a single POI both players are always nearest the same one, so the
    // answer is always "yes" and it eliminates zero hiding zones. Hidden for
    // matching only, via the kind:type prefix (the South Limburg / Stockholm
    // shape). Jules' call, 27/08/2026.
    hiddenQuestionTypes: ["matching:aquarium-full", "matching:airport"],
  },
  {
    sentinel: "__bundled-brighton-2026__",
    name: "Brighton 29-08",
    serverId: SERVER.UK,
    // 82.62 km² — the smallest bundled game so far.
    size: "medium",
    // Uniform across all 132 stops; the source draws every hiding zone as a
    // 250 m circle, so there are no tierRadiusOverrides.
    hidingRadius: 250,
    hidingRadiusUnits: "meters",
    osm: BRIGHTON_CITY_FEATURE,
    kmlPath: "brighton-poi.kml",
    stationsKml: "brighton-stations.kml",
    // NOT the supplied game area: it clipped 14 hiding zones, so it was pushed
    // out additively to cover everything walkable they reached (+48,276 m²,
    // nothing removed). See scripts/gen-brighton-assets.py.
    boundaryGeoJson: "brighton-border.geojson",
    // POI folders use canonical category names → identity mapping. Brighton
    // supplies 7 of the 13 rulebook categories plus "rail_station", which is
    // read only by brighton-rail — deliberately not "train_station", which
    // would hijack the generic same-train-line question with 7 of 132 stops.
    // Wards, postcodes and the coastline ship as separate GeoJSON and are read
    // by brightonAdmin.ts, not through poiFolders.
    poiFolders: {},
    // No zoo, aquarium, theme park, consulate or airport anywhere in the play
    // area, and the generic coastline question is superseded by the bundled
    // brighton-coastline (18.6 km of real OSM coast between the author's two
    // end markers, rather than an Overpass pull).
    hiddenQuestionTypes: [
      "airport",
      "aquarium",
      "aquarium-full",
      "zoo",
      "zoo-full",
      "theme_park",
      "theme_park-full",
      "consulate",
      "consulate-full",
      "coastline",
    ],
  },
  {
    // Regenerate with scripts/gen-greater-manchester-assets.py.
    sentinel: "__bundled-greater-manchester-2026__",
    name: "Greater Manchester 19-9",
    serverId: SERVER.UK,
    // 1,271.55 km² — London-scale, so "large".
    size: "large",
    // Uniform: the source draws every hiding zone as a 400 m circle. Only the
    // stations that HAVE a circle are hiding zones — all 168 of them, a mix of
    // National Rail, Metrolink and bus stations.
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: GREATER_MANCHESTER_FEATURE,
    kmlPath: "gm-poi.kml",
    stationsKml: "gm-stations.kml",
    boundaryGeoJson: "gm-border.geojson",
    // Canonical folder names → identity mapping: airport, zoo, aquarium,
    // hospital, consulate, mountain. No library folder on purpose — the source
    // has no libraries, so those questions stay on Overpass. Boroughs, wards and
    // the West Coast Main Line ship as separate GeoJSON, read by gmAdmin.ts and
    // measuring.ts rather than through poiFolders.
    poiFolders: {},
    // The board is exactly Jules' list (16/09/2026): measuring AND matching for
    // boroughs, wards, high-speed line, mountain, zoo, aquarium, hospital,
    // library and consulate; airport is measuring only. Every other rulebook
    // matching/measuring question is hidden. Kind-prefixed throughout, so
    // tentacles are untouched. The generic Overpass HSL and admin-zone
    // questions are hidden in favour of gm-hsl / gm-borough / gm-ward.
    hiddenQuestionTypes: [
      "matching:airport",
      "matching:major-city",
      "matching:zone",
      "matching:letter-zone",
      "matching:theme_park",
      "matching:theme_park-full",
      "matching:museum",
      "matching:museum-full",
      "matching:cinema",
      "matching:cinema-full",
      "matching:golf_course",
      "matching:golf_course-full",
      "matching:park",
      "matching:park-full",
      "measuring:coastline",
      "measuring:city",
      "measuring:highspeed-measure-shinkansen",
      "measuring:international-border",
      "measuring:international-border-og",
      "measuring:theme_park",
      "measuring:theme_park-full",
      "measuring:museum",
      "measuring:museum-full",
      "measuring:cinema",
      "measuring:cinema-full",
      "measuring:golf_course",
      "measuring:golf_course-full",
      "measuring:park",
      "measuring:park-full",
    ],
  },
  {
    // Regenerate with scripts/gen-north-london-assets.py.
    sentinel: "__bundled-north-london-2026__",
    name: "North London 26-09",
    serverId: SERVER.UK,
    // The PLAY AREA is all of Greater London (1,582 km²), but every hiding zone
    // sits in ~25 km² of north/central London.
    size: "large",
    // 56 zones, uniform 400 m. The 8 stations the source marks "Closed" for
    // engineering works are still hiding zones (Jules, 16/09/2026).
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
    osm: GREATER_LONDON_FEATURE,
    kmlPath: "nl-poi.kml",
    stationsKml: "nl-stations.kml",
    boundaryGeoJson: "nl-border.geojson",
    // cinema, library, museum, hospital — canonical folders. Stations are NOT
    // bundled as "train_station": rail-station measuring and station-name
    // length are hiding-zone-mode questions that already read the 56 zones.
    poiFolders: {},
    // The board is exactly the game's rules table. Matching: constituency,
    // ward, station name length, park, museum, cinema, hospital, library.
    // Measuring: constituency, ward, high-speed rail, rail station, body of
    // water, park, museum, cinema, hospital, library. Transit line,
    // street/path and sea level are in the table but dropped from the app
    // (Jules' call). Everything else is hidden; tentacles are not in the table
    // and are left alone. Park is the generic Overpass question.
    hiddenQuestionTypes: [
      "matching:airport",
      "matching:major-city",
      "matching:zone",
      "matching:letter-zone",
      "matching:same-first-letter-station",
      "matching:same-train-line",
      "matching:aquarium",
      "matching:aquarium-full",
      "matching:zoo",
      "matching:zoo-full",
      "matching:theme_park",
      "matching:theme_park-full",
      "matching:peak",
      "matching:peak-full",
      "matching:golf_course",
      "matching:golf_course-full",
      "matching:consulate",
      "matching:consulate-full",
      "measuring:coastline",
      "measuring:airport",
      "measuring:city",
      "measuring:highspeed-measure-shinkansen",
      "measuring:international-border",
      "measuring:international-border-og",
      "measuring:mcdonalds",
      "measuring:seven11",
      "measuring:aquarium",
      "measuring:aquarium-full",
      "measuring:zoo",
      "measuring:zoo-full",
      "measuring:theme_park",
      "measuring:theme_park-full",
      "measuring:peak",
      "measuring:peak-full",
      "measuring:golf_course",
      "measuring:golf_course-full",
      "measuring:consulate",
      "measuring:consulate-full",
    ],
  },
];

export function manifestBySentinel(sentinel: string): GameManifest | undefined {
  return GAME_REGISTRY.find((g) => g.sentinel === sentinel);
}
