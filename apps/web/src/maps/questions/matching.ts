import * as turf from "@turf/turf";

import { hiderMode, mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    geoSpatialVoronoiSafe,
    holedMask,
    identityKey,
    modifyMapData,
    setBounded,
} from "@/maps/geo-utils";
import type { CustomMatchingQuestion, MatchingQuestion } from "@/maps/schema";

// Manual memoize so we can skip caching undefined results, such as a custom
// question with nothing drawn yet: _.memoize would keep the empty result for
// good, while skipping it lets the next refresh retry.
const _matchingBoundaryCache = new Map<string, any>();
const MAX_CACHED_BOUNDARIES = 64;
const determineMatchingBoundaryInner = async (question: MatchingQuestion) => {
    let boundary;

    switch (question.type) {
        case "custom-zone": {
            const geo = (question as CustomMatchingQuestion).geo;
            // An empty collection is a zone with nothing drawn yet.
            if (geo?.type === "FeatureCollection" && !geo.features?.length)
                break;
            boundary = geo;
            break;
        }
        case "custom-points": {
            const data = (question as CustomMatchingQuestion).geo;

            if (!data || data.length === 0) break;

            if (data.length === 1) {
                boundary = turf.bboxPolygon([-180, -90, 180, 90]);
                break;
            }

            const point = turf.point([question.lng, question.lat]);
            // Cells are drawn finely over the game area, the POIs and the pin.
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
            const voronoi = geoSpatialVoronoiSafe(
                turf.featureCollection(data),
                [minX - padX, minY - padY, maxX + padX, maxY + padY],
            );
            // The pin's cell is its nearest POI's, found by the cell's own site.
            const nearest = turf.nearestPoint(
                point,
                turf.featureCollection(
                    voronoi.features.map((cell) => cell.properties!.site),
                ),
            );
            boundary = voronoi.features[nearest.properties.featureIndex];
            break;
        }
    }

    return boundary;
};

export const determineMatchingBoundary = async (question: MatchingQuestion) => {
    const key = JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        geo: question.geo,
        // Each loaded game or revision has its own play area object.
        entirety: identityKey(polyGeoJSON.get()),
    });
    if (_matchingBoundaryCache.has(key)) return _matchingBoundaryCache.get(key);
    const result = await determineMatchingBoundaryInner(question);
    if (result !== undefined)
        setBounded(_matchingBoundaryCache, key, result, MAX_CACHED_BOUNDARIES);
    return result;
};

/**
 * How switching a matching question to a custom type starts. Only custom
 * points can be copied, into a custom zone (the seeker's cell); anything else
 * starts blank whatever the preference, as copying a game's layer could make
 * the session's questions too large to save.
 */
export const customSwitchStart = (
    from: string,
    to: "custom-zone" | "custom-points",
    preference: "ask" | "blank" | "prefill",
): "ask" | "blank" | "copy" => {
    if (from !== "custom-points" || to !== "custom-zone") return "blank";
    if (preference === "ask") return "ask";
    return preference === "prefill" ? "copy" : "blank";
};

export const adjustPerMatching = async (
    question: MatchingQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const boundary = await determineMatchingBoundary(question);
    // Nothing drawn yet: nothing to compare against.
    if (!boundary) return mapData;

    return modifyMapData(mapData, boundary, question.same);
};

export const hiderifyMatching = async (question: MatchingQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
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
        if (!boundary) return false;

        return turf.polygonToLine(boundary);
    } catch {
        return false;
    }
};
