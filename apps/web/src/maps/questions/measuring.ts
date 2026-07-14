import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
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
import { categoryForQuestionType, getCustomPOIs } from "@/lib/poiOverride";
import { currentGameId, getGameById } from "@/lib/games";
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

// Games that ship a bundled international-border line (converted from a KML)
// instead of querying Overpass live. Keyed by game sentinel — add an entry to
// opt a game in; everything else falls back to the live proxy query.
const BUNDLED_BORDER_FILES: Record<string, string> = {
    "__bundled-south-limburg-2026__": "south-limburg-intl-border.geojson",
};

const bundledBorderFileForActiveGame = (): string | undefined => {
    const game = getGameById(currentGameId.get());
    return game ? BUNDLED_BORDER_FILES[game.sentinelValue] : undefined;
};

const fetchInternationalBorderOgFeatures = async (): Promise<any[] | false> => {
    const file = bundledBorderFileForActiveGame();
    if (file) {
        const res = await fetch(import.meta.env.BASE_URL + file);
        const fc = await res.json();
        if (!fc.features?.length) return false;
        console.info(`[taibled:border-og] bundled ${file} → ${fc.features.length} line feature(s)`);
        return fc.features;
    }
    // Generic: live international borders via the backend Overpass proxy
    // (LocalOverpass on dev, VPS-routed on prod).
    const data = await findInternationalBordersInZone();
    const features = osmtogeojson(data as object).features.filter(
        (f: any) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
    );
    if (!features.length) return false;
    console.info(`[taibled:border-og] overpass → ${features.length} border segments`);
    return features;
};

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
        case "international-border-og": {
            const features = await fetchInternationalBorderOgFeatures();
            if (!features) {
                toast.error("No international borders found in this game area.");
                return false;
            }
            return [turf.combine(turf.featureCollection(features as any)).features[0]];
        }
        case "bern-canton":
        case "zurich-canton": {
            // Swiss cantons are admin_level=4 in OSM.
            const cantonBoundary = await findBoundaryFromAPI(question.lat, question.lng, 4);
            if (!cantonBoundary) {
                toast.error("No canton found at this point — must be inside the game area.");
                return false;
            }
            // Measure distance to the canton BORDER (the ring), not the filled
            // polygon: a geodesic polygon→point distance is 0 when the seeker is
            // inside the canton, which collapses the buffer and renders nothing.
            // Simplify first — the raw OSM canton ring is ~8k points, and the
            // geodesic buffer over that is slow; ~55 m tolerance is plenty here.
            const simplifiedCanton = turf.simplify(
                cantonBoundary as Feature<Polygon | MultiPolygon>,
                { tolerance: 0.0005, highQuality: false },
            );
            const line = turf.polygonToLine(simplifiedCanton);
            return line.type === "FeatureCollection" ? line.features : [line];
        }
        case "rotterdam-rail":
        case "rotterdam-coastline":
        case "zurich-coastline":
        case "belgium-hsl":
        case "belgium-coastline": {
            // Bundled local LineString (HSL high-speed rail / coastline / lake coast).
            const file =
                question.type === "rotterdam-rail"
                    ? "exter-rotterdam-hsl.geojson"
                    : question.type === "rotterdam-coastline"
                      ? "exter-rotterdam-coastline.geojson"
                      : question.type === "belgium-hsl"
                        ? "belgium-hsl.geojson"
                        : question.type === "belgium-coastline"
                          ? "belgium-coastline.geojson"
                          : "zurich-lake-coast.geojson";
            const res = await fetch(import.meta.env.BASE_URL + file);
            const fc = await res.json();
            if (!fc.features?.length) return false;
            console.info(`[taibled:line] measuring ${question.type} → ${fc.features.length} line feature(s)`);
            return [turf.combine(turf.featureCollection(fc.features)).features[0]];
        }
        case "budapest-water": {
            // Bodies of water are bundled separately (the importer skips a
            // "water" POI folder), so read the geojson directly.
            const res = await fetch(import.meta.env.BASE_URL + "budapest-water.geojson");
            const fc = await res.json();
            if (!fc.features?.length) return false;
            console.info(`[taibled:water] measuring budapest-water → ${fc.features.length} points`);
            return [turf.combine(turf.featureCollection(fc.features)).features[0]];
        }
        case "sl-camping":
        case "sl-mill":
        case "buch-train_station":
        case "bern-mountain":
        case "budapest-castle":
        case "budapest-stadium":
        case "budapest-rail":
        case "belgium-castle": {
            const catMap: Record<string, string> = {
                "sl-camping": "camping", "sl-mill": "mill",
                "buch-train_station": "train_station",
                "bern-mountain": "mountain",
                "budapest-castle": "castle", "budapest-stadium": "stadium",
                "budapest-rail": "train_station",
                "belgium-castle": "castle",
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

            const overrideCategory = categoryForQuestionType(question.type) ?? location;
            const poiOverride = getCustomPOIs(overrideCategory);
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

// Manual memoize so we can skip caching `false` results — a `false` means the
// POI/boundary data wasn't loaded yet (gamePOIData still empty on first render).
// _.memoize would cache that `false` permanently, causing the question to stay
// invisible even after the data loads. By not caching `false` we allow the next
// refresh (triggered by the gamePOIData nanostore subscription in Map.tsx) to
// re-run and get the real result.
const _bufferedCache = new Map<string, any>();
const bufferedDeterminer = async (question: MeasuringQuestion) => {
    const key = JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        entirety: polyGeoJSON.get() ? polyGeoJSON.get() : mapGeoLocation.get(),
        geo: (question as any).geo,
    });
    if (_bufferedCache.has(key)) return _bufferedCache.get(key);

    const placeData = await determineMeasuringBoundary(question);
    if (placeData === false || placeData === undefined) return false;

    const result = arcBufferToPoint(
        turf.featureCollection(placeData as any),
        question.lat,
        question.lng,
    );
    _bufferedCache.set(key, result);
    return result;
};

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

    if (question.type === "international-border-og") {
        const features = await fetchInternationalBorderOgFeatures();
        if (!features) return question;
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

    if (question.type === "bern-canton" || question.type === "zurich-canton") {
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

    if (
        question.type === "rotterdam-rail" ||
        question.type === "rotterdam-coastline" ||
        question.type === "zurich-coastline" ||
        question.type === "budapest-water" ||
        question.type === "belgium-hsl" ||
        question.type === "belgium-coastline"
    ) {
        const file =
            question.type === "rotterdam-rail"
                ? "exter-rotterdam-hsl.geojson"
                : question.type === "rotterdam-coastline"
                  ? "exter-rotterdam-coastline.geojson"
                  : question.type === "budapest-water"
                    ? "budapest-water.geojson"
                    : question.type === "belgium-hsl"
                      ? "belgium-hsl.geojson"
                      : question.type === "belgium-coastline"
                        ? "belgium-coastline.geojson"
                        : "zurich-lake-coast.geojson";
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
        "sl-camping": "camping", "sl-mill": "mill",
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
        "budapest-castle": "castle", "budapest-stadium": "stadium", "budapest-rail": "train_station",
        "belgium-castle": "castle",
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
        const poiCategory =
            categoryForQuestionType(question.type) ??
            (question as HomeGameMeasuringQuestions).type;
        const poiOverride = getCustomPOIs(poiCategory);

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
                enabled: true,
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
