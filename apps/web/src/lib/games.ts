import { atom } from "nanostores";
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
import type { Game as ServerGame } from "@taibled/shared";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

const NORMALIZED_BASE = (import.meta.env.BASE_URL ?? "/").replace(
    /\/?$/,
    "/",
);

export interface GameDefinition {
    id: string;
    label: string;
    optionLabel: string;
    sentinelValue: string;
    kmlPath: string;
    mapLocation: OpenStreetMap;
    hidingRadius: number;
    hidingRadiusUnits: "miles" | "kilometers";
}

// Server-fetched games. Populated by fetchGames() when a session/server is known.
export const gamesAtom = atom<GameDefinition[]>([]);
export const gamesLoadingAtom = atom<boolean>(false);

// The ID of the currently active game (from the active session).
// Legacy "current-game-id" key is intentionally not reused — IDs are now cuid strings from the DB.
export const currentGameId = persistentAtom<string>("taibled-current-game-id", "");

export async function fetchGames(serverId: string): Promise<GameDefinition[]> {
    gamesLoadingAtom.set(true);
    try {
        const res = await fetch(`${API_BASE}/games?serverId=${serverId}`, {
            credentials: "include",
        });
        if (!res.ok) throw new Error(`Failed to fetch games: ${res.status}`);
        const data = await res.json() as { games: ServerGame[] };

        const defs = data.games.map((g): GameDefinition => ({
            id: g.id,
            label: g.name,
            optionLabel: g.name,
            sentinelValue: g.sentinelValue,
            kmlPath: g.kmlPath,
            mapLocation: g.mapLocationJson as OpenStreetMap,
            hidingRadius: g.hidingRadius,
            hidingRadiusUnits: g.hidingRadiusUnits,
        }));

        gamesAtom.set(defs);
        return defs;
    } finally {
        gamesLoadingAtom.set(false);
    }
}

// Derive the sentinel set from the live games atom.
export function getGameSentinels(): ReadonlySet<string> {
    return new Set(gamesAtom.get().map((g) => g.sentinelValue));
}

export function getGameById(id: string): GameDefinition | undefined {
    return gamesAtom.get().find((g) => g.id === id);
}

export function getGameBySentinel(value: string): GameDefinition | undefined {
    return gamesAtom.get().find((g) => g.sentinelValue === value);
}

const stationCache = new Map<string, CustomStation[]>();

async function loadGameStations(game: GameDefinition): Promise<CustomStation[]> {
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

export function applyGameDefaults(game: GameDefinition): void {
    mapGeoLocation.set(game.mapLocation);
    if (polyGeoJSON.get() !== null) {
        polyGeoJSON.set(null);
    }
    defaultUnit.set(game.hidingRadiusUnits);
    hidingRadius.set(game.hidingRadius);
    hidingRadiusUnits.set(game.hidingRadiusUnits);
}

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
