import type { FeatureCollection } from "geojson";
import { atom } from "nanostores";

import {
    additionalMapGeoLocations,
    customStations,
    disabledStations,
    displayHidingZones,
    displayHidingZonesOptions,
    displayHidingZonesStyle,
    gamePOIData,

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
    hidingRadiusUnits: "miles" | "kilometers" | "meters";
    tierRadiusOverrides?: Record<string, number> | null;
    kmlPOIFolders?: Record<string, string> | null;
    hidingZoneGpxPaths?: string[] | null;
    hidingZoneKmlPath?: string | null;
    hidingZoneGeoJsonPath?: string | null;
    mapBoundaryGeoJsonPath?: string | null;
    serverId: string;
    serverName: string;
    size: "small" | "medium" | "large";
}

export function zoneLabelMinZoom(size?: "small" | "medium" | "large"): number {
    switch (size) {
        case "large": return 11;
        case "medium": return 13;
        case "small": return 17;
        default: return 13;
    }
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
    "__bundled-bucharest-2026__": {
        "cinema":       "cinema",
        "consulate":    "consulate",
        "covrigarie":   "covrigarie",
        "hospital":     "hospital",
        "library":      "library",
        "museum":       "museum",
        "park":         "park",
        "zoo":          "zoo",
        "golf_course":  "golf_course",
        "theme_park":   "theme_park",
        "train_station":"train_station",
        "airport":      "airport",
    },
};

const GAME_HIDING_ZONE_GPX_PATHS: Record<string, string[]> = {};

const GAME_HIDING_ZONE_KML_PATHS: Record<string, string> = {
    "__bundled-brno-2026-v2__": "brno-stations-v2.kml",
    "__bundled-bucharest-2026__": "bucharest-stations.kml",
};

const GAME_MAP_BOUNDARY_GEOJSON_PATHS: Record<string, string> = {
    "__bundled-bucharest-2026__": "bucharest-border.geojson",
};

// Server-fetched games. Populated by fetchGames() when a session/server is known.
export const gamesAtom = atom<GameDefinition[]>([]);
export const gamesLoadingAtom = atom<boolean>(false);

const GAME_SS_KEY = "taibled-current-game-id";

// Tab-local game ID — sessionStorage so each tab tracks its own game independently.
export const currentGameId = atom<string>(
    typeof sessionStorage !== "undefined"
        ? (sessionStorage.getItem(GAME_SS_KEY) ?? "")
        : ""
);

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
            hidingZoneGeoJsonPath: g.hidingZoneGeoJsonPath ?? null,
            mapBoundaryGeoJsonPath: GAME_MAP_BOUNDARY_GEOJSON_PATHS[g.sentinelValue] ?? null,
            serverId: g.serverId,
            serverName,
            size: (g.size as "small" | "medium" | "large") ?? "medium",
        }));

        gamesAtom.set(defs);

        // Pre-fetch custom map boundaries into cache so switchToGame can apply them synchronously
        for (const def of defs) {
            if (def.mapBoundaryGeoJsonPath && !mapBoundaryCache.has(def.id)) {
                fetch(`${NORMALIZED_BASE}${def.mapBoundaryGeoJsonPath}`)
                    .then((r) => r.ok ? r.json() : Promise.reject(r.status))
                    .then((geojson: FeatureCollection) => {
                        mapBoundaryCache.set(def.id, geojson);
                        console.info("[taibled:boundary] pre-cached boundary for", def.label);
                    })
                    .catch((e) => console.warn("[taibled:boundary] pre-cache failed for", def.label, e));
            }
        }

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
const mapBoundaryCache = new Map<string, FeatureCollection>();

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

async function loadGamePolyGeoJSON(game: GameDefinition): Promise<void> {
    if (!game.hidingZoneGeoJsonPath) return;
    const url = `${NORMALIZED_BASE}${game.hidingZoneGeoJsonPath}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.warn("[taibled:zones] poly GeoJSON fetch failed for", game.id, res.status);
        return;
    }
    const geojson = await res.json() as FeatureCollection;
    polyGeoJSON.set(geojson);
    console.info("[taibled:zones] loaded polygon zone for", game.label);
}

async function loadMapBoundaryGeoJSON(game: GameDefinition): Promise<void> {
    if (!game.mapBoundaryGeoJsonPath) return;
    const cached = mapBoundaryCache.get(game.id);
    if (cached) {
        polyGeoJSON.set(cached);
        console.info("[taibled:boundary] applied cached boundary for", game.label);
        return;
    }
    const url = `${NORMALIZED_BASE}${game.mapBoundaryGeoJsonPath}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.warn("[taibled:boundary] boundary GeoJSON fetch failed for", game.id, res.status);
        return;
    }
    const geojson = await res.json() as FeatureCollection;
    mapBoundaryCache.set(game.id, geojson);
    polyGeoJSON.set(geojson);
    console.info("[taibled:boundary] loaded custom map boundary for", game.label);
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
    // Polygon-based games load polyGeoJSON async; clear it now so old polygon doesn't linger until the new one arrives
    if (polyGeoJSON.get() !== null) {
        polyGeoJSON.set(null);
    }
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
    disabledStations.set([]);
    permanentOverlay.set(null);
    hidingZoneFocusedStationID.set("");

    applyGameDefaults(game);

    displayHidingZonesOptions.set([game.sentinelValue]);

    if (game.hidingZoneGeoJsonPath) {
        // Polygon-based game (e.g. Paris): the GeoJSON boundary IS the hiding zone; no KML stations
        useCustomStations.set(true);
        includeDefaultStations.set(false);
        customStations.set([]);
        loadGamePolyGeoJSON(game).catch((e) => console.warn("[games] loadGamePolyGeoJSON failed", e));
    } else {
        activateGameStations(game);
        if (game.mapBoundaryGeoJsonPath) {
            // Custom boundary + KML stations (e.g. Bucharest): populate polyGeoJSON so zone
            // computation and rendering use the custom boundary instead of querying OSM.
            // Apply synchronously from cache if available, otherwise fetch async.
            const cached = mapBoundaryCache.get(game.id);
            if (cached) {
                polyGeoJSON.set(cached);
                console.info("[taibled:boundary] applied cached boundary for", game.label);
            } else {
                loadMapBoundaryGeoJSON(game).catch((e) => console.warn("[games] loadMapBoundaryGeoJSON failed", e));
            }
        }
    }

    loadGamePOI(game).catch((e) => console.warn("[games] loadGamePOI failed", e));
    displayHidingZones.set(true);
    displayHidingZonesStyle.set("zones");

    sessionStorage.setItem(GAME_SS_KEY, game.id);
    currentGameId.set(game.id);
}
