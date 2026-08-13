import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    gamePOIData,
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Front-end cache for boundary lookups — keyed by adminLevel + rounded coords (~100 m grid).
// Avoids repeated backend/Overpass calls for the same canton or Bezirk.
const boundaryFetchCache = new Map<string, any>();

// Calls the backend boundary endpoint which handles Overpass + DB caching.
// Returns a GeoJSON Feature (same shape as findAdminBoundary).
const findBoundaryFromAPI = async (lat: number, lng: number, adminLevel: number) => {
    const cacheKey = `${adminLevel}-${lat.toFixed(3)}-${lng.toFixed(3)}`;
    if (boundaryFetchCache.has(cacheKey)) {
        console.info(`[taibled:boundary] cache hit level=${adminLevel} key=${cacheKey}`);
        return boundaryFetchCache.get(cacheKey);
    }
    const res = await fetch(
        `${API_BASE}/boundaries/by-point?lat=${lat}&lng=${lng}&adminLevel=${adminLevel}`,
        { credentials: "include" },
    );
    if (!res.ok) throw new Error(`Boundary API error: ${res.status}`);
    const data = await res.json();
    const geo = osmtogeojson(data as object);
    const feature = geo.features?.[0];
    if (feature) boundaryFetchCache.set(cacheKey, feature);
    return feature;
};
import {
    findAdminBoundary,
    findLuxembourgDistrictBoundary,
    findPlacesInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import {
    categoryForQuestionType,
    customPOIPoints,
    getCustomPOIs,
} from "@/lib/poiOverride";
import { holedMask, modifyMapData, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import {
    BELGIUM_ADMIN_LABELS,
    findBelgiumAdminDivision,
} from "@/maps/questions/belgiumAdmin";
import { findGrazDistrict } from "@/maps/questions/grazAdmin";
import { findParisArrondissement } from "@/maps/questions/parisAdmin";
import { LUX_HOSPITALS, LUX_MOUNTAINS } from "@/maps/questions/luxData";
import type {
    APILocations,
    CustomMatchingQuestion,
    HomeGameMatchingQuestions,
    MatchingQuestion,
    ZoneMatchingQuestions,
} from "@/maps/schema";

export const findMatchingPlaces = async (question: MatchingQuestion) => {
    const overrideCategory = categoryForQuestionType(question.type);
    if (overrideCategory) {
        const pts = customPOIPoints(overrideCategory);
        if (pts) {
            console.info(`[taibled:poi] ${question.type} → ${pts.length} custom ${overrideCategory}`);
            return pts;
        }
    }

    switch (question.type) {
        case "airport": {
            return _.uniqBy(
                (
                    await findPlacesInZone(
                        '["aeroway"="aerodrome"]["iata"]', // Only commercial airports have IATA codes,
                        "Finding airports...",
                    )
                ).elements,
                (feature: any) => feature.tags.iata,
            ).map((x) =>
                turf.point([
                    x.center ? x.center.lon : x.lon,
                    x.center ? x.center.lat : x.lat,
                ]),
            );
        }
        case "major-city": {
            return (
                await findPlacesInZone(
                    '[place=city]["population"~"^[1-9]+[0-9]{6}$"]', // The regex is faster than (if:number(t["population"])>1000000)
                    "Finding cities...",
                )
            ).elements.map((x: any) =>
                turf.point([
                    x.center ? x.center.lon : x.lon,
                    x.center ? x.center.lat : x.lat,
                ]),
            );
        }
        case "custom-points": {
            return (question as CustomMatchingQuestion).geo!;
        }
        case "lux-mountains": {
            return LUX_MOUNTAINS.map((p) =>
                turf.point([p.lon, p.lat], { name: p.name }),
            );
        }
        case "lux-hospitals": {
            return LUX_HOSPITALS.map((p) =>
                turf.point([p.lon, p.lat], { name: p.name }),
            );
        }
        case "aquarium-full":
        case "zoo-full":
        case "theme_park-full":
        case "peak-full":
        case "museum-full":
        case "hospital-full":
        case "cinema-full":
        case "library-full":
        case "golf_course-full":
        case "consulate-full":
        case "park-full": {
            const location = question.type.split("-full")[0] as APILocations;

            const data = await findPlacesInZone(
                `[${LOCATION_FIRST_TAG[location as keyof typeof LOCATION_FIRST_TAG]}=${location}]`,
                `Finding ${prettifyLocation(location, true).toLowerCase()}...`,
                "nwr",
                "center",
                [],
                60,
            );

            if (data.remark && data.remark.startsWith("runtime error")) {
                toast.error(
                    `Error finding ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()}. Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [];
            }

            if (data.elements.length >= 1000) {
                toast.error(
                    `Too many ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} found (${data.elements.length}). Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [];
            }

            return data.elements.map((x: any) =>
                turf.point([
                    x.center ? x.center.lon : x.lon,
                    x.center ? x.center.lat : x.lat,
                ]),
            );
        }
    }
};

// Manual memoize so we can skip caching undefined/false results — those mean
// POI data (gamePOIData) wasn't loaded yet on first render. _.memoize would
// permanently cache the empty result; skipping it lets the next refresh
// (triggered by the gamePOIData subscription in Map.tsx) retry with real data.
const _matchingBoundaryCache = new Map<string, any>();
const determineMatchingBoundaryInner = async (question: MatchingQuestion) => {
        let boundary;

        switch (question.type as string) {
            case "aquarium":
            case "zoo":
            case "theme_park":
            case "peak":
            case "museum":
            case "hospital":
            case "cinema":
            case "library":
            case "golf_course":
            case "consulate":
            case "park":
            case "same-first-letter-station":
            case "same-length-station":
            case "same-train-line": {
                return false;
            }
            case "custom-zone": {
                boundary = (question as CustomMatchingQuestion).geo;
                break;
            }
            case "zone": {
                boundary = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    (question as ZoneMatchingQuestions).cat.adminLevel,
                );

                if (!boundary) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }
                break;
            }
            case "lux-canton": {
                boundary = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    6,
                );
                if (!boundary) {
                    toast.error(
                        "No canton found at this point — must be inside Luxembourg.",
                    );
                    throw new Error("No canton found");
                }
                break;
            }
            case "lux-district": {
                boundary = await findLuxembourgDistrictBoundary(
                    question.lat,
                    question.lng,
                );
                if (!boundary) {
                    toast.error(
                        "No district found at this point — must be inside Luxembourg.",
                    );
                    throw new Error("No district found");
                }
                break;
            }
            case "brno-district": {
                // Brno city districts (části města) are admin_level=9 in OSM.
                // Result is cached server-side in BoundaryCache — Overpass only called on first hit per district.
                boundary = await findBoundaryFromAPI(question.lat, question.lng, 9);
                if (!boundary) {
                    toast.error(
                        "No district found at this point — must be inside Brno.",
                    );
                    throw new Error("No Brno district found");
                }
                break;
            }
            case "budapest-district": {
                // Budapest districts (kerület) are admin_level=9 in OSM. Served
                // via the backend proxy → LocalOverpass (cached in BoundaryCache).
                boundary = await findBoundaryFromAPI(question.lat, question.lng, 9);
                if (!boundary) {
                    toast.error(
                        "No district found at this point — must be inside Budapest.",
                    );
                    throw new Error("No Budapest district found");
                }
                break;
            }
            case "bern-canton": {
                // Swiss cantons are admin_level=4 in OSM.
                boundary = await findBoundaryFromAPI(question.lat, question.lng, 4);
                if (!boundary) {
                    toast.error(
                        "No canton found at this point — must be inside the game area.",
                    );
                    throw new Error("No Swiss canton found");
                }
                break;
            }
            case "bern-bezirk":
            case "zurich-bezirk": {
                // Swiss districts (Bezirke / Verwaltungskreise) are admin_level=6 in OSM.
                boundary = await findBoundaryFromAPI(question.lat, question.lng, 6);
                if (!boundary) {
                    toast.error(
                        "No Bezirk found at this point — must be inside the game area.",
                    );
                    throw new Error("No Swiss Bezirk found");
                }
                break;
            }
            case "south-limburg-postcode": {
                const res = await fetch(import.meta.env.BASE_URL + "south-limburg-postcodes.geojson");
                const fc = await res.json();
                const pt = turf.point([question.lng, question.lat]);
                boundary = fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
                if (!boundary) {
                    toast.error("No postcode found at this point — must be inside the game area.");
                    throw new Error("No South Limburg postcode found");
                }
                break;
            }
            case "south-limburg-municipality": {
                const res = await fetch(import.meta.env.BASE_URL + "south-limburg-municipalities.geojson");
                const fc = await res.json();
                const pt = turf.point([question.lng, question.lat]);
                boundary = fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
                if (!boundary) {
                    toast.error("No municipality found at this point — must be inside the game area.");
                    throw new Error("No South Limburg municipality found");
                }
                break;
            }
            case "rotterdam-municipality": {
                // Municipalities are bundled locally (exter-rotterdam-municipalities.geojson) — no Overpass.
                const res = await fetch(import.meta.env.BASE_URL + "exter-rotterdam-municipalities.geojson");
                const fc = await res.json();
                const pt = turf.point([question.lng, question.lat]);
                boundary = fc.features.find((f: any) => turf.booleanPointInPolygon(pt, f));
                if (!boundary) {
                    toast.error("No municipality found at this point — must be inside the game area.");
                    throw new Error("No Rotterdam municipality found");
                }
                break;
            }
            case "belgium-province":
            case "belgium-arrondissement": {
                // Belgium admin divisions are bundled locally — no Overpass.
                const label = BELGIUM_ADMIN_LABELS[question.type];
                boundary = await findBelgiumAdminDivision(
                    question.type,
                    question.lat,
                    question.lng,
                );
                if (!boundary) {
                    toast.error(`No ${label} found at this point — must be inside Belgium.`);
                    throw new Error(`No Belgium ${label} found`);
                }
                break;
            }
            case "graz-district": {
                // Graz districts are bundled locally — no Overpass.
                boundary = await findGrazDistrict(
                    question.type,
                    question.lat,
                    question.lng,
                );
                if (!boundary) {
                    toast.error("No district found at this point — must be inside Graz.");
                    throw new Error("No Graz district found");
                }
                break;
            }
            case "paris-arrondissement": {
                // Arrondissements are bundled locally — no Overpass. Inside the
                // play area this always resolves: the "Outer" region covers
                // everything beyond the 20.
                boundary = await findParisArrondissement(
                    question.type,
                    question.lat,
                    question.lng,
                );
                if (!boundary) {
                    toast.error(
                        "No arrondissement found at this point — must be inside the Paris play area.",
                    );
                    throw new Error("No Paris arrondissement found");
                }
                break;
            }
            case "london-borough": {
                // Boroughs are bundled locally (london-boroughs.geojson, from
                // OSM admin_level 8 + City of London at level 6) — no Overpass.
                const boroughRes = await fetch(
                    import.meta.env.BASE_URL + "london-boroughs.geojson",
                );
                const boroughFC = await boroughRes.json();
                const boroughPt = turf.point([question.lng, question.lat]);
                boundary = boroughFC.features.find((f: any) =>
                    turf.booleanPointInPolygon(boroughPt, f),
                );
                if (!boundary) {
                    toast.error(
                        "No borough found at this point — must be inside the game area.",
                    );
                    throw new Error("No London borough found");
                }
                break;
            }
            case "bucharest-sector": {
                // Sectors are bundled locally (bucharest-sectors.geojson) — no Overpass needed.
                const sectorsRes = await fetch(import.meta.env.BASE_URL + "bucharest-sectors.geojson");
                const sectorsFC = await sectorsRes.json();
                const seekPt = turf.point([question.lng, question.lat]);
                boundary = sectorsFC.features.find((f: any) =>
                    turf.booleanPointInPolygon(seekPt, f),
                );
                if (!boundary) {
                    toast.error(
                        "No sector found at this point — must be inside Bucharest.",
                    );
                    throw new Error("No Bucharest sector found");
                }
                break;
            }
            case "letter-zone": {
                const zoneQ = question as ZoneMatchingQuestions;
                const zone = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    zoneQ.cat.adminLevel,
                );

                if (!zone) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }

                let englishName = zone.properties?.["name:en"];

                if (!englishName) {
                    const name = zone.properties?.name;

                    if (/^[a-zA-Z]$/.test(name[0])) {
                        englishName = name;
                    } else {
                        toast.error("No English name found for this zone");
                        throw new Error("No English name");
                    }
                }

                const letter = englishName[0].toUpperCase();

                boundary = turf.featureCollection(
                    osmtogeojson(
                        await findPlacesInZone(
                            `[admin_level=${zoneQ.cat.adminLevel}]["name:en"~"^${letter}.+"]`, // Regex is faster than filtering afterward
                            `Finding zones that start with the same letter (${letter})...`,
                            "relation",
                            "geom",
                            [
                                `[admin_level=${zoneQ.cat.adminLevel}]["name"~"^${letter}.+"]`,
                            ], // Regex is faster than filtering afterward
                        ),
                    ).features.filter(
                        (x): x is Feature<Polygon | MultiPolygon> =>
                            x.geometry &&
                            (x.geometry.type === "Polygon" ||
                                x.geometry.type === "MultiPolygon"),
                    ),
                );

                // It's either simplify or crash. Technically this could be bad if someone's hiding zone was inside multiple zones, but that's unlikely.
                boundary = safeUnion(
                    turf.simplify(boundary, {
                        tolerance: 0.001,
                        highQuality: true,
                        mutate: true,
                    }),
                );

                break;
            }
            case "sl-camping":
            case "sl-mill":
            case "sl-library":
            case "sl-museum":
            case "sl-golf_course":
            case "sl-cinema":
            case "sl-zoo":
            case "sl-theme_park":
            case "sl-hospital":
            case "sl-airport":
            case "sl-consulate":
            case "buch-museum":
            case "buch-park":
            case "buch-library":
            case "buch-hospital":
            case "buch-cinema":
            case "buch-train_station":
            case "buch-zoo":
            case "buch-golf_course":
            case "buch-airport":
            case "buch-consulate":
            case "bern-cinema":
            case "bern-library":
            case "bern-museum":
            case "bern-mountain":
            case "bern-park":
            case "bern-zoo":
            case "bern-hospital":
            case "bern-consulate":
            case "bern-theme_park":
            case "bern-airport":
            case "rotterdam-library":
            case "rotterdam-museum":
            case "rotterdam-hospital":
            case "rotterdam-zoo":
            case "rotterdam-cinema":
            case "rotterdam-golf_course":
            case "rotterdam-consulate":
            case "rotterdam-theme_park":
            case "rotterdam-airport":
            case "covrigarie":
            case "budapest-castle":
            case "budapest-stadium":
            case "budapest-rail":
            case "belgium-castle":
            case "london-stadium":
            case "london-rail":
            case "airport":
            case "major-city":
            case "aquarium-full":
            case "zoo-full":
            case "theme_park-full":
            case "peak-full":
            case "museum-full":
            case "hospital-full":
            case "cinema-full":
            case "library-full":
            case "golf_course-full":
            case "consulate-full":
            case "park-full":
            case "custom-points":
            case "lux-mountains":
            case "lux-hospitals": {
                const data = await findMatchingPlaces(question);

                if (!data || data.length === 0) break;

                if (data.length === 1) {
                    boundary = turf.bboxPolygon([-180, -90, 180, 90]);
                    break;
                }

                const voronoi = geoSpatialVoronoi(data);
                const point = turf.point([question.lng, question.lat]);

                for (const feature of voronoi.features) {
                    if (!feature?.geometry) continue;
                    if (turf.booleanPointInPolygon(point, feature)) {
                        boundary = feature;
                        break;
                    }
                }

                if (!boundary) {
                    // geoSpatialVoronoi (spherical voronoi reprojected through
                    // Mercator) produces overlapping/gappy cells for tightly
                    // clustered POIs — e.g. 3 consulates within ~150 m — so the
                    // pin can land in no cell and the question silently stops
                    // cropping. Fall back to a planar voronoi clipped to a bbox
                    // covering the game area, the POIs and the pin, which tiles
                    // cleanly.
                    let [minX, minY, maxX, maxY] = turf.bbox(
                        turf.featureCollection([...data, point]),
                    );
                    const poly = polyGeoJSON.get();
                    if (poly) {
                        const [pa, pb, pc, pd] = turf.bbox(poly as any);
                        minX = Math.min(minX, pa);
                        minY = Math.min(minY, pb);
                        maxX = Math.max(maxX, pc);
                        maxY = Math.max(maxY, pd);
                    }
                    const padX = (maxX - minX) * 0.1 || 0.1;
                    const padY = (maxY - minY) * 0.1 || 0.1;
                    const planar = turf.voronoi(turf.featureCollection(data), {
                        bbox: [minX - padX, minY - padY, maxX + padX, maxY + padY],
                    });
                    for (const feature of planar.features ?? []) {
                        if (
                            feature?.geometry &&
                            turf.booleanPointInPolygon(point, feature)
                        ) {
                            boundary = feature;
                            break;
                        }
                    }
                }
                break;
            }
        }

        return boundary;
};

export const determineMatchingBoundary = async (
    question: MatchingQuestion & { geo?: unknown; cat?: unknown },
) => {
    const key = JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        cat: question.cat,
        geo: question.geo,
        entirety: polyGeoJSON.get() ? polyGeoJSON.get() : mapGeoLocation.get(),
    });
    if (_matchingBoundaryCache.has(key)) return _matchingBoundaryCache.get(key);
    const result = await determineMatchingBoundaryInner(question);
    if (result !== undefined && result !== false) _matchingBoundaryCache.set(key, result);
    return result;
};

export const adjustPerMatching = async (
    question: MatchingQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const boundary = await determineMatchingBoundary(question);

    if (boundary === false) {
        return mapData;
    }

    return modifyMapData(mapData, boundary, question.same);
};

export const hiderifyMatching = async (question: MatchingQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    if (
        [
            "aquarium",
            "zoo",
            "theme_park",
            "peak",
            "museum",
            "hospital",
            "cinema",
            "library",
            "golf_course",
            "consulate",
            "park",
            "budapest-castle",
            "budapest-stadium",
            "budapest-rail",
            "belgium-castle",
            "london-stadium",
            "london-rail",
        ].includes(question.type)
    ) {
        const poiCategory = categoryForQuestionType(question.type);
        const poiOverride = poiCategory ? getCustomPOIs(poiCategory) : null;

        let questionNearest, hiderNearest;
        if (poiOverride?.length) {
            const pts = turf.featureCollection(
                poiOverride.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
            );
            questionNearest = turf.nearestPoint(turf.point([question.lng, question.lat]), pts);
            hiderNearest = turf.nearestPoint(
                turf.point([$hiderMode.longitude, $hiderMode.latitude]),
                pts,
            );
        } else {
            questionNearest = await nearestToQuestion(
                question as HomeGameMatchingQuestions,
            );
            hiderNearest = await nearestToQuestion({
                lat: $hiderMode.latitude,
                lng: $hiderMode.longitude,
                same: true,
                type: (question as HomeGameMatchingQuestions).type,
                drag: false,
                color: "black",
                collapsed: false,
                enabled: true,
            });
        }

        question.same =
            questionNearest.properties.name === hiderNearest.properties.name;

        return question;
    }

    if (
        question.type === "same-first-letter-station" ||
        question.type === "same-length-station" ||
        question.type === "same-train-line"
    ) {
        const hiderPoint = turf.point([
            $hiderMode.longitude,
            $hiderMode.latitude,
        ]);
        const seekerPoint = turf.point([question.lng, question.lat]);

        const trainOverride = gamePOIData.get()["train_station"];
        let places: FeatureCollection<Point>;
        if (trainOverride?.length) {
            console.info(`[taibled:poi] train stations → ${trainOverride.length} custom`);
            places = turf.featureCollection(
                trainOverride.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
            ) as FeatureCollection<Point>;
        } else {
            places = osmtogeojson(
                await findPlacesInZone(
                    "[railway=station]",
                    "Finding train stations. This may take a while. Do not press any buttons while this is processing. Don't worry, it will be cached.",
                    "node",
                ),
            ) as FeatureCollection<Point>;
        }

        const nearestHiderTrainStation = turf.nearestPoint(hiderPoint, places);
        const nearestSeekerTrainStation = turf.nearestPoint(
            seekerPoint,
            places,
        );

        if (question.type === "same-train-line") {
            const nodes = await trainLineNodeFinder(
                nearestSeekerTrainStation.properties.id,
            );

            const hiderId = parseInt(
                nearestHiderTrainStation.properties.id.split("/")[1],
            );

            if (nodes.includes(hiderId)) {
                question.same = true;
            } else {
                question.same = false;
            }
        }

        const hiderEnglishName =
            nearestHiderTrainStation.properties["name:en"] ||
            nearestHiderTrainStation.properties.name;
        const seekerEnglishName =
            nearestSeekerTrainStation.properties["name:en"] ||
            nearestSeekerTrainStation.properties.name;

        if (!hiderEnglishName || !seekerEnglishName) {
            return question;
        }

        if (question.type === "same-first-letter-station") {
            if (
                hiderEnglishName[0].toUpperCase() ===
                seekerEnglishName[0].toUpperCase()
            ) {
                question.same = true;
            } else {
                question.same = false;
            }
        } else if (question.type === "same-length-station") {
            if (hiderEnglishName.length === seekerEnglishName.length) {
                question.lengthComparison = "same";
            } else if (hiderEnglishName.length < seekerEnglishName.length) {
                question.lengthComparison = "shorter";
            } else {
                question.lengthComparison = "longer";
            }
        }

        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    let feature = null;

    try {
        feature = holedMask((await adjustPerMatching(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMatching(question, {
                type: "FeatureCollection",
                features: [holedMask($mapGeoJSON)],
            });
        } catch {
            return question;
        }
    }

    if (feature === null || feature === undefined) return question;

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

    if (turf.booleanPointInPolygon(hiderPoint, feature)) {
        question.same = !question.same;
    }

    return question;
};

export const matchingPlanningPolygon = async (question: MatchingQuestion) => {
    try {
        const boundary = await determineMatchingBoundary(question);

        if (boundary === false) {
            return false;
        }

        return turf.polygonToLine(boundary);
    } catch {
        return false;
    }
};
