import * as turf from "@turf/turf";
import type { Feature, MultiPolygon } from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";

const API_BASE = import.meta.env.PUBLIC_API_BASE as string;

// Front-end cache — keyed by adminLevel + rounded coords (~100 m grid).
const boundaryFetchCache = new Map<string, any>();

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
import { toast } from "react-toastify";

import {
    gamePOIData,
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    trainStations,
} from "@/lib/context";
import {
    fetchCoastline,
    findInternationalBordersInZone,
    findPlacesInZone,
    findPlacesSpecificInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    QuestionSpecificLocation,
} from "@/maps/api";
import {
    arcBufferToPoint,
    connectToSeparateLines,
    groupObjects,
    holedMask,
    modifyMapData,
} from "@/maps/geo-utils";
import type {
    APILocations,
    HomeGameMeasuringQuestions,
    MeasuringQuestion,
} from "@/maps/schema";

const highSpeedBase = _.memoize(
    (features: Feature[]) => {
        const grouped = groupObjects(features);

        const neighbored = grouped
            .map((group) => {
                return turf.multiLineString(
                    connectToSeparateLines(
                        group
                            .filter((x) => turf.getType(x) === "LineString")
                            .map((x) => x.geometry.coordinates),
                    ),
                );
            })
            .filter((x) => x.geometry.coordinates.length > 0);

        return turf.combine(
            turf.buffer(
                turf.simplify(turf.featureCollection(neighbored), {
                    tolerance: 0.001,
                }),
                0.001,
            )!,
        ).features[0];
    },
    (features) => `${JSON.stringify(features.map((x) => x.geometry))}`,
);

const bboxExtension = (
    bBox: [number, number, number, number],
    distance: number,
): [number, number, number, number] => {
    const buffered = turf.bbox(
        turf.buffer(turf.bboxPolygon(bBox), Math.abs(distance), {
            units: "miles",
        })!,
    );

    const originalDeltaLat = bBox[3] - bBox[1];
    const originalDeltaLng = bBox[2] - bBox[0];

    return [
        buffered[0] - originalDeltaLng,
        buffered[1] - originalDeltaLat,
        buffered[2] + originalDeltaLng,
        buffered[3] + originalDeltaLat,
    ];
};

export const determineMeasuringBoundary = async (
    question: MeasuringQuestion,
) => {
    const bBox = turf.bbox(mapGeoJSON.get()!);

    switch (question.type) {
        case "highspeed-measure-shinkansen": {
            const features = osmtogeojson(
                await findPlacesInZone(
                    "[highspeed=yes]",
                    "Finding high-speed lines...",
                    "nwr",
                    "geom",
                ),
            ).features;

            return [highSpeedBase(features)];
        }
        case "coastline": {
            const coastline = turf.lineToPolygon(
                await fetchCoastline(),
            ) as Feature<MultiPolygon>;

            const distanceToCoastline = turf.pointToPolygonDistance(
                turf.point([question.lng, question.lat]),
                coastline,
                {
                    units: "miles",
                    method: "geodesic",
                },
            );

            return [
                turf.difference(
                    turf.featureCollection([
                        turf.bboxPolygon(bBox),
                        turf.buffer(
                            turf.bboxClip(
                                coastline,
                                bBox
                                    ? bboxExtension(
                                          bBox as any,
                                          distanceToCoastline,
                                      )
                                    : [-180, -90, 180, 90],
                            ),
                            distanceToCoastline,
                            {
                                units: "miles",
                                steps: 64,
                            },
                        )!,
                    ]),
                )!,
            ];
        }
        case "airport": {
            const airportOverride = gamePOIData.get()["airport"];
            if (airportOverride?.length) {
                console.info(`[taibled:poi] measuring airport → ${airportOverride.length} custom`);
                return [
                    turf.combine(
                        turf.featureCollection(
                            airportOverride.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
                        ),
                    ).features[0],
                ];
            }
            return [
                turf.combine(
                    turf.featureCollection(
                        _.uniqBy(
                            (
                                await findPlacesInZone(
                                    '["aeroway"="aerodrome"]["iata"]', // Only commercial airports have IATA codes,
                                    "Finding airports...",
                                )
                            ).elements,
                            (feature: any) => feature.tags.iata,
                        ).map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        }
        case "international-border": {
            const data = await findInternationalBordersInZone();
            const features = osmtogeojson(data as object).features.filter(
                (f: any) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
            );
            if (!features.length) {
                toast.error("No international borders found in this game area.");
                return false;
            }
            console.info(`[taibled:border] international-border → ${features.length} border segments`);
            return [turf.combine(turf.featureCollection(features as any)).features[0]];
        }
        case "bern-canton": {
            const bernCantonBoundary = await findBoundaryFromAPI(question.lat, question.lng, 4);
            if (!bernCantonBoundary) {
                toast.error("No canton found at this point — must be inside the game area.");
                return false;
            }
            return [bernCantonBoundary];
        }
        case "rotterdam-rail":
        case "rotterdam-coastline": {
            // Bundled local LineString (HSL high-speed rail / Kustlijn coastline).
            const file =
                question.type === "rotterdam-rail"
                    ? "exter-rotterdam-hsl.geojson"
                    : "exter-rotterdam-coastline.geojson";
            const res = await fetch(import.meta.env.BASE_URL + file);
            const fc = await res.json();
            if (!fc.features?.length) return false;
            console.info(`[taibled:line] measuring ${question.type} → ${fc.features.length} line feature(s)`);
            return [turf.combine(turf.featureCollection(fc.features)).features[0]];
        }
        case "sl-camping":
        case "sl-mill":
        case "sl-mountain":
        case "sl-library":
        case "sl-museum":
        case "sl-golf_course":
        case "sl-cinema":
        case "sl-zoo":
        case "sl-theme_park":
        case "sl-hospital":
        case "sl-airport":
        case "sl-consulate":
        case "rotterdam-library":
        case "rotterdam-museum":
        case "rotterdam-hospital":
        case "rotterdam-zoo":
        case "rotterdam-cinema":
        case "rotterdam-golf_course":
        case "rotterdam-consulate":
        case "rotterdam-theme_park":
        case "rotterdam-airport":
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
        case "bern-airport": {
            const catMap: Record<string, string> = {
                "sl-camping": "camping", "sl-mill": "mill", "sl-mountain": "mountain",
                "sl-library": "library", "sl-museum": "museum", "sl-golf_course": "golf_course",
                "sl-cinema": "cinema", "sl-zoo": "zoo", "sl-theme_park": "theme_park",
                "sl-hospital": "hospital", "sl-airport": "airport", "sl-consulate": "consulate",
                "buch-museum": "museum", "buch-park": "park", "buch-library": "library",
                "buch-hospital": "hospital", "buch-cinema": "cinema", "buch-train_station": "train_station",
                "buch-zoo": "zoo", "buch-golf_course": "golf_course", "buch-airport": "airport",
                "buch-consulate": "consulate",
                "bern-cinema": "cinema", "bern-library": "library", "bern-museum": "museum",
                "bern-mountain": "mountain", "bern-park": "park", "bern-zoo": "zoo",
                "bern-hospital": "hospital", "bern-consulate": "consulate", "bern-theme_park": "theme_park",
                "bern-airport": "airport",
                "rotterdam-library": "library", "rotterdam-museum": "museum", "rotterdam-hospital": "hospital",
                "rotterdam-zoo": "zoo", "rotterdam-cinema": "cinema", "rotterdam-golf_course": "golf_course",
                "rotterdam-consulate": "consulate", "rotterdam-theme_park": "theme_park", "rotterdam-airport": "airport",
            };
            const slPOI = gamePOIData.get()[catMap[question.type]];
            if (!slPOI?.length) return false;
            console.info(`[taibled:poi] measuring ${question.type} → ${slPOI.length} custom`);
            return [
                turf.combine(
                    turf.featureCollection(
                        slPOI.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
                    ),
                ).features[0],
            ];
        }
        case "covrigarie": {
            const covrPOI = gamePOIData.get()["covrigarie"];
            if (!covrPOI?.length) return false;
            console.info(`[taibled:poi] measuring covrigarie → ${covrPOI.length} custom`);
            return [
                turf.combine(
                    turf.featureCollection(
                        covrPOI.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
                    ),
                ).features[0],
            ];
        }
        case "brno-water": {
            const waterPOI = gamePOIData.get()["water"];
            if (!waterPOI?.length) return [turf.multiPolygon([])];
            return [
                turf.combine(
                    turf.featureCollection(
                        waterPOI.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
                    ),
                ).features[0],
            ];
        }
        case "city":
            return [
                turf.combine(
                    turf.featureCollection(
                        (
                            await findPlacesInZone(
                                '[place=city]["population"~"^[1-9]+[0-9]{6}$"]', // The regex is faster than (if:number(t["population"])>1000000)
                                "Finding cities...",
                            )
                        ).elements.map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
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

            const poiOverride = gamePOIData.get()[location];
            if (poiOverride?.length) {
                console.info(`[taibled:poi] measuring ${question.type} → ${poiOverride.length} custom ${location}`);
                return [
                    turf.combine(
                        turf.featureCollection(
                            poiOverride.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
                        ),
                    ).features[0],
                ];
            }

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
                return [turf.multiPolygon([])];
            }

            if (data.elements.length >= 1000) {
                toast.error(
                    `Too many ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} found (${data.elements.length}). Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [turf.multiPolygon([])];
            }

            return [
                turf.combine(
                    turf.featureCollection(
                        data.elements.map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        }
        case "custom-measure":
            return turf.combine(
                turf.featureCollection((question as any).geo.features),
            ).features;
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
        case "mcdonalds":
        case "seven11":
        case "rail-measure":
            return false;
    }
};

const bufferedDeterminer = _.memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);

        if (placeData === false || placeData === undefined) return false;

        return arcBufferToPoint(
            turf.featureCollection(placeData as any),
            question.lat,
            question.lng,
        );
    },
    (question) =>
        JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
            geo: (question as any).geo,
        }),
);

export const adjustPerMeasuring = async (
    question: MeasuringQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const buffer = await bufferedDeterminer(question);

    if (buffer === false) return mapData;

    return modifyMapData(mapData, buffer, question.hiderCloser);
};

export const hiderifyMeasuring = async (question: MeasuringQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    if (question.type === "international-border") {
        const data = await findInternationalBordersInZone();
        const features = osmtogeojson(data as object).features.filter(
            (f: any) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
        );
        if (!features.length) return question;
        const combined = turf.simplify(
            turf.combine(turf.featureCollection(features as any)).features[0] as any,
            { tolerance: 0.005 },
        );
        const borderPts = turf.explode(combined as any);
        const seekerPt = turf.point([question.lng, question.lat]);
        const hiderPt  = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const seekerNearest = turf.nearestPoint(seekerPt, borderPts);
        const hiderNearest  = turf.nearestPoint(hiderPt,  borderPts);
        question.hiderCloser =
            (hiderNearest.properties.distanceToPoint ?? Infinity) <
            (seekerNearest.properties.distanceToPoint ?? Infinity);
        return question;
    }

    if (question.type === "bern-canton") {
        const cantonBoundary = await findBoundaryFromAPI(question.lat, question.lng, 4);
        if (!cantonBoundary) return question;
        // explode handles Polygon, MultiPolygon, and any other geometry type
        const borderPts = turf.explode(cantonBoundary as any);
        const seekerPt = turf.point([question.lng, question.lat]);
        const hiderPt = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const seekerNearest = turf.nearestPoint(seekerPt, borderPts);
        const hiderNearest = turf.nearestPoint(hiderPt, borderPts);
        question.hiderCloser = (hiderNearest.properties.distanceToPoint ?? Infinity) < (seekerNearest.properties.distanceToPoint ?? Infinity);
        return question;
    }

    if (question.type === "rotterdam-rail" || question.type === "rotterdam-coastline") {
        const file =
            question.type === "rotterdam-rail"
                ? "exter-rotterdam-hsl.geojson"
                : "exter-rotterdam-coastline.geojson";
        const res = await fetch(import.meta.env.BASE_URL + file);
        const fc = await res.json();
        if (!fc.features?.length) return question;
        const combined = turf.combine(turf.featureCollection(fc.features)).features[0];
        const linePts = turf.explode(combined as any);
        const seekerPt = turf.point([question.lng, question.lat]);
        const hiderPt = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const seekerNearest = turf.nearestPoint(seekerPt, linePts);
        const hiderNearest = turf.nearestPoint(hiderPt, linePts);
        question.hiderCloser =
            (hiderNearest.properties.distanceToPoint ?? Infinity) <
            (seekerNearest.properties.distanceToPoint ?? Infinity);
        return question;
    }

    const GAME_POI_TYPE_MAP: Record<string, string> = {
        "sl-camping": "camping", "sl-mill": "mill", "sl-mountain": "mountain",
        "sl-library": "library", "sl-museum": "museum", "sl-golf_course": "golf_course",
        "sl-cinema": "cinema", "sl-zoo": "zoo", "sl-theme_park": "theme_park",
        "sl-hospital": "hospital", "sl-airport": "airport", "sl-consulate": "consulate",
        "buch-museum": "museum", "buch-park": "park", "buch-library": "library",
        "buch-hospital": "hospital", "buch-cinema": "cinema", "buch-train_station": "train_station",
        "buch-zoo": "zoo", "buch-golf_course": "golf_course", "buch-airport": "airport",
        "buch-consulate": "consulate",
        "bern-cinema": "cinema", "bern-library": "library", "bern-museum": "museum",
        "bern-mountain": "mountain", "bern-park": "park", "bern-zoo": "zoo",
        "bern-hospital": "hospital", "bern-consulate": "consulate", "bern-theme_park": "theme_park",
        "bern-airport": "airport",
        "rotterdam-library": "library", "rotterdam-museum": "museum", "rotterdam-hospital": "hospital",
        "rotterdam-zoo": "zoo", "rotterdam-cinema": "cinema", "rotterdam-golf_course": "golf_course",
        "rotterdam-consulate": "consulate", "rotterdam-theme_park": "theme_park", "rotterdam-airport": "airport",
    };
    if (question.type in GAME_POI_TYPE_MAP) {
        const catMap = GAME_POI_TYPE_MAP;
        const slPOI = gamePOIData.get()[catMap[question.type]];
        if (slPOI?.length) {
            const pts = turf.featureCollection(slPOI.map((p) => turf.point([p.lon, p.lat], { name: p.name })));
            const seekerPt = turf.point([question.lng, question.lat]);
            const hiderPt = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
            const qn = turf.nearestPoint(seekerPt, pts);
            const hn = turf.nearestPoint(hiderPt, pts);
            question.hiderCloser = turf.distance(seekerPt, qn) > turf.distance(hiderPt, hn);
        }
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
        const poiOverride = gamePOIData.get()[(question as HomeGameMeasuringQuestions).type];

        let questionNearest, hiderNearest;
        if (poiOverride?.length) {
            const pts = turf.featureCollection(
                poiOverride.map((p) => turf.point([p.lon, p.lat], { name: p.name })),
            );
            const seekerPt = turf.point([question.lng, question.lat]);
            const hiderPt = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
            questionNearest = turf.nearestPoint(seekerPt, pts);
            hiderNearest = turf.nearestPoint(hiderPt, pts);
            questionNearest.properties.distanceToPoint = turf.distance(seekerPt, questionNearest);
            hiderNearest.properties.distanceToPoint = turf.distance(hiderPt, hiderNearest);
        } else {
            questionNearest = await nearestToQuestion(
                question as HomeGameMeasuringQuestions,
            );
            hiderNearest = await nearestToQuestion({
                lat: $hiderMode.latitude,
                lng: $hiderMode.longitude,
                hiderCloser: true,
                type: (question as HomeGameMeasuringQuestions).type,
                drag: false,
                color: "black",
                collapsed: false,
            });
        }

        question.hiderCloser =
            questionNearest.properties.distanceToPoint >
            hiderNearest.properties.distanceToPoint;

        return question;
    }

    if (question.type === "rail-measure") {
        const stations = trainStations.get();

        if (stations.length === 0) {
            return question;
        }

        const location = turf.point([question.lng, question.lat]);

        const nearestTrainStation = turf.nearestPoint(
            location,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const distance = turf.distance(location, nearestTrainStation);

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

        const hiderNearest = turf.nearestPoint(
            hider,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const hiderDistance = turf.distance(hider, hiderNearest);

        question.hiderCloser = hiderDistance < distance;
    }

    if (question.type === "mcdonalds" || question.type === "seven11") {
        const points = await findPlacesSpecificInZone(
            question.type === "mcdonalds"
                ? QuestionSpecificLocation.McDonalds
                : QuestionSpecificLocation.Seven11,
        );

        const seeker = turf.point([question.lng, question.lat]);
        const nearest = turf.nearestPoint(seeker, points as any);

        const distance = turf.distance(seeker, nearest, {
            units: "miles",
        });

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const hiderNearest = turf.nearestPoint(hider, points as any);

        const hiderDistance = turf.distance(hider, hiderNearest, {
            units: "miles",
        });

        question.hiderCloser = hiderDistance < distance;
        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    let feature = null;

    try {
        feature = holedMask((await adjustPerMeasuring(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMeasuring(question, {
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
        question.hiderCloser = !question.hiderCloser;
    }

    return question;
};

export const measuringPlanningPolygon = async (question: MeasuringQuestion) => {
    try {
        const buffered = await bufferedDeterminer(question);

        if (buffered === false) return false;

        return turf.polygonToLine(buffered);
    } catch {
        return false;
    }
};
