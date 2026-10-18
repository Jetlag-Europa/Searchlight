import type { CatalogGame } from "@searchlight/shared";

import { GEOCODER_API } from "@/maps/api/constants";

/** A place the browser search resolved to, from the geocoder. */
export interface Place {
    name: string;
    /** The name with its region and country, for display. */
    label: string;
    lng: number;
    lat: number;
    /** [west, south, east, north], when the place is an area (a city, a country). */
    extent: [number, number, number, number] | null;
}

export interface CatalogMatch {
    game: CatalogGame;
    /** The game is played at the searched place (see isNearPlace). */
    near: boolean;
    /** The game's map center lies within the searched area, e.g. a country. */
    inPlace: boolean;
    /** Kilometres from the searched place to the game's map center. */
    distanceKm: number | null;
}

export type CatalogSort = "nearest" | "newest" | "name";

// A game is near a place within its bounds or this far from its center.
const NEAR_KM = 30;

// The kinds of Photon results that name a place, not an address or a shop.
const PLACE_TYPES = new Set([
    "city",
    "locality",
    "district",
    "county",
    "state",
    "country",
]);

const normalize = (text: string) =>
    text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function distanceKm(
    [lng1, lat1]: [number, number],
    [lng2, lat2]: [number, number],
): number {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const inBounds = (
    [lng, lat]: [number, number],
    [west, south, east, north]: [number, number, number, number],
) => lng >= west && lng <= east && lat >= south && lat <= north;

const words = (text: string) =>
    normalize(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);

/** Every word of the query starts a word of the game's name, server or key. */
export function matchesText(game: CatalogGame, query: string): boolean {
    const queryWords = words(query);
    if (queryWords.length === 0) return true;
    const gameWords = words(`${game.name} ${game.serverName} ${game.gameKey}`);
    return queryWords.every((q) => gameWords.some((w) => w.startsWith(q)));
}

/**
 * The game is played at the place: the place lies within the game's bounds or
 * near its center, or, for an area such as a country, the game's center lies
 * within it.
 */
export function isNearPlace(game: CatalogGame, place: Place): boolean {
    const point: [number, number] = [place.lng, place.lat];
    if (game.bounds && inBounds(point, game.bounds)) return true;
    if (place.extent && inBounds(game.center, place.extent)) return true;
    return distanceKm(point, game.center) <= NEAR_KM;
}

function matchPlace(
    game: CatalogGame,
    place: Place | null,
): Omit<CatalogMatch, "game"> {
    if (!place) return { near: false, inPlace: false, distanceKm: null };
    return {
        near: isNearPlace(game, place),
        inPlace: place.extent !== null && inBounds(game.center, place.extent),
        distanceKm: distanceKm([place.lng, place.lat], game.center),
    };
}

/**
 * The games the search finds, sorted, playable ones first. A game matches by
 * its name, server or key, or by being played at the place the query resolved
 * to.
 */
export function searchCatalog(
    games: CatalogGame[],
    {
        query,
        place,
        serverId,
        sort,
    }: {
        query: string;
        place: Place | null;
        serverId: string;
        sort: CatalogSort;
    },
): CatalogMatch[] {
    const matches = games
        .filter((game) => !serverId || game.serverId === serverId)
        .map((game): CatalogMatch => ({ game, ...matchPlace(game, place) }))
        .filter((match) => match.near || matchesText(match.game, query));

    const byName = (a: CatalogMatch, b: CatalogMatch) =>
        a.game.name.localeCompare(b.game.name);
    const compare: Record<
        CatalogSort,
        (a: CatalogMatch, b: CatalogMatch) => number
    > = {
        nearest: (a, b) =>
            (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) ||
            byName(a, b),
        newest: (a, b) =>
            b.game.updatedAt.localeCompare(a.game.updatedAt) || byName(a, b),
        name: byName,
    };
    // Games the user can play come first; those of servers they haven't
    // joined follow, in the same order.
    return matches.sort(
        (a, b) =>
            Number(a.game.locked) - Number(b.game.locked) ||
            compare[sort](a, b),
    );
}

interface PhotonFeature {
    geometry: { coordinates: [number, number] };
    properties: {
        name?: string;
        type?: string;
        state?: string;
        country?: string;
        extent?: [number, number, number, number];
    };
}

/** Photon results as places, dropping addresses, streets and POIs. */
export function photonPlaces(features: PhotonFeature[]): Place[] {
    return features
        .filter(
            (f) =>
                f.properties.name && PLACE_TYPES.has(f.properties.type ?? ""),
        )
        .map((f) => {
            const { name, state, country, extent } = f.properties;
            const [lng, lat] = f.geometry.coordinates;
            // An extent across the antimeridian (east < west) or around most
            // of the globe (Russia, the United States) can't be tested as a
            // box; such places match by distance alone.
            const usableExtent =
                extent &&
                extent[2] >= extent[0] &&
                extent[2] - extent[0] <= 180;
            const label = [name, state, country]
                .filter((part, i, parts) => part && parts.indexOf(part) === i)
                .join(", ");
            return {
                name: name!,
                label,
                lng,
                lat,
                // Photon's extent is [west, north, east, south].
                extent: usableExtent
                    ? [extent[0], extent[3], extent[2], extent[1]]
                    : null,
            };
        });
}

/** The place a search names, if any. */
export async function geocodePlace(
    query: string,
    signal?: AbortSignal,
): Promise<Place | null> {
    const url = `${GEOCODER_API}?q=${encodeURIComponent(query)}&limit=5&lang=en`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const { features } = (await res.json()) as { features: PhotonFeature[] };
    return photonPlaces(features)[0] ?? null;
}
