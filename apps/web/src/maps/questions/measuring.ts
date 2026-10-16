import * as turf from "@turf/turf";

import {
    hiderMode,
    mapGeoJSON,
    polyGeoJSON,
} from "@/lib/context";
import {
    arcBufferToPoint,
    holedMask,
    identityKey,
    modifyMapData,
    setBounded,
} from "@/maps/geo-utils";
import type { MeasuringQuestion } from "@/maps/schema";

/** The features a player-drawn measuring question measures to. */
const determineMeasuringBoundary = (question: MeasuringQuestion) => {
    if (question.type !== "custom-measure") return false;
    // Nothing drawn yet: nothing to measure to.
    const features = (question as any).geo?.features;
    if (!features?.length) return false;
    return turf.combine(turf.featureCollection(features)).features;
};

// Manual memoize so a failed worker request can be evicted: _.memoize would
// keep it for good, while evicting it lets the next refresh retry.
const _bufferedCache = new Map<string, any>();
const MAX_CACHED_BUFFERS = 64;
const bufferedDeterminer = async (question: MeasuringQuestion) => {
    const key = JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        // Each loaded game or revision has its own play area object.
        entirety: identityKey(polyGeoJSON.get()),
        geo: (question as any).geo,
    });
    if (_bufferedCache.has(key)) return _bufferedCache.get(key);

    const placeData = determineMeasuringBoundary(question);
    if (placeData === false) return false;

    const result = arcBufferToPoint(
        turf.featureCollection(placeData as any),
        question.lat,
        question.lng,
    );
    setBounded(_bufferedCache, key, result, MAX_CACHED_BUFFERS);
    // Don't keep a failed worker request cached forever.
    result.catch(() => {
        if (_bufferedCache.get(key) === result) _bufferedCache.delete(key);
    });
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
