import type { DistanceUnit, FeatureEnabledFor, FeatureIcon } from "@searchlight/shared";

export type GameScale = "small" | "medium" | "large";

export type StationPresetId =
  | "rail-metro"
  | "rail-only"
  | "rail-metro-tram"
  | "metro-only"
  | "custom";

export interface StationPreset {
  id: StationPresetId;
  label: string;
  description: string;
  /** One or more Overpass nwr filter clauses (unioned inside the play area bbox). */
  osmFilters: readonly string[];
}

export interface PoiCategoryPreset {
  id: string;
  /** Singular Title Case layer name matching Searchlight conventions. */
  name: string;
  /** Overpass tag selector, e.g. '["tourism"="museum"]'. */
  osmFilter: string;
  defaultEnabledFor: readonly FeatureEnabledFor[];
  color: string;
  /** Semantic icon stored in .game.json and mapped to Google My Maps icon IDs on KML export. */
  icon: FeatureIcon;
  /** Default thematic folder when packing POIs to fit Google My Maps' 9-layer mobile limit. */
  kmlGroup: string;
  /** Suggests the "notable only (wikidata/wikipedia)" filter for noisy OSM tags. */
  noisyInOsm?: boolean;
  /** Hint shown next to the category in the UI. */
  hint?: string;
}

export interface ScalePreset {
  id: GameScale;
  label: string;
  description: string;
  unit: DistanceUnit;
  hidingRadius: number;
  radars: readonly number[];
  thermometer: boolean;
  stationPreset: StationPresetId;
  poiBufferKm: number;
}

export const STATION_PRESETS: readonly StationPreset[] = [
  {
    id: "rail-metro",
    label: "Rail + Metro",
    description: "Train and subway/metro stations (good default for cities).",
    osmFilters: [
      '["railway"="station"]["station"!="light_rail"]["station"!="tram"]["disused"!="yes"]["abandoned"!="yes"]',
      '["railway"="halt"]["disused"!="yes"]["abandoned"!="yes"]',
    ],
  },
  {
    id: "rail-only",
    label: "Mainline Rail only",
    description: "Regional and national rail stations, excluding metro and tram.",
    osmFilters: [
      '["railway"="station"]["station"!="subway"]["station"!="light_rail"]["station"!="tram"]["station"!="monorail"]["disused"!="yes"]["abandoned"!="yes"]',
      '["railway"="halt"]["disused"!="yes"]["abandoned"!="yes"]',
    ],
  },
  {
    id: "rail-metro-tram",
    label: "Rail + Metro + Tram",
    description: "Includes tram and light-rail stops for smaller districts.",
    osmFilters: [
      '["railway"="station"]["disused"!="yes"]["abandoned"!="yes"]',
      '["railway"="halt"]["disused"!="yes"]["abandoned"!="yes"]',
      '["railway"="tram_stop"]["disused"!="yes"]["abandoned"!="yes"]',
    ],
  },
  {
    id: "metro-only",
    label: "Metro / Subway only",
    description: "Underground / metro stations only.",
    osmFilters: ['["railway"="station"]["station"="subway"]["disused"!="yes"]["abandoned"!="yes"]'],
  },
  {
    id: "custom",
    label: "Custom Overpass filter",
    description: 'Write your own OSM tag filter (e.g. ["amenity"="ferry_terminal"]).',
    osmFilters: [],
  },
];

export const CREATOR_POI_CATALOG: readonly PoiCategoryPreset[] = [
  {
    id: "airport",
    name: "Airport",
    osmFilter: '["aeroway"="aerodrome"]["iata"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#673AB7",
    icon: "airport",
    kmlGroup: "Public Amenities",
    hint: "Commercial airports (requires IATA code)",
  },
  {
    id: "aquarium",
    name: "Aquarium",
    osmFilter: '["tourism"="aquarium"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#3949AB",
    icon: "aquarium",
    kmlGroup: "Places of Interest",
  },
  {
    id: "cinema",
    name: "Cinema",
    osmFilter: '["amenity"="cinema"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#000000",
    icon: "cinema",
    kmlGroup: "Places of Interest",
  },
  {
    id: "consulate",
    name: "Consulate",
    osmFilter: '["diplomatic"="consulate"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#01579B",
    icon: "consulate",
    kmlGroup: "Public Amenities",
  },
  {
    id: "golf_course",
    name: "Golf Course",
    osmFilter: '["leisure"="golf_course"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#7CB342",
    icon: "golf",
    kmlGroup: "Nature & Leisure",
  },
  {
    id: "hospital",
    name: "Hospital",
    osmFilter: '["amenity"="hospital"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#FF5252",
    icon: "hospital",
    kmlGroup: "Public Amenities",
  },
  {
    id: "library",
    name: "Library",
    osmFilter: '["amenity"="library"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#E65100",
    icon: "library",
    kmlGroup: "Public Amenities",
  },
  {
    id: "mountain",
    name: "Mountain",
    osmFilter: '["natural"="peak"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#4E342E",
    icon: "mountain",
    kmlGroup: "Nature & Leisure",
    noisyInOsm: true,
    hint: "Can include small hills; try Notable only",
  },
  {
    id: "museum",
    name: "Museum",
    osmFilter: '["tourism"="museum"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#0288D1",
    icon: "museum",
    kmlGroup: "Places of Interest",
    noisyInOsm: true,
  },
  {
    id: "park",
    name: "Park",
    osmFilter: '["leisure"="park"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#0F9D58",
    icon: "park",
    kmlGroup: "Nature & Leisure",
    noisyInOsm: true,
    hint: "OSM includes small neighborhood parks; try Notable only",
  },
  {
    id: "theme_park",
    name: "Theme Park",
    osmFilter: '["tourism"="theme_park"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#AFB42B",
    icon: "theme-park",
    kmlGroup: "Places of Interest",
  },
  {
    id: "university",
    name: "University",
    osmFilter: '["amenity"="university"]',
    defaultEnabledFor: ["matching", "measuring"],
    color: "#FFD600",
    icon: "university",
    kmlGroup: "Public Amenities",
  },
  {
    id: "zoo",
    name: "Zoo",
    osmFilter: '["tourism"="zoo"]',
    defaultEnabledFor: ["matching", "measuring", "tentacle"],
    color: "#9C27B0",
    icon: "zoo",
    kmlGroup: "Places of Interest",
  },
];

export const SCALE_PRESETS: Record<GameScale, ScalePreset> = {
  small: {
    id: "small",
    label: "Small",
    description: "District or small town",
    unit: "meters",
    hidingRadius: 250,
    radars: [150, 250, 500, 1000],
    thermometer: true,
    stationPreset: "rail-metro-tram",
    poiBufferKm: 1,
  },
  medium: {
    id: "medium",
    label: "Medium",
    description: "City or metro area",
    unit: "meters",
    hidingRadius: 400,
    radars: [250, 400, 800, 1500, 3000],
    thermometer: true,
    stationPreset: "rail-metro",
    poiBufferKm: 2,
  },
  large: {
    id: "large",
    label: "Large",
    description: "Region or country",
    unit: "meters",
    hidingRadius: 1000,
    radars: [500, 1000, 2500, 5000, 10000],
    thermometer: true,
    stationPreset: "rail-only",
    poiBufferKm: 5,
  },
};

/** Curated Google My Maps palette colors used by the Creator style picker & KML exporter. */
export const MY_MAPS_PALETTE = [
  "#1A237E",
  "#0288D1",
  "#01579B",
  "#3949AB",
  "#673AB7",
  "#9C27B0",
  "#FF5252",
  "#A52714",
  "#E65100",
  "#F9A825",
  "#FFD600",
  "#AFB42B",
  "#7CB342",
  "#0F9D58",
  "#4E342E",
  "#000000",
] as const;

/** Distinct colors for small multi-region polygon layers (e.g. Provinces, Water Boards). */
export const REGION_POLY_PALETTE = [
  "#FFD600",
  "#7CB342",
  "#9C27B0",
  "#E65100",
  "#FF5252",
  "#097138",
  "#558B2F",
  "#4E342E",
  "#A52714",
  "#AFB42B",
  "#0F9D58",
  "#006064",
  "#0288D1",
  "#3949AB",
  "#673AB7",
] as const;

export const CUSTOM_LAYER_COLORS = [
  "#0288D1",
  "#FF5252",
  "#673AB7",
  "#0F9D58",
  "#E65100",
  "#7CB342",
  "#9C27B0",
  "#F9A825",
];

export interface FeatureIconMeta {
  label: string;
  /** Built-in Google My Maps icon number used in `<StyleMap id="icon-XXXX-RRGGBB">`. */
  myMapsId: number;
  defaultColor: string;
}

export const FEATURE_ICON_META: Record<FeatureIcon, FeatureIconMeta> = {
  pin: { label: "Pin", myMapsId: 1899, defaultColor: "#0288D1" },
  station: { label: "Station", myMapsId: 1739, defaultColor: "#1A237E" },
  airport: { label: "Airport", myMapsId: 1504, defaultColor: "#673AB7" },
  aquarium: { label: "Aquarium", myMapsId: 1572, defaultColor: "#3949AB" },
  cinema: { label: "Cinema", myMapsId: 1635, defaultColor: "#000000" },
  consulate: { label: "Consulate", myMapsId: 1547, defaultColor: "#01579B" },
  golf: { label: "Golf Course", myMapsId: 1799, defaultColor: "#7CB342" },
  hospital: { label: "Hospital", myMapsId: 1807, defaultColor: "#FF5252" },
  library: { label: "Library", myMapsId: 1619, defaultColor: "#E65100" },
  mountain: { label: "Mountain", myMapsId: 1634, defaultColor: "#4E342E" },
  museum: { label: "Museum", myMapsId: 1636, defaultColor: "#0288D1" },
  park: { label: "Park", myMapsId: 1720, defaultColor: "#0F9D58" },
  stadium: { label: "Stadium", myMapsId: 1698, defaultColor: "#F9A825" },
  star: { label: "Star", myMapsId: 1502, defaultColor: "#FFD600" },
  "theme-park": {
    label: "Theme Park",
    myMapsId: 1568,
    defaultColor: "#AFB42B",
  },
  university: {
    label: "University",
    myMapsId: 1726,
    defaultColor: "#FFD600",
  },
  zoo: { label: "Zoo", myMapsId: 1743, defaultColor: "#9C27B0" },
};

const MY_MAPS_ID_TO_ICON = new Map<number, FeatureIcon>(
  (Object.entries(FEATURE_ICON_META) as [FeatureIcon, FeatureIconMeta][]).map(([icon, meta]) => [
    meta.myMapsId,
    icon,
  ]),
);

/** Infers a semantic POI icon from a Searchlight layer name. */
export function inferLayerIcon(layerName: string): FeatureIcon {
  const lower = layerName.toLowerCase();
  if (/hospital|clinic|medical/.test(lower)) return "hospital";
  if (/airport|aerodrome/.test(lower)) return "airport";
  if (/consulate|embassy|diplomat/.test(lower)) return "consulate";
  if (/universit|college|campus/.test(lower)) return "university";
  if (/theme\s*park|amusement/.test(lower)) return "theme-park";
  if (/\bzoo\b|safari|wildlife/.test(lower)) return "zoo";
  if (/museum|gallery/.test(lower)) return "museum";
  if (/stadium|arena/.test(lower)) return "stadium";
  if (/aquarium|sea\s*life/.test(lower)) return "aquarium";
  if (/golf/.test(lower)) return "golf";
  if (/cinema|movie|theater|theatre/.test(lower)) return "cinema";
  if (/library|biblioth/.test(lower)) return "library";
  if (/mountain|peak|summit/.test(lower)) return "mountain";
  if (/park|garden|forest|nature/.test(lower)) return "park";
  if (/station|train|metro|subway|tram/.test(lower)) return "station";
  if (/start|star/.test(lower)) return "star";
  return "pin";
}

/** Picks a sensible default hex color for a layer name, matching My Maps conventions. */
export function inferLayerColor(layerName: string, fallbackIdx = 0): string {
  const icon = inferLayerIcon(layerName);
  if (icon !== "pin") return FEATURE_ICON_META[icon].defaultColor;
  return CUSTOM_LAYER_COLORS[Math.abs(fallbackIdx) % CUSTOM_LAYER_COLORS.length];
}

/**
 * Extracts a semantic icon and/or `#RRGGBB` color from a Google My Maps KML
 * `<styleUrl>` (e.g. `#icon-1807-FF5252`, `#poly-FFD600-1200-76`, `#line-000000-2744`).
 */
export function parseMyMapsStyleUrl(styleUrl?: string): {
  icon?: FeatureIcon;
  color?: string;
} {
  if (!styleUrl) return {};
  const iconMatch = styleUrl.match(/icon-(\d+)-([0-9a-fA-F]{6})\b/);
  if (iconMatch) {
    const id = Number(iconMatch[1]);
    return {
      icon: MY_MAPS_ID_TO_ICON.get(id),
      color: `#${iconMatch[2].toUpperCase()}`,
    };
  }
  const shapeMatch = styleUrl.match(/(?:poly|line)-([0-9a-fA-F]{6})\b/);
  if (shapeMatch) {
    return { color: `#${shapeMatch[1].toUpperCase()}` };
  }
  return {};
}

export interface AdminLevelPreset {
  level: number;
  label: string;
  defaultName: string;
  description: string;
}

export const ADMIN_LEVEL_PRESETS: readonly AdminLevelPreset[] = [
  {
    level: 2,
    label: "Level 2: Country",
    defaultName: "Country",
    description: "National borders",
  },
  {
    level: 3,
    label: "Level 3: Macro-region / Territory",
    defaultName: "Macro-region",
    description: "Supra-state regions or territories (used in a few countries)",
  },
  {
    level: 4,
    label: "Level 4: State / Province / Canton",
    defaultName: "Province",
    description: "1st-level subnational regions (states, cantons, provinces)",
  },
  {
    level: 5,
    label: "Level 5: Region",
    defaultName: "Region",
    description: "Intermediate regions between state and county",
  },
  {
    level: 6,
    label: "Level 6: County / District",
    defaultName: "County",
    description: "Counties, départements, or large districts",
  },
  {
    level: 7,
    label: "Level 7: Sub-district",
    defaultName: "Sub-district",
    description: "Sub-districts or municipal associations",
  },
  {
    level: 8,
    label: "Level 8: Municipality / City",
    defaultName: "Municipality",
    description: "Cities, towns, and municipalities",
  },
  {
    level: 9,
    label: "Level 9: Borough / Arrondissement",
    defaultName: "Borough",
    description: "City boroughs, arrondissements, or Kreise",
  },
  {
    level: 10,
    label: "Level 10: Ward / Neighbourhood",
    defaultName: "Ward",
    description: "Fine-grained wards or quarters inside a city",
  },
  {
    level: 11,
    label: "Level 11: Sub-ward",
    defaultName: "Sub-ward",
    description: "Neighbourhood subdivisions or blocks",
  },
  {
    level: 12,
    label: "Level 12: Block / Sub-neighbourhood",
    defaultName: "Block",
    description: "Finest administrative subdivisions (blocks, sectors)",
  },
];

export interface LineLayerPreset {
  id: string;
  name: string;
  label: string;
  osmFilter: string;
  defaultEnabledFor: readonly FeatureEnabledFor[];
  color: string;
  description: string;
}

export const LINE_LAYER_PRESETS: readonly LineLayerPreset[] = [
  {
    id: "rail-line",
    name: "Rail Line",
    label: "Rail Lines (main & branch)",
    osmFilter: '["railway"="rail"]["usage"~"main|branch"]',
    defaultEnabledFor: ["measuring"],
    color: "#0ea5e9",
    description: "Measuring only by default (OSM rail segments are fragmented).",
  },
  {
    id: "metro-line",
    name: "Metro Line",
    label: "Metro / Subway Lines",
    osmFilter: '["railway"="subway"]',
    defaultEnabledFor: ["measuring"],
    color: "#8b5cf6",
    description: "Underground / metro tracks.",
  },
  {
    id: "river",
    name: "River",
    label: "Rivers",
    osmFilter: '["waterway"="river"]',
    defaultEnabledFor: ["measuring"],
    color: "#0284c7",
    description: "Major named rivers.",
  },
  {
    id: "coastline",
    name: "Coastline",
    label: "Coastline",
    osmFilter: '["natural"="coastline"]',
    defaultEnabledFor: ["measuring"],
    color: "#0891b2",
    description: "Sea / ocean coastline.",
  },
  {
    id: "international-border",
    name: "International Border",
    label: "International Border",
    osmFilter: '["boundary"="administrative"]["admin_level"="2"]',
    defaultEnabledFor: ["measuring"],
    color: "#e11d48",
    description: "National borders (admin_level=2).",
  },
];

export function getStationPreset(id: StationPresetId): StationPreset {
  return STATION_PRESETS.find((preset) => preset.id === id) ?? STATION_PRESETS[0];
}
