import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { safeUnion } from "@/maps/geo-utils";

import { cacheFetch, determineCache } from "./cache";
import { OVERPASS_CACHE_NS } from "./constants";
import { CacheType } from "./types";

const API_BASE = (import.meta.env?.PUBLIC_API_BASE ?? (typeof process !== "undefined" ? process.env.PUBLIC_API_BASE : "") ?? "") as string;

// Send the Overpass query to the backend proxy. The browser never hits public
// Overpass servers directly — the proxy forwards to LocalOverpass (self-hosted,
// possibly behind Cloudflare Access) with public servers as its own fallback.
// credentials: "include" carries the session cookie (the proxy requires auth).
const overpassProxyPost = (query: string): Promise<Response> =>
    fetch(`${API_BASE}/overpass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        credentials: "include",
    });

// Simplify before encoding into the poly: filter — complex boundaries
// (e.g. 1000+ point city outlines) produce queries too long for Overpass.
// 0.005° ≈ 500 m, accurate enough for zone filtering. Memoized per play area:
// simplify deep-clones the polygon, and this ran on every Overpass lookup.
const polyStringCache = new WeakMap<object, string>();
const overpassPolyString = (poly: object): string => {
    let polyStr = polyStringCache.get(poly);
    if (polyStr === undefined) {
        const simplified = turf.simplify(poly as any, {
            tolerance: 0.005,
            highQuality: false,
        }) as any;
        polyStr = turf
            .getCoords(simplified.features)
            .flatMap((polygon: any) => polygon.geometry.coordinates)
            .flat()
            .map((coord: number[]) => [coord[1], coord[0]].join(" "))
            .join(" ");
        polyStringCache.set(poly, polyStr);
    }
    return polyStr;
};

export const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
) => {
    // Stable per-query cache key (namespace only — not a request target).
    const cacheKey = `${OVERPASS_CACHE_NS}?data=${encodeURIComponent(query)}`;

    try {
        const cache = await determineCache(cacheType);
        const cached = await cache.match(cacheKey);
        if (cached?.ok) return await cached.clone().json();
    } catch {
        // Cache API unavailable — proceed to fetch.
    }

    const fetchPromise = overpassProxyPost(query);
    let response: Response | null = null;
    try {
        response = loadingText
            ? await toast.promise(fetchPromise, { pending: loadingText })
            : await fetchPromise;
    } catch {
        toast.error("Could not load data from Overpass (network error)", {
            toastId: "overpass-error",
        });
        return { elements: [] };
    }

    if (!response?.ok) {
        toast.error(
            `Could not load data from Overpass: ${response?.status} ${response?.statusText}`,
            { toastId: "overpass-error" },
        );
        return { elements: [] };
    }

    try {
        const cache = await determineCache(cacheType);
        await cache.put(cacheKey, response.clone());
    } catch {
        // Cache API unavailable — fine, result still returned below.
    }

    return await response.json();
};

export const determineGeoJSON = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
): Promise<any> => {
    const url = `${API_BASE}/boundaries/${osmTypeLetter}/${osmId}`;
    const response = await cacheFetch(
        url,
        "Loading map data...",
        CacheType.PERMANENT_CACHE,
        { credentials: "include" },
    );
    if (!response.ok) {
        throw new Error(`Boundary fetch failed: ${response.status}`);
    }
    const data = await response.json();
    const geo = osmtogeojson(data);
    return {
        ...geo,
        features: geo.features.filter(
            (feature: any) => feature.geometry.type !== "Point",
        ),
    };
};

export const findPlacesInZone = async (
    filter: string,
    loadingText?: string,
    searchType:
        | "node"
        | "way"
        | "relation"
        | "nwr"
        | "nw"
        | "wr"
        | "nr"
        | "area" = "nwr",
    outType: "center" | "geom" = "center",
    alternatives: string[] = [],
    timeoutDuration: number = 0,
) => {
    let query = "";
    const $polyGeoJSON = polyGeoJSON.get();
    if ($polyGeoJSON) {
        const polyStr = overpassPolyString($polyGeoJSON);
        query = `
[out:json]${timeoutDuration != 0 ? `[timeout:${timeoutDuration}]` : ""};
(
${searchType}${filter}(poly:"${polyStr}");
${
    alternatives.length > 0
        ? alternatives
              .map((alternative) => `${searchType}${alternative}(poly:"${polyStr}");`)
              .join("\n")
        : ""
}
);
out ${outType};
`;
    } else {
        const primaryLocation = mapGeoLocation.get();
        const additionalLocations = additionalMapGeoLocations
            .get()
            .filter((entry) => entry.added)
            .map((entry) => entry.location);
        const allLocations = [primaryLocation, ...additionalLocations];
        const relationToAreaBlocks = allLocations
            .map((loc, idx) => {
                const regionVar = `.region${idx}`;
                return `relation(${loc.properties.osm_id});map_to_area->${regionVar};`;
            })
            .join("\n");
        const searchBlocks = allLocations
            .map((_, idx) => {
                const regionVar = `area.region${idx}`;
                const altQueries =
                    alternatives.length > 0
                        ? alternatives
                              .map(
                                  (alt) => `${searchType}${alt}(${regionVar});`,
                              )
                              .join("\n")
                        : "";
                return `
            ${searchType}${filter}(${regionVar});
            ${altQueries}
          `;
            })
            .join("\n");
        query = `
        [out:json]${timeoutDuration !== 0 ? `[timeout:${timeoutDuration}]` : ""};
        ${relationToAreaBlocks}
        (
        ${searchBlocks}
        );
        out ${outType};
        `;
    }
    const data = await getOverpassData(
        query,
        loadingText,
        CacheType.ZONE_CACHE,
    );
    const subtractedEntries = additionalMapGeoLocations
        .get()
        .filter((e) => !e.added);
    const subtractedPolygons = subtractedEntries.map((entry) => entry.location);
    if (subtractedPolygons.length > 0 && data && data.elements) {
        const turfPolys = await Promise.all(
            subtractedPolygons.map(
                async (location) =>
                    turf.combine(
                        await determineGeoJSON(
                            location.properties.osm_id.toString(),
                            location.properties.osm_type,
                        ),
                    ).features[0],
            ),
        );
        data.elements = data.elements.filter((el: any) => {
            const lon = el.center ? el.center.lon : el.lon;
            const lat = el.center ? el.center.lat : el.lat;
            if (typeof lon !== "number" || typeof lat !== "number")
                return false;
            const pt = turf.point([lon, lat]);
            return !turfPolys.some((poly) =>
                turf.booleanPointInPolygon(pt, poly as any),
            );
        });
    }
    return data;
};

export const determineMapBoundaries = async () => {
    const mapGeoDatum = await Promise.all(
        [
            {
                location: mapGeoLocation.get(),
                added: true,
                base: true,
            },
            ...additionalMapGeoLocations.get(),
        ].map(async (location) => ({
            added: location.added,
            data: await determineGeoJSON(
                location.location.properties.osm_id.toString(),
                location.location.properties.osm_type,
            ).catch(() => null),
        })),
    );

    const addedFeatures = mapGeoDatum
        .filter((x) => x.added && x.data)
        .flatMap((x) => x.data!.features);

    if (addedFeatures.length === 0) {
        throw new Error("No boundary data returned from Overpass");
    }

    let mapGeoData = turf.featureCollection([
        safeUnion(
            turf.featureCollection(addedFeatures) as any,
        ),
    ]);

    const differences = mapGeoDatum.filter((x) => !x.added).map((x) => x.data);

    if (differences.length > 0) {
        mapGeoData = turf.featureCollection([
            turf.difference(
                turf.featureCollection([
                    mapGeoData.features[0],
                    ...differences.flatMap((x) => x.features),
                ]),
            )!,
        ]);
    }

    if (turf.coordAll(mapGeoData).length > 10000) {
        turf.simplify(mapGeoData, {
            tolerance: 0.0005,
            highQuality: true,
            mutate: true,
        });
    }

    return turf.combine(mapGeoData) as FeatureCollection<MultiPolygon>;
};
