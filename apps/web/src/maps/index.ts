import type { Feature, FeatureCollection } from "geojson";

import {
    adjustPerMatching,
    hiderifyMatching,
    matchingPlanningPolygon,
} from "./questions/matching";
import {
    adjustPerMeasuring,
    hiderifyMeasuring,
    measuringPlanningPolygon,
} from "./questions/measuring";
import {
    adjustPerRadius,
    hiderifyRadius,
    radiusPlanningPolygon,
} from "./questions/radius";
import {
    adjustPerTentacle,
    hiderifyTentacles,
    tentaclesPlanningPolygon,
} from "./questions/tentacles";
import {
    adjustPerThermometer,
    hiderifyThermometer,
    thermometerPlanningPolygon,
} from "./questions/thermometer";
import type { Question, Questions } from "./schema";

export * from "./geo-utils";

export const hiderifyQuestion = async (question: Question) => {
    if (question.data.enabled === false) return null;
    if (question.data.drag) {
        switch (question.id) {
            case "radius":
                question.data = hiderifyRadius(question.data);
                break;
            case "thermometer":
                question.data = await hiderifyThermometer(question.data);
                break;
            case "tentacles":
                question.data = await hiderifyTentacles(question.data);
                break;
            case "matching":
                question.data = await hiderifyMatching(question.data);
                break;
            case "measuring":
                question.data = await hiderifyMeasuring(question.data);
                break;
        }
    }

    return question;
};

export const determinePlanningPolygon = async (
    question: Question,
    planningModeEnabled: boolean,
) => {
    if (planningModeEnabled && question.data.drag) {
        switch (question.id) {
            case "radius":
                return radiusPlanningPolygon(question.data);
            case "thermometer":
                return thermometerPlanningPolygon(question.data);
            case "tentacles":
                return tentaclesPlanningPolygon(question.data);
            case "matching":
                return matchingPlanningPolygon(question.data);
            case "measuring":
                return measuringPlanningPolygon(question.data);
        }
    }
};

export async function adjustMapGeoDataForQuestion(
    question: any,
    mapGeoData: any,
) {
    try {
        switch (question?.id) {
            case "radius":
                return await adjustPerRadius(question.data, mapGeoData);
            case "thermometer":
                return await adjustPerThermometer(question.data, mapGeoData);
            case "tentacles":
                if (question.data.location === false) {
                    return adjustPerRadius(
                        { ...question.data, within: false },
                        mapGeoData,
                    );
                }
                return await adjustPerTentacle(question.data, mapGeoData);
            case "matching":
                return await adjustPerMatching(question.data, mapGeoData);
            case "measuring":
                return await adjustPerMeasuring(question.data, mapGeoData);
            default:
                return mapGeoData;
        }
    } catch {
        return mapGeoData;
    }
}

/**
 * Compute each enabled question's standalone "still-possible" region by applying
 * that question — and only that question — to the full base game boundary.
 *
 * This is the basis for the per-question (dodge-aware) hiding-zone survival test:
 * a hider may move within their zone, so a zone is valid as long as it overlaps
 * EACH question's region independently. Folding all questions into a single
 * intersected area (as {@link applyQuestionsToMapGeoData} does) incorrectly
 * requires one point to satisfy every question at once. See [[DissapearingAct]].
 */
export async function computePerQuestionRegions(
    questions: Questions,
    baseMapGeoData: any,
    planningModeEnabled: boolean,
): Promise<{ question: Question; region: any }[]> {
    const regions: { question: Question; region: any }[] = [];

    for (const question of questions) {
        // `enabled` lives on most (not all) members of the question.data union;
        // narrow locally until the shared base type lands (see Bucket 1 cleanup).
        if ((question.data as { enabled?: boolean }).enabled === false) continue;
        if (planningModeEnabled && question.data.drag) continue;

        // Each question is evaluated against a fresh copy of the base boundary,
        // independent of the others.
        const base = structuredClone(baseMapGeoData);
        let region = await adjustMapGeoDataForQuestion(question, base);

        if (region && region.type !== "FeatureCollection") {
            region = {
                type: "FeatureCollection",
                features: [region],
            };
        }

        regions.push({ question, region });
    }

    return regions;
}

export async function applyQuestionsToMapGeoData(
    questions: Questions,
    mapGeoData: any,
    planningModeEnabled: boolean,
    planningModeCallback?: (
        polygon: FeatureCollection | Feature,
        question: any,
    ) => void,
): Promise<any> {
    for (const question of questions) {
        if (planningModeCallback) {
            const planningPolygon = await determinePlanningPolygon(
                question,
                planningModeEnabled,
            );
            if (planningPolygon) {
                planningModeCallback(planningPolygon, question);
            }
        }
        if (question.data.enabled === false) continue;
        if (planningModeEnabled && question.data.drag) {
            continue;
        }

        mapGeoData = await adjustMapGeoDataForQuestion(question, mapGeoData);

        if (mapGeoData.type !== "FeatureCollection") {
            mapGeoData = {
                type: "FeatureCollection",
                features: [mapGeoData],
            };
        }
    }
    return mapGeoData;
}
