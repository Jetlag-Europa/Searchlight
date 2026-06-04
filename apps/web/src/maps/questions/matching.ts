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

// Calls the backend boundary endpoint which handles Overpass + DB caching.
// Returns a GeoJSON Feature (same shape as findAdminBoundary).
const findBoundaryFromAPI = async (lat: number, lng: number, adminLevel: number) => {
    const res = await fetch(
        `${API_BASE}/boundaries/by-point?lat=${lat}&lng=${lng}&adminLevel=${adminLevel}`,
        { credentials: "include" },
    );
    if (!res.ok) throw new Error(`Boundary API error: ${res.status}`);
    const data = await res.json();
    const geo = osmtogeojson(data as object);
    return geo.features?.[0];
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
import { holedMask, modifyMapData, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import { LUX_HOSPITALS, LUX_MOUNTAINS } from "@/maps/questions/luxData";
import type {
    APILocations,
    HomeGameMatchingQuestions,
    MatchingQuestion,
} from "@/maps/schema";

const MATCHING_POI_TO_CATEGORY: Record<string, string> = {
    "airport": "airport", "airport-full": "airport",
    "aquarium": "aquarium", "aquarium-full": "aquarium",
    "zoo": "zoo", "zoo-full": "zoo",
    "theme_park": "theme_park", "theme_park-full": "theme_park",
    "museum": "museum", "museum-full": "museum",
    "hospital": "hospital", "hospital-full": "hospital",
    "cinema": "cinema", "cinema-full": "cinema",
    "library": "library", "library-full": "library",
    "golf_course": "golf_course", "golf_course-full": "golf_course",
    "park": "park", "park-full": "park",
    "covrigarie": "covrigarie",
};

export const findMatchingPlaces = async (question: MatchingQuestion) => {
    const overrideCategory = MATCHING_POI_TO_CATEGORY[question.type];
    if (overrideCategory) {
        const override = gamePOIData.get()[overrideCategory];
        if (override?.length) {
            console.info(`[taibled:poi] ${question.type} → ${override.length} custom ${overrideCategory}`);
            return override.map((p) => turf.point([p.lon, p.lat], { name: p.name }));
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
            return question.geo!;
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
                `[${LOCATION_FIRST_TAG[location]}=${location}]`,
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

export const determineMatchingBoundary = _.memoize(
    async (question: MatchingQuestion) => {
        let boundary;

        switch (question.type) {
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
            case "covrigarie":
            case "same-first-letter-station":
            case "same-length-station":
            case "same-train-line": {
                return false;
            }
            case "custom-zone": {
                boundary = question.geo;
                break;
            }
            case "zone": {
                boundary = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
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
                const zone = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
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
                            `[admin_level=${question.cat.adminLevel}]["name:en"~"^${letter}.+"]`, // Regex is faster than filtering afterward
                            `Finding zones that start with the same letter (${letter})...`,
                            "relation",
                            "geom",
                            [
                                `[admin_level=${question.cat.adminLevel}]["name"~"^${letter}.+"]`,
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
                break;
            }
        }

        return boundary;
    },
    (question: MatchingQuestion & { geo?: unknown; cat?: unknown }) =>
        JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            cat: question.cat,
            geo: question.geo,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
        }),
);

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
            "covrigarie",
        ].includes(question.type)
    ) {
        const poiCategory = MATCHING_POI_TO_CATEGORY[question.type];
        const poiOverride = poiCategory ? gamePOIData.get()[poiCategory] : null;

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
