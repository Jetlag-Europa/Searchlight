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
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    findAdminBoundary,
    findPlacesInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import {
    holedMask,
    identityKey,
    modifyMapData,
    safeUnion,
    setBounded,
} from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import type {
    APILocations,
    CustomMatchingQuestion,
    HomeGameMatchingQuestions,
    MatchingQuestion,
    ZoneMatchingQuestions,
} from "@/maps/schema";

import { featuresMatch } from "./operators/tentacle";

export const findMatchingPlaces = async (question: MatchingQuestion) => {
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

// Manual memoize so we can skip caching undefined/false results, such as no
// places found: _.memoize would keep the empty result for good, while
// skipping it lets the next refresh retry.
const _matchingBoundaryCache = new Map<string, any>();
const MAX_CACHED_BOUNDARIES = 64;
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
        case "custom-points": {
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
        entirety: identityKey(polyGeoJSON.get() ?? mapGeoLocation.get()),
    });
    if (_matchingBoundaryCache.has(key)) return _matchingBoundaryCache.get(key);
    const result = await determineMatchingBoundaryInner(question);
    if (result !== undefined && result !== false)
        setBounded(_matchingBoundaryCache, key, result, MAX_CACHED_BOUNDARIES);
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
        ].includes(question.type)
    ) {
        const questionNearest = await nearestToQuestion(
            question as HomeGameMatchingQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            same: true,
            type: (question as HomeGameMatchingQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
            enabled: true,
        });

        question.same = featuresMatch(questionNearest, hiderNearest);
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

        const places = osmtogeojson(
            await findPlacesInZone(
                "[railway=station]",
                "Finding train stations. This may take a while. Do not press any buttons while this is processing. Don't worry, it will be cached.",
                "node",
            ),
        ) as FeatureCollection<Point>;

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
