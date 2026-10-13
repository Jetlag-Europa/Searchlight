export const OPERATOR_IDS = [
  "radius",
  "thermometer",
  "nearest-feature-match",
  "containing-region-match",
  "nearest-feature-distance",
  "distance-to-lines",
  "distance-to-containing-region-boundary",
  "tentacle-nearest-feature",
] as const;

export type OperatorId = (typeof OPERATOR_IDS)[number];
export const QUESTION_FAMILIES = [
  "radius",
  "thermometer",
  "matching",
  "measuring",
  "tentacle",
] as const;

export type QuestionFamily = (typeof QUESTION_FAMILIES)[number];

export const DISTANCE_UNITS = ["meters", "kilometers", "miles"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

export interface DistanceRadius {
  value: number;
  unit: DistanceUnit;
}

export interface Evaluator {
  operator: OperatorId | string;
  source?: {
    kind: "dataset";
    datasetId?: string;
  };
  [key: string]: unknown;
}

export interface QuestionDefinition {
  id: string;
  family: QuestionFamily;
  label: string;
  group?: string;
  defaults?: Record<string, unknown>;
  evaluator: Evaluator;
}
