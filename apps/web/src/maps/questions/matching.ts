import * as turf from "@turf/turf";

import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    holedMask,
    identityKey,
    modifyMapData,
    setBounded,
} from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
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

export const determineMatchingBoundary = async (question: MatchingQuestion) => {
    const key = JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        geo: question.geo,
        entirety: identityKey(polyGeoJSON.get() ?? mapGeoLocation.get()),
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
