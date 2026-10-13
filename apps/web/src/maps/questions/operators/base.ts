import type { QuestionDefinition } from "@searchlight/shared";

import { adjustPerRadius } from "@/maps/questions/radius.js";
import { adjustPerThermometer } from "@/maps/questions/thermometer.js";

import { evaluateMatchingOperator } from "./matching.js";
import { evaluateMeasuringOperator } from "./measuring.js";
import { evaluateTentacleOperator } from "./tentacle.js";

export interface QuestionEvaluationContext {
  questionDef: QuestionDefinition;
  datasets: Record<string, any>;
  data: any;
  mapGeoData: any;
  /** Identifies the question, so its newer positions supersede older work. */
  requestKey?: string;
}

/**
 * Dispatches declarative operator evaluation for a compiled question definition.
 */
export async function evaluateQuestionOperator(
  context: QuestionEvaluationContext,
): Promise<any> {
  const { questionDef, datasets, data, mapGeoData, requestKey } = context;
  if (!mapGeoData) return mapGeoData;
  if (mapGeoData.type === "FeatureCollection" && mapGeoData.features.length === 0) return mapGeoData;

  switch (questionDef.family) {
    case "radius":
      return await adjustPerRadius(data, mapGeoData);

    case "thermometer":
      return await adjustPerThermometer(data, mapGeoData);

    case "matching":
      return await evaluateMatchingOperator({
        evaluator: questionDef.evaluator,
        datasets,
        data,
        mapGeoData,
      });

    case "measuring":
      return await evaluateMeasuringOperator({
        evaluator: questionDef.evaluator,
        datasets,
        data,
        mapGeoData,
        requestKey,
      });

    case "tentacle":
      return await evaluateTentacleOperator({
        evaluator: questionDef.evaluator,
        datasets,
        data,
        mapGeoData,
      });

    default:
      return mapGeoData;
  }
}
