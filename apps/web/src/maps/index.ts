import type { DistanceUnit, QuestionDefinition } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Point } from "geojson";

import { compiledGameAtom, isQuestionSupported } from "@/game-definition/store";
import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    trainStations,
} from "@/lib/context";

import { arcDistanceToPoint } from "./geo-utils";
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
import { evaluateQuestionOperator } from "./questions/operators/base";
import {
    containingRegion,
    geometrySource,
    nearestLine,
    regionLines,
} from "./questions/operators/geometry";
import { determineMatchingGeometry } from "./questions/operators/matching";
import {
    determineMeasuringGeometry,
    determineMeasuringTargets,
    isEmptyBuffer,
} from "./questions/operators/measuring";
import {
    determineTentacleGeometry,
    featuresMatch,
} from "./questions/operators/tentacle";
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

interface CompiledFeatureQuestionData {
    lat: number;
    lng: number;
    same?: boolean;
    hiderCloser?: boolean;
    location?: Feature<Point> | false;
    radius?: number;
    unit?: DistanceUnit;
}

export function resolveCompiledQuestion(question: any, compiled: any): any {
    if (!compiled || !question) return undefined;
    const family = question.id === "tentacles" ? "tentacle" : question.id;
    // Radar and thermometer questions carry no definition ID, and a game may
    // compile several radars (`radius-400`, `radius-600`), so match by family.
    if (family === "radius" || family === "thermometer") {
        for (const definition of compiled.questionMap.values()) {
            if (definition.family === family) return definition;
        }
        return undefined;
    }
    const id =
        family === "tentacle"
            ? question.data?.locationType
            : question.data?.type;
    const definition = compiled.questionMap.get(id ?? question.id);
    return definition?.family === family ? definition : undefined;
}

async function hiderifyCompiledQuestion(
    question: { data: CompiledFeatureQuestionData },
    questionDef: QuestionDefinition,
    datasets: Record<string, unknown>,
    hiderPos: { latitude: number; longitude: number },
) {
    const { data } = question;
    const evaluator = questionDef.evaluator;
    const source = geometrySource(evaluator, datasets, {});
    if (!source) return;
    const seekerPt = turf.point([data.lng, data.lat]);
    const hiderPt = turf.point([hiderPos.longitude, hiderPos.latitude]);

    if (questionDef.family === "matching") {
        if (evaluator.operator === "containing-region-match") {
            data.same =
                containingRegion(source.regions, seekerPt) ===
                containingRegion(source.regions, hiderPt);
        } else if (evaluator.operator === "nearest-feature-match") {
            if (source.lines.length) {
                const nearest = nearestLine(source.lines, seekerPt);
                data.same =
                    nearest !== undefined &&
                    nearest === nearestLine(source.lines, hiderPt);
            } else if (source.points.length) {
                const points = turf.featureCollection(source.points);
                data.same = featuresMatch(
                    turf.nearestPoint(seekerPt, points),
                    turf.nearestPoint(hiderPt, points),
                );
            }
        }
    } else if (questionDef.family === "measuring") {
        const targets = await determineMeasuringTargets({
            evaluator,
            datasets,
            data,
        });
        // Containing-region questions compare each person's own region boundary.
        const hiderTargets =
            evaluator.operator === "distance-to-containing-region-boundary"
                ? await determineMeasuringTargets({
                      evaluator,
                      datasets,
                      data: { lat: hiderPos.latitude, lng: hiderPos.longitude },
                  })
                : targets;
        // Answer with the geodetic distance the map's buffers are built from.
        // Turf's spherical distance differs by up to about 0.5%, enough to put
        // a hider near the buffer edge on the wrong side of it.
        const distance = async (
            point: Feature<Point>,
            features: typeof targets,
        ) => {
            if (!features?.features.length) return Infinity;
            return arcDistanceToPoint(
                features,
                point.geometry.coordinates[1],
                point.geometry.coordinates[0],
                "miles",
            );
        };
        data.hiderCloser =
            (await distance(hiderPt, hiderTargets)) <
            (await distance(seekerPt, targets));
    } else if (questionDef.family === "tentacle") {
        // Answer from the circle and sites the map is clipped with.
        const { circle, points } = await determineTentacleGeometry({
            evaluator,
            datasets,
            data: {
                ...data,
                radius: data.radius ?? 15,
                unit: data.unit ?? "miles",
            },
        });
        if (!turf.booleanPointInPolygon(hiderPt, circle) || !points.length) {
            data.location = false;
            return;
        }
        const nearest = turf.nearestPoint(
            hiderPt,
            turf.featureCollection(points),
        );
        data.location = {
            type: "Feature",
            geometry: nearest.geometry,
            id: nearest.id,
            properties: {
                ...nearest.properties,
                name:
                    nearest.properties?.name ??
                    (nearest.id != null ? String(nearest.id) : ""),
            },
        };
    }
}

/** Lets a question's newer positions supersede its older geometry work. */
const requestKeyFor = (question: { key?: number }) =>
    question.key === undefined ? undefined : `question:${question.key}`;

async function determinePlanningPolygonCompiled(
    question: { key?: number; data: CompiledFeatureQuestionData },
    questionDef: QuestionDefinition,
    datasets: Record<string, unknown>,
) {
    const params = {
        evaluator: questionDef.evaluator,
        datasets,
        data: question.data,
    };
    if (questionDef.family === "matching") {
        const geometry = await determineMatchingGeometry(params);
        return geometry ? regionLines(geometry.region) : null;
    }
    if (questionDef.family === "measuring") {
        // Shares the buffer the map is clipped with (the same boundary).
        const geometry = await determineMeasuringGeometry({
            ...params,
            mapGeoData: polyGeoJSON.get() ?? mapGeoJSON.get(),
            requestKey: requestKeyFor(question),
        });
        return geometry && !isEmptyBuffer(geometry)
            ? regionLines(geometry)
            : null;
    }
    if (questionDef.family === "tentacle") {
        const { circle, cells } = await determineTentacleGeometry({
            ...params,
            data: {
                ...question.data,
                radius: question.data.radius ?? 15,
                unit: question.data.unit ?? "miles",
            },
        });
        const regions = cells.features.length ? cells.features : [circle];
        return turf.featureCollection(
            regions.flatMap((region) => regionLines(region).features),
        );
    }
    return null;
}
export * from "./geo-utils";

/**
 * Whether a question can be answered now. Every question belongs to a game,
 * so each one waits while the game's definition loads; once it has loaded,
 * the game decides which questions it supports.
 */
function questionStatus(question: any): "ready" | "pending" | "unsupported" {
    const compiled = compiledGameAtom.get();
    if (!compiled) return "pending";
    return isQuestionSupported(question, compiled) ? "ready" : "unsupported";
}

export const hiderifyQuestion = async (question: Question) => {
    if (question.data.enabled === false) return null;
    if (question.data.drag) {
        if (questionStatus(question) !== "ready") return question;
        const compiled = compiledGameAtom.get();
        if (compiled) {
            const questionDef = resolveCompiledQuestion(question, compiled);
            if (questionDef) {
                if (question.id === "radius") {
                    question.data = hiderifyRadius(question.data);
                    return question;
                }
                if (question.id === "thermometer") {
                    question.data = await hiderifyThermometer(question.data);
                    return question;
                }
                const $hiderMode = hiderMode.get();
                if ($hiderMode !== false) {
                    await hiderifyCompiledQuestion(
                        question,
                        questionDef,
                        compiled.datasets,
                        $hiderMode,
                    );
                }
                return question;
            }
        }

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
    if (question.data.enabled === false) return undefined;
    if (planningModeEnabled && question.data.drag) {
        if (questionStatus(question) !== "ready") return undefined;
        const compiled = compiledGameAtom.get();
        if (compiled) {
            const questionDef = resolveCompiledQuestion(question, compiled);
            if (questionDef) {
                if (question.id === "radius") {
                    return radiusPlanningPolygon(question.data);
                }
                if (question.id === "thermometer") {
                    return thermometerPlanningPolygon(question.data);
                }
                return determinePlanningPolygonCompiled(
                    question,
                    questionDef,
                    compiled.datasets,
                );
            }
        }

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
    const compiled = compiledGameAtom.get();
    const status = questionStatus(question);
    if (status === "unsupported") {
        throw new Error(
            "Question is not supported by the active game definition",
        );
    }
    // Answered once the game's definition has loaded.
    if (status === "pending") return mapGeoData;
    if (
        mapGeoData?.type === "FeatureCollection" &&
        mapGeoData.features.length === 0
    )
        return mapGeoData;
    if (compiled) {
        const questionDef = resolveCompiledQuestion(question, compiled);
        if (questionDef) {
            return await evaluateQuestionOperator({
                questionDef,
                datasets: compiled.datasets,
                data: question.data,
                mapGeoData,
                requestKey: requestKeyFor(question),
            });
        }
    }

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
// Standalone regions keyed by question content. Valid only while every other
// input to the evaluators is unchanged; those atoms are replaced, never mutated,
// so identity comparison is enough to detect a change.
let regionCache: { inputs: unknown[]; regions: Map<string, any> } | undefined;

function regionCacheFor(baseMapGeoData: unknown): Map<string, any> {
    const inputs = [
        baseMapGeoData,
        compiledGameAtom.get(),
        hiderMode.get(),
        trainStations.get(),
        polyGeoJSON.get(),
        mapGeoLocation.get(),
    ];
    if (
        !regionCache ||
        inputs.some((input, index) => input !== regionCache!.inputs[index])
    ) {
        regionCache = { inputs, regions: new Map() };
    }
    return regionCache.regions;
}

export async function computePerQuestionRegions(
    questions: Questions,
    baseMapGeoData: any,
    planningModeEnabled: boolean,
): Promise<{ question: Question; region: any }[]> {
    const regions: { question: Question; region: any }[] = [];
    // Editing one question must not re-evaluate the others against a large
    // boundary. Only regions still in use are kept, bounding the cache.
    const cache = regionCacheFor(baseMapGeoData);
    const used = new Map<string, any>();

    for (const question of questions) {
        // `enabled` lives on most (not all) members of the question.data union;
        // narrow locally until the shared base type lands (see Bucket 1 cleanup).
        if ((question.data as { enabled?: boolean }).enabled === false)
            continue;
        if (planningModeEnabled && question.data.drag) continue;

        const key = JSON.stringify([question.id, question.data]);
        let region = cache.get(key);
        if (!region) {
            // Each question is evaluated against a fresh copy of the base
            // boundary, independent of the others.
            const base = structuredClone(baseMapGeoData);
            region = await adjustMapGeoDataForQuestion(question, base);

            if (!region || region.type !== "FeatureCollection") {
                region = {
                    type: "FeatureCollection",
                    features: region ? [region] : [],
                };
            }
        }
        used.set(key, region);

        regions.push({ question, region });
    }

    if (regionCache?.regions === cache) regionCache.regions = used;
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
        if (question.data.enabled === false) continue;
        if (planningModeCallback) {
            const planningPolygon = await determinePlanningPolygon(
                question,
                planningModeEnabled,
            );
            if (planningPolygon) {
                planningModeCallback(planningPolygon, question);
            }
        }
        if (planningModeEnabled && question.data.drag) {
            continue;
        }

        mapGeoData = await adjustMapGeoDataForQuestion(question, mapGeoData);

        if (!mapGeoData || mapGeoData.type !== "FeatureCollection") {
            mapGeoData = {
                type: "FeatureCollection",
                features: mapGeoData ? [mapGeoData] : [],
            };
        }
    }
    return mapGeoData;
}
