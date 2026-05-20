import { persistentAtom } from "@nanostores/persistent";

import {
    additionalMapGeoLocations,
    customStations,
    defaultUnit,
    disabledStations,
    displayHidingZones,
    displayHidingZonesOptions,
    displayHidingZonesStyle,
    hiderMode,
    hidingRadius,
    hidingRadiusUnits,
    hidingZoneFocusedStationID,
    includeDefaultStations,
    mapGeoLocation,
    permanentOverlay,
    polyGeoJSON,
    questions,
    useCustomStations,
} from "@/lib/context";
import type { CustomStation, OpenStreetMap } from "@/maps/api";
import { parseCustomStationsFromText } from "@/maps/api/importers";

const NORMALIZED_BASE = (import.meta.env.BASE_URL ?? "/").replace(
    /\/?$/,
    "/",
);

export interface GameDefinition {
    id: string;
    label: string;
    optionLabel: string; // shown in the "Select allowed places" dropdown
    sentinelValue: string; // unique value used in displayHidingZonesOptions
    kmlPath: string; // relative to BASE_URL
    mapLocation: OpenStreetMap;
    hidingRadius: number;
    hidingRadiusUnits: "miles" | "kilometers";
}

const LUXEMBOURG_COUNTRY: OpenStreetMap = {
    type: "Feature",
    geometry: {
        type: "Point",
        coordinates: [49.8158683, 6.1296751],
    },
    properties: {
        osm_type: "R",
        osm_id: 2171347,
        extent: [50.1827989, 5.7356988, 49.4478587, 6.5312481],
        country: "Luxembourg",
        osm_key: "place",
        countrycode: "LU",
        osm_value: "country",
        name: "Luxembourg",
        type: "country",
    },
};

export const LUXEMBOURG_2026: GameDefinition = {
    id: "luxembourg-2026",
    label: "Luxembourg 2026",
    optionLabel: "Luxembourg 2026",
    // Kept the original sentinel string so existing localStorage keeps working.
    sentinelValue: "__bundled-luxembourg-2026__",
    kmlPath: "luxembourg-hiding-zones.kml",
    mapLocation: LUXEMBOURG_COUNTRY,
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
};

export const GAMES: readonly GameDefinition[] = [LUXEMBOURG_2026];

export const GAME_SENTINELS: ReadonlySet<string> = new Set(
    GAMES.map((g) => g.sentinelValue),
);

export const currentGameId = persistentAtom<string>(
    "current-game-id",
    LUXEMBOURG_2026.id,
);

export function getGameById(id: string): GameDefinition | undefined {
    return GAMES.find((g) => g.id === id);
}

export function getGameBySentinel(value: string): GameDefinition | undefined {
    return GAMES.find((g) => g.sentinelValue === value);
}

const stationCache = new Map<string, CustomStation[]>();

async function loadGameStations(
    game: GameDefinition,
): Promise<CustomStation[]> {
    const cached = stationCache.get(game.id);
    if (cached) return cached;
    const url = `${NORMALIZED_BASE}${game.kmlPath}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`KML fetch failed for ${game.id}: ${res.status}`);
    }
    const text = await res.text();
    const stations = parseCustomStationsFromText(text, "kml");
    stationCache.set(game.id, stations);
    return stations;
}

// Sync-only settings that don't need a network round-trip. Safe to call from
// bootstrap so a game's map location and radius are restored on every load.
export function applyGameDefaults(game: GameDefinition): void {
    mapGeoLocation.set(game.mapLocation);
    if (polyGeoJSON.get() !== null) {
        polyGeoJSON.set(null);
    }
    defaultUnit.set(game.hidingRadiusUnits);
    hidingRadius.set(game.hidingRadius);
    hidingRadiusUnits.set(game.hidingRadiusUnits);
}

// Loads the game's KML stations and switches the app into custom-stations
// mode. Mode atoms are flipped synchronously so any concurrent reader sees
// consistent state; stations populate when the fetch resolves.
export function activateGameStations(game: GameDefinition): void {
    useCustomStations.set(true);
    includeDefaultStations.set(false);
    const cached = stationCache.get(game.id);
    if (cached) {
        customStations.set(cached);
        return;
    }
    loadGameStations(game)
        .then((stations) => {
            if (stations.length === 0) {
                console.warn("[games] 0 stations parsed for", game.id);
                return;
            }
            customStations.set(stations);
        })
        .catch((e) => {
            console.warn("[games] activation failed for", game.id, e);
        });
}

// Full game switch: clears questions and ephemeral game state, applies the
// new game's defaults, locks displayHidingZonesOptions to just this game's
// sentinel, loads stations, turns on display, focuses the All Zones view.
export function switchToGame(game: GameDefinition): void {
    questions.set([]);
    additionalMapGeoLocations.set([]);
    hiderMode.set(false);
    disabledStations.set([]);
    permanentOverlay.set(null);
    hidingZoneFocusedStationID.set("");

    applyGameDefaults(game);

    displayHidingZonesOptions.set([game.sentinelValue]);
    activateGameStations(game);
    displayHidingZones.set(true);
    displayHidingZonesStyle.set("zones");

    currentGameId.set(game.id);
}
