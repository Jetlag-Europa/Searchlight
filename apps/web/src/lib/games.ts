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
    gamePOIData,
    hiderMode,
    hidingRadius,
    hidingRadiusUnits,
    hidingZoneFocusedStationID,
    includeDefaultStations,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    polyGeoJSON,
    tierRadiusOverrides,
    useCustomStations,
} from "@/lib/context";
import type { CustomStation, OpenStreetMap } from "@/maps/api";
import { parseCustomStationsFromText, parseGPX, parseKMLFolderPOI } from "@/maps/api/importers";
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
    tierRadiusOverrides?: Record<string, number> | null;
    kmlPOIFolders?: Record<string, string> | null;
    hidingZoneGpxPaths?: string[] | null;
    hidingZoneKmlPath?: string | null;
    serverId: string;
    serverName: string;
}

const GAME_KML_POI_FOLDERS: Record<string, Record<string, string>> = {
    "__bundled-brno-2026-v2__": {
        "5": "museum",
        "9": "train_station",
        "11": "airport",
        "12": "park",
        "13": "administrative",
        "14": "hospital",
        "15": "library",
        "20": "theme_park",
        "21": "zoo",
        "22": "golf_course",
        "23": "cinema",
        "25": "water",
        "26": "administrative",
    },
};

const GAME_HIDING_ZONE_GPX_PATHS: Record<string, string[]> = {};

const GAME_HIDING_ZONE_KML_PATHS: Record<string, string> = {
    "__bundled-brno-2026-v2__": "brno-stations-v2.kml",
};

// Server-fetched games. Populated by fetchGames() when a session/server is known.
export const gamesAtom = atom<GameDefinition[]>([]);
export const gamesLoadingAtom = atom<boolean>(false);

// The ID of the currently active game (from the active session).
// Legacy "current-game-id" key is intentionally not reused — IDs are now cuid strings from the DB.
export const currentGameId = persistentAtom<string>("taibled-current-game-id", "");

export async function fetchGames(serverId: string): Promise<GameDefinition[]> {
    gamesLoadingAtom.set(true);
    try {
        const [gamesRes, serversRes] = await Promise.all([
            fetch(`${API_BASE}/games?serverId=${serverId}`, { credentials: "include" }),
            fetch(`${API_BASE}/servers`, { credentials: "include" }),
        ]);
        if (!gamesRes.ok) throw new Error(`Failed to fetch games: ${gamesRes.status}`);
        const gamesData = await gamesRes.json() as { games: ServerGame[] };

        let serverName = serverId;
        if (serversRes.ok) {
            const serversData = await serversRes.json() as { servers: Array<{ id: string; name: string }> };
            serverName = serversData.servers.find((s) => s.id === serverId)?.name ?? serverId;
        }

        const defs = gamesData.games.map((g): GameDefinition => ({
            id: g.id,
            label: g.name,
            optionLabel: g.name,
            sentinelValue: g.sentinelValue,
            kmlPath: g.kmlPath,
            mapLocation: g.mapLocationJson as OpenStreetMap,
            hidingRadius: g.hidingRadius,
            hidingRadiusUnits: g.hidingRadiusUnits,
            tierRadiusOverrides: g.tierRadiusOverrides,
            kmlPOIFolders: GAME_KML_POI_FOLDERS[g.sentinelValue] ?? null,
            hidingZoneGpxPaths: GAME_HIDING_ZONE_GPX_PATHS[g.sentinelValue] ?? null,
            hidingZoneKmlPath: GAME_HIDING_ZONE_KML_PATHS[g.sentinelValue] ?? null,
            serverId: g.serverId,
            serverName,
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

    let stations: CustomStation[];

    if (game.hidingZoneGpxPaths?.length) {
        const all: CustomStation[] = [];
        for (const path of game.hidingZoneGpxPaths) {
            const url = `${NORMALIZED_BASE}${path}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`GPX fetch failed: ${url} (${res.status})`);
            all.push(...parseGPX(await res.text()));
        }
        stations = all;
        console.info(`[taibled:stations] loaded ${stations.length} stations from ${game.hidingZoneGpxPaths.length} GPX files for ${game.label}`);
    } else if (game.hidingZoneKmlPath) {
        const url = `${NORMALIZED_BASE}${game.hidingZoneKmlPath}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Stations KML fetch failed: ${url} (${res.status})`);
        stations = parseCustomStationsFromText(await res.text(), "kml");
        console.info(`[taibled:stations] loaded ${stations.length} stations from ${game.hidingZoneKmlPath} for ${game.label}`);
    } else {
        const url = `${NORMALIZED_BASE}${game.kmlPath}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`KML fetch failed for ${game.id}: ${res.status}`);
        stations = parseCustomStationsFromText(await res.text(), "kml");
    }

    stationCache.set(game.id, stations);
    return stations;
}

async function loadGamePOI(game: GameDefinition): Promise<void> {
    if (!game.kmlPOIFolders) return;
    const url = `${NORMALIZED_BASE}${game.kmlPath}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.warn("[taibled:poi] POI KML fetch failed for", game.id, res.status);
        return;
    }
    const poiByCategory = parseKMLFolderPOI(await res.text(), game.kmlPOIFolders);
    gamePOIData.set(poiByCategory);
    console.info(
        "[taibled:poi] loaded custom POI for", game.label, "-",
        Object.entries(poiByCategory).map(([k, v]) => `${k}:${v.length}`).join(", "),
    );
}

export function applyGameDefaults(game: GameDefinition): void {
    mapGeoJSON.set(null);
    mapGeoLocation.set(game.mapLocation);
    if (polyGeoJSON.get() !== null) {
        polyGeoJSON.set(null);
    }
    defaultUnit.set(game.hidingRadiusUnits);
    hidingRadius.set(game.hidingRadius);
    hidingRadiusUnits.set(game.hidingRadiusUnits);
    tierRadiusOverrides.set(game.tierRadiusOverrides ?? {});
    gamePOIData.set({});
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
    additionalMapGeoLocations.set([]);
    hiderMode.set(false);
    disabledStations.set([]);
    permanentOverlay.set(null);
    hidingZoneFocusedStationID.set("");

    applyGameDefaults(game);

    displayHidingZonesOptions.set([game.sentinelValue]);
    activateGameStations(game);
    loadGamePOI(game).catch((e) => console.warn("[games] loadGamePOI failed", e));
    displayHidingZones.set(true);
    displayHidingZonesStyle.set("zones");

    currentGameId.set(game.id);
}
