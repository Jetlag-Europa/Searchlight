import type { DistanceUnit, FeatureEnabledFor } from "@searchlight/shared";

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
    defaultPoiIds: readonly string[];
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
        osmFilters: [
            '["railway"="station"]["station"="subway"]["disused"!="yes"]["abandoned"!="yes"]',
        ],
    },
    {
        id: "custom",
        label: "Custom Overpass filter",
        description: "Write your own OSM tag filter (e.g. [\"amenity\"=\"ferry_terminal\"]).",
        osmFilters: [],
    },
];

export const CREATOR_POI_CATALOG: readonly PoiCategoryPreset[] = [
    {
        id: "airport",
        name: "Airport",
        osmFilter: '["aeroway"="aerodrome"]["iata"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#0284c7",
        hint: "Commercial airports (requires IATA code)",
    },
    {
        id: "aquarium",
        name: "Aquarium",
        osmFilter: '["tourism"="aquarium"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#0891b2",
    },
    {
        id: "cinema",
        name: "Cinema",
        osmFilter: '["amenity"="cinema"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#9333ea",
    },
    {
        id: "consulate",
        name: "Consulate",
        osmFilter: '["diplomatic"="consulate"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#4f46e5",
    },
    {
        id: "golf_course",
        name: "Golf Course",
        osmFilter: '["leisure"="golf_course"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#15803d",
    },
    {
        id: "hospital",
        name: "Hospital",
        osmFilter: '["amenity"="hospital"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#dc2626",
    },
    {
        id: "library",
        name: "Library",
        osmFilter: '["amenity"="library"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#d97706",
    },
    {
        id: "mountain",
        name: "Mountain",
        osmFilter: '["natural"="peak"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#78716c",
        noisyInOsm: true,
        hint: "Can include small hills; try Notable only",
    },
    {
        id: "museum",
        name: "Museum",
        osmFilter: '["tourism"="museum"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#e11d48",
        noisyInOsm: true,
    },
    {
        id: "park",
        name: "Park",
        osmFilter: '["leisure"="park"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#16a34a",
        noisyInOsm: true,
        hint: "OSM includes small neighborhood parks; try Notable only",
    },
    {
        id: "theme_park",
        name: "Theme Park",
        osmFilter: '["tourism"="theme_park"]',
        defaultEnabledFor: ["matching", "measuring"],
        color: "#ea580c",
    },
    {
        id: "zoo",
        name: "Zoo",
        osmFilter: '["tourism"="zoo"]',
        defaultEnabledFor: ["matching", "measuring", "tentacle"],
        color: "#ca8a04",
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
        defaultPoiIds: ["cinema", "hospital", "library", "museum", "park"],
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
        defaultPoiIds: [
            "airport",
            "aquarium",
            "cinema",
            "golf_course",
            "hospital",
            "library",
            "museum",
            "park",
            "theme_park",
            "zoo",
        ],
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
        defaultPoiIds: [
            "airport",
            "aquarium",
            "consulate",
            "golf_course",
            "hospital",
            "library",
            "mountain",
            "museum",
            "theme_park",
            "zoo",
        ],
    },
};

export const CUSTOM_LAYER_COLORS = [
    "#0ea5e9",
    "#ec4899",
    "#8b5cf6",
    "#14b8a6",
    "#f97316",
    "#84cc16",
];

export interface AdminLevelPreset {
    level: number;
    label: string;
    defaultName: string;
    description: string;
}

export const ADMIN_LEVEL_PRESETS: readonly AdminLevelPreset[] = [
    {
        level: 4,
        label: "Level 4 — State / Province / Canton",
        defaultName: "Province",
        description: "1st-level subnational regions (states, cantons, provinces)",
    },
    {
        level: 6,
        label: "Level 6 — County / District",
        defaultName: "County",
        description: "Counties, départements, or large districts",
    },
    {
        level: 8,
        label: "Level 8 — Municipality / City",
        defaultName: "Municipality",
        description: "Cities, towns, and municipalities",
    },
    {
        level: 9,
        label: "Level 9 — Borough / Arrondissement",
        defaultName: "Borough",
        description: "City boroughs, arrondissements, or Kreise",
    },
    {
        level: 10,
        label: "Level 10 — Ward / Neighbourhood",
        defaultName: "Ward",
        description: "Fine-grained wards or quarters inside a city",
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
    return (
        STATION_PRESETS.find((preset) => preset.id === id) ?? STATION_PRESETS[0]
    );
}
