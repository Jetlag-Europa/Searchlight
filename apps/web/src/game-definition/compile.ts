import {
  deriveFeatureQuestionId,
  type DistanceRadius,
  type GameDefinition,
  type QuestionDefinition,
  resolveGameDefinitionId,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

export interface CompiledHidingZone {
  id: string | number;
  name: string;
  tier?: string;
  /** The station, or for a polygon zone a point inside it. */
  coordinates: [number, number];
  /** A polygon zone's own area. A station's zone is a circle of `radius`. */
  area?: Polygon | MultiPolygon;
  radius: DistanceRadius;
  explicitRadius?: number;
}

export interface CompiledGame {
  definition: GameDefinition;
  gameId: string;
  name: string;
  size: "small" | "medium" | "large";
  center: [number, number];
  bounds: [number, number, number, number];
  playArea: FeatureCollection<Polygon | MultiPolygon>;
  hidingZones: {
    kind: "points" | "polygons";
    features: FeatureCollection;
    stations?: CompiledHidingZone[];
    /** The game-wide radius, before tier and per-zone overrides. */
    baseRadius: DistanceRadius;
    getRadius: (zoneId: string | number, tier?: string) => DistanceRadius;
  };
  datasets: Record<string, any>;
  questions: QuestionDefinition[];
  questionMap: Map<string, QuestionDefinition>;
}

/** A layer's geometry family, from its first feature with a known type. */
export function detectFeatureGeometry(feat: any): "polygons" | "lines" | "points" {
  if (feat.data && typeof feat.data === "object") {
    const fc = feat.data as any;
    if (fc.type === "FeatureCollection" && Array.isArray(fc.features)) {
      for (const f of fc.features) {
        const type = f?.geometry?.type;
        if (type === "Polygon" || type === "MultiPolygon") return "polygons";
        if (type === "LineString" || type === "MultiLineString") return "lines";
        if (type === "Point") return "points";
      }
    }
  }
  return "points";
}

export function compileGameDefinition(
  definition: GameDefinition,
): CompiledGame {
  const gameId = resolveGameDefinitionId(definition);
  const size = definition.size ?? "medium";
  const unit = definition.unit ?? definition.hidingZones?.unit ?? "meters";
  const baseRadiusValue = definition.hidingZones?.radius ?? 400;
  const baseRadius: DistanceRadius = { value: baseRadiusValue, unit };
  const tierOverrides = definition.hidingZones?.tierOverrides ?? {};

  // 1. Process Hiding Zones
  const perZoneRadiusMap = new Map<string | number, DistanceRadius>();
  const stations: CompiledHidingZone[] = [];
  const rawFeatures = (definition.hidingZones?.features as any)?.features || [];

  // Unnamed zones are numbered among their own kind, so a game's areas don't
  // renumber its stations.
  let stationCount = 0;
  let areaCount = 0;

  for (const feat of rawFeatures) {
    const isArea =
      feat.geometry?.type === "Polygon" || feat.geometry?.type === "MultiPolygon";
    const ordinal = (isArea ? areaCount : stationCount) + 1;
    const zId =
      feat.id ?? feat.properties?.name ?? (isArea ? `area-${ordinal}` : `zone-${ordinal}`);
    const name = feat.properties?.name ?? (isArea ? `Area ${ordinal}` : `Station ${ordinal}`);
    // tierOverrides keys are strings; a numeric tier (1) selects the "1" key,
    // here and in the zone sidebar alike.
    const rawTier = feat.properties?.tier;
    const tier = rawTier == null ? undefined : String(rawTier);

    let effectiveRadius = baseRadius;
    let explicitRadius: number | undefined;
    if (feat.properties?.radius) {
      const r = feat.properties.radius;
      effectiveRadius = typeof r === "number" ? { value: r, unit } : r;
      explicitRadius = typeof r === "number" ? r : typeof r?.value === "number" ? r.value : undefined;
      perZoneRadiusMap.set(zId, effectiveRadius);
    } else if (tier && tierOverrides[tier]) {
      effectiveRadius = { value: tierOverrides[tier], unit };
    }

    if (feat.geometry?.type === "Point") {
      stationCount++;
      stations.push({
        id: zId,
        name,
        tier,
        coordinates: feat.geometry.coordinates as [number, number],
        radius: effectiveRadius,
        ...(explicitRadius !== undefined ? { explicitRadius } : {}),
      });
    } else if (isArea) {
      areaCount++;
      stations.push({
        id: zId,
        name,
        tier,
        coordinates: turf.pointOnFeature(feat).geometry.coordinates as [number, number],
        area: feat.geometry,
        radius: effectiveRadius,
      });
    }
  }

  const getRadius = (
    zoneId: string | number,
    tier?: string,
  ): DistanceRadius => {
    const override = perZoneRadiusMap.get(zoneId);
    if (override) return override;
    if (tier && tierOverrides[tier]) return { value: tierOverrides[tier], unit };
    return baseRadius;
  };

  // 2. Build Datasets from features. Each layer is keyed by its position, since
  // differently named layers can share a slug.
  const datasets: Record<string, any> = {};
  const datasetId = (index: number) => `layer-${index}`;
  definition.features?.forEach((feat, index) => {
    if (feat.data) {
      datasets[datasetId(index)] = { kind: "inline", features: feat.data };
    }
  });

  // 3. Synthesize Questions from radars, thermometer, and features. A game
  // offers only the questions it declares; nothing is enabled by default.
  const questions: QuestionDefinition[] = [];

  // Radars
  if (Array.isArray(definition.radars)) {
    for (const r of definition.radars) {
      questions.push({
        id: `radius-${r}`,
        family: "radius",
        label: `Radar (${r} ${unit})`,
        defaults: { radius: { value: r, unit }, within: true },
        evaluator: { operator: "radius" },
      });
    }
  } else if (definition.radars === true) {
    questions.push({
      id: "radius",
      family: "radius",
      label: `Radar (${baseRadiusValue} ${unit})`,
      defaults: { radius: baseRadius, within: true },
      evaluator: { operator: "radius" },
    });
  }

  // Thermometer
  if (definition.thermometer === true) {
    questions.push({
      id: "thermometer",
      family: "thermometer",
      label: "Thermometer",
      defaults: { warmer: true },
      evaluator: { operator: "thermometer" },
    });
  }

  // Feature-based questions
  if (definition.features) {
    for (const [index, feat] of definition.features.entries()) {
      const geomKind = detectFeatureGeometry(feat);
      const source = { kind: "dataset", datasetId: datasetId(index) } as const;

      if (feat.enabledFor.includes("matching")) {
        let operator = "nearest-feature-match";
        let label = /^nearest\b/i.test(feat.name)
          ? feat.name
          : `Nearest ${feat.name}`;
        if (geomKind === "polygons") {
          operator = "containing-region-match";
          label = /^same\b/i.test(feat.name)
            ? feat.name
            : `Same ${feat.name}`;
        }

        questions.push({
          id: deriveFeatureQuestionId("matching", feat.name),
          family: "matching",
          label,
          group: "Matching",
          defaults: { same: true },
          evaluator: { operator, source },
        });
      }

      if (feat.enabledFor.includes("measuring")) {
        let operator = "nearest-feature-distance";
        let label = `Distance to ${feat.name}`;
        if (geomKind === "polygons") {
          operator = "distance-to-containing-region-boundary";
          label = /boundary|border/i.test(feat.name)
            ? `Distance to ${feat.name}`
            : `Distance to ${feat.name} Boundary`;
        } else if (geomKind === "lines") {
          operator = "distance-to-lines";
          label = `Distance to ${feat.name}`;
        }

        questions.push({
          id: deriveFeatureQuestionId("measuring", feat.name),
          family: "measuring",
          label,
          group: "Measuring",
          defaults: { hiderCloser: true },
          evaluator: { operator, source },
        });
      }

      if (feat.enabledFor.includes("tentacle") && geomKind === "points") {
        const label = /^tentacles?\b/i.test(feat.name)
          ? feat.name
          : `Tentacles: ${feat.name}`;
        questions.push({
          id: deriveFeatureQuestionId("tentacle", feat.name),
          family: "tentacle",
          label,
          group: "Tentacles",
          defaults: { radius: baseRadius },
          evaluator: { operator: "tentacle-nearest-feature", source },
        });
      }
    }
  }

  const questionMap = new Map<string, QuestionDefinition>();
  for (const q of questions) {
    questionMap.set(q.id, q);
  }

  // 4. Calculate bounds if not explicitly provided
  let bounds = definition.map.bounds;
  if (!bounds) {
    let [minLng, maxLng, minLat, maxLat] = [
      definition.map.center[0], definition.map.center[0],
      definition.map.center[1], definition.map.center[1],
    ];
    const extend = ([west, south, east, north]: number[]) => {
      minLng = Math.min(minLng, west);
      maxLng = Math.max(maxLng, east);
      minLat = Math.min(minLat, south);
      maxLat = Math.max(maxLat, north);
    };
    // The play area, which the map starts as, and every zone.
    if (definition.map.playArea?.features?.length) {
      extend(turf.bbox(definition.map.playArea as FeatureCollection));
    }
    for (const s of stations) {
      extend(s.area ? turf.bbox(s.area) : [...s.coordinates, ...s.coordinates]);
    }
    const margin = 0.05;
    bounds = [minLng - margin, minLat - margin, maxLng + margin, maxLat + margin];
  }

  return {
    definition,
    gameId,
    name: definition.name,
    size,
    center: definition.map.center,
    bounds,
    playArea: definition.map.playArea as FeatureCollection<Polygon | MultiPolygon>,
    hidingZones: {
      kind: stations.some((s) => !s.area) ? "points" : "polygons",
      features: definition.hidingZones?.features as FeatureCollection,
      stations,
      baseRadius,
      getRadius,
    },
    datasets,
    questions,
    questionMap,
  };
}

/**
 * The radii a game's radar questions start at, in declaration order: one per
 * `radars` entry, or the base hiding radius for `radars: true`. Empty when the
 * game declares no radar.
 */
export function radarRadii(
  compiled: Pick<CompiledGame, "questions">,
): DistanceRadius[] {
  const radii: DistanceRadius[] = [];
  for (const q of compiled.questions) {
    const radius = q.family === "radius" ? (q.defaults?.radius as DistanceRadius | undefined) : undefined;
    if (radius && !radii.some((r) => r.value === radius.value && r.unit === radius.unit)) {
      radii.push(radius);
    }
  }
  return radii;
}
