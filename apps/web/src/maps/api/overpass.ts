import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { safeUnion } from "@/maps/geo-utils";

import { cacheFetch, determineCache } from "./cache";
import {
    LOCATION_FIRST_TAG,
    OVERPASS_API,
    OVERPASS_API_FALLBACK,
} from "./constants";
import type {
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
    QuestionSpecificLocation,
} from "./types";
import { CacheType } from "./types";

// POST helper so the query goes in the request body, avoiding URI-too-long (414)
// on large polygons. Cache key is still the GET URL for deduplication.
const overpassPost = (baseUrl: string, query: string): Promise<Response> =>
    fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
    });

export const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
) => {
    // Use the GET URL only as a cache key — actual requests use POST so large
    // poly: filters don't hit the URI-too-long (414) limit on either server.
    const cacheKey = `${OVERPASS_API}?data=${encodeURIComponent(query)}`;

    try {
        const cache = await determineCache(cacheType);
        const cached = await cache.match(cacheKey);
        if (cached?.ok) return await cached.clone().json();
    } catch {
        // Cache API unavailable — proceed to fetch.
    }

    const doFetch = (baseUrl: string) =>
        loadingText
            ? toast.promise(overpassPost(baseUrl, query), { pending: loadingText })
            : overpassPost(baseUrl, query);

    let response: Response | null = null;
    try {
        response = await doFetch(OVERPASS_API);
    } catch {
        // Primary threw (CORS / network) — try fallback.
    }

    if (!response?.ok) {
        try {
            response = await doFetch(OVERPASS_API_FALLBACK);
        } catch {
            toast.error("Could not load data from Overpass (network error)", {
                toastId: "overpass-error",
            });
            return { elements: [] };
        }
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

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

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

export const findTentacleLocations = async (
    question: EncompassingTentacleQuestionSchema,
    text: string = "Determining tentacle locations...",
) => {
    const query = `
[out:json][timeout:25];
nwr["${LOCATION_FIRST_TAG[question.locationType]}"="${question.locationType}"](around:${turf.convertLength(
        question.radius,
        question.unit,
        "meters",
    )}, ${question.lat}, ${question.lng});
out center;
    `;
    const data = await getOverpassData(query, text);
    const elements = data.elements;
    const response = turf.points([]);
    elements.forEach((element: any) => {
        if (!element.tags["name"] && !element.tags["name:en"]) return;
        if (element.lat && element.lon) {
            const name = element.tags["name:en"] ?? element.tags["name"];
            if (
                response.features.find(
                    (feature: any) => feature.properties.name === name,
                )
            )
                return;
            response.features.push(
                turf.point([element.lon, element.lat], { name }),
            );
        }
        if (!element.center || !element.center.lon || !element.center.lat)
            return;
        const name = element.tags["name:en"] ?? element.tags["name"];
        if (
            response.features.find(
                (feature: any) => feature.properties.name === name,
            )
        )
            return;
        response.features.push(
            turf.point([element.center.lon, element.center.lat], { name }),
        );
    });
    return response;
};

export const findAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
) => {
    // boundary=administrative excludes religious / electoral / etc. relations
    // that share an admin_level — e.g. the Archdiocese of Luxembourg is
    // tagged admin_level=6 with boundary=religious_administration and
    // would otherwise outrank Canton Luxembourg in the result order.
    const query = `
[out:json];
is_in(${latitude}, ${longitude})->.a;
rel(pivot.a)["admin_level"="${adminLevel}"]["boundary"="administrative"];
out geom;
    `;
    const data = await getOverpassData(query, "Determining matching zone...");
    const geo = osmtogeojson(data);
    return geo.features?.[0];
};

// Luxembourg's three districts were abolished in 2015 and are no longer
// stored as administrative relations in OSM, so we reconstruct them from
// their constituent cantons (admin_level=6).
const LUX_DISTRICT_BY_CANTON: Record<string, string> = {
    Clervaux: "Diekirch",
    Diekirch: "Diekirch",
    Redange: "Diekirch",
    Vianden: "Diekirch",
    Wiltz: "Diekirch",
    Echternach: "Grevenmacher",
    Grevenmacher: "Grevenmacher",
    Remich: "Grevenmacher",
    Capellen: "Luxembourg",
    "Esch-sur-Alzette": "Luxembourg",
    Luxembourg: "Luxembourg",
    Mersch: "Luxembourg",
};

const stripCantonPrefix = (name: string | undefined): string | undefined =>
    name?.replace(/^Canton\s+/i, "").trim();

export const findLuxembourgDistrictBoundary = async (
    latitude: number,
    longitude: number,
) => {
    const cantonFeature = await findAdminBoundary(latitude, longitude, 6);
    if (!cantonFeature) return undefined;
    const cantonName = stripCantonPrefix(cantonFeature.properties?.name);
    if (!cantonName) return undefined;
    const districtName = LUX_DISTRICT_BY_CANTON[cantonName];
    if (!districtName) return undefined;

    const siblingCantons = Object.entries(LUX_DISTRICT_BY_CANTON)
        .filter(([, d]) => d === districtName)
        .map(([c]) => c);

    const query = `
[out:json][timeout:60];
rel["ISO3166-1"="LU"][admin_level=2];
map_to_area->.lux;
rel(area.lux)["admin_level"="6"]["boundary"="administrative"];
out geom;
    `;
    const data = await getOverpassData(
        query,
        `Building Luxembourg ${districtName} district boundary...`,
    );
    const collection = osmtogeojson(data) as FeatureCollection<MultiPolygon>;
    const memberFeatures = collection.features.filter((f) => {
        const name = stripCantonPrefix(f.properties?.name);
        return !!name && siblingCantons.includes(name);
    });
    if (memberFeatures.length === 0) return undefined;

    return safeUnion({
        type: "FeatureCollection",
        features: memberFeatures,
    });
};

export const fetchCoastline = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/coastline50.geojson",
        "Fetching coastline data...",
        CacheType.PERMANENT_CACHE,
    );
    const data = await response.json();
    return data;
};

export const trainLineNodeFinder = async (node: string): Promise<number[]> => {
    const nodeId = node.split("/")[1];
    const tagQuery = `
[out:json];
node(${nodeId});
wr(bn);
out tags;
`;
    const tagData = await getOverpassData(tagQuery, "Finding train line...");
    const query = `
[out:json];
(
${tagData.elements
    .map((element: any) => {
        if (
            !element.tags.name &&
            !element.tags["name:en"] &&
            !element.tags.network
        )
            return "";
        let query = "";
        if (element.tags.name) query += `wr["name"="${element.tags.name}"];`;
        if (element.tags["name:en"])
            query += `wr["name:en"="${element.tags["name:en"]}"];`;
        if (element.tags["network"])
            query += `wr["network"="${element.tags["network"]}"];`;
        return query;
    })
    .join("\n")}
);
out geom;
`;
    const data = await getOverpassData(query, "Finding train lines...");
    const geoJSON = osmtogeojson(data);
    const nodes: number[] = [];
    geoJSON.features.forEach((feature: any) => {
        if (feature && feature.id && feature.id.startsWith("node")) {
            nodes.push(parseInt(feature.id.split("/")[1]));
        }
    });
    data.elements.forEach((element: any) => {
        if (element && element.type === "node") {
            nodes.push(element.id);
        } else if (element && element.type === "way") {
            nodes.push(...element.nodes);
        }
    });
    const uniqNodes = _.uniq(nodes);
    return uniqNodes;
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
        // Simplify before encoding into the URL poly: filter — complex boundaries
        // (e.g. 1000+ point city outlines) produce URLs too long for Overpass GET.
        // 0.005° ≈ 500 m, accurate enough for zone filtering.
        const simplified = turf.simplify($polyGeoJSON as any, { tolerance: 0.005, highQuality: false }) as typeof $polyGeoJSON;
        const polyStr = turf
            .getCoords(simplified.features)
            .flatMap((polygon: any) => polygon.geometry.coordinates)
            .flat()
            .map((coord: number[]) => [coord[1], coord[0]].join(" "))
            .join(" ");
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

export const findInternationalBordersInZone = async () => {
    const $polyGeoJSON = polyGeoJSON.get();
    let query: string;

    if ($polyGeoJSON) {
        const simplified = turf.simplify($polyGeoJSON as any, { tolerance: 0.005, highQuality: false });
        const polyStr = turf
            .getCoords(simplified.features)
            .flatMap((p: any) => p.geometry.coordinates)
            .flat()
            .map((c: number[]) => [c[1], c[0]].join(" "))
            .join(" ");
        query = `
[out:json][timeout:60];
relation["boundary"="administrative"]["admin_level"="2"](poly:"${polyStr}")->.countries;
way(r.countries)(poly:"${polyStr}");
out geom;
`;
    } else {
        const osmId = mapGeoLocation.get().properties.osm_id;
        query = `
[out:json][timeout:60];
relation(${osmId});map_to_area->.region;
relation["boundary"="administrative"]["admin_level"="2"](area.region)->.countries;
way(r.countries)(area.region);
out geom;
`;
    }

    return getOverpassData(query, "Finding international borders...", CacheType.ZONE_CACHE);
};

export const findPlacesSpecificInZone = async (
    location: `${QuestionSpecificLocation}`,
) => {
    const locations = (
        await findPlacesInZone(
            location,
            `Finding ${
                location === '["brand:wikidata"="Q38076"]'
                    ? "McDonald's"
                    : "7-Elevens"
            }...`,
        )
    ).elements;
    return turf.featureCollection(
        locations.map((x: any) =>
            turf.point([
                x.center ? x.center.lon : x.lon,
                x.center ? x.center.lat : x.lat,
            ]),
        ),
    );
};

export const nearestToQuestion = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    let radius = 30;
    let instances: any = { features: [] };
    while (instances.features.length === 0) {
        instances = await findTentacleLocations(
            {
                lat: question.lat,
                lng: question.lng,
                radius: radius,
                unit: "miles",
                location: false,
                locationType: question.type,
                drag: false,
                color: "black",
                collapsed: false,
            },
            "Finding matching locations...",
        );
        radius += 30;
    }
    const questionPoint = turf.point([question.lng, question.lat]);
    return turf.nearestPoint(questionPoint, instances as any);
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
