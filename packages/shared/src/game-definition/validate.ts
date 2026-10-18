import { Value } from "@sinclair/typebox/value";
import { validateGameDetails } from "./details.js";
import {
  deriveFeatureQuestionId,
  type GameDefinition,
  GameDefinitionSchema,
  resolveGameDefinitionId,
} from "./schema.js";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

function validateClosedRings(
  geom: { type: string; coordinates: unknown },
  basePath: string,
  errors: ValidationIssue[],
): void {
  if (geom.type === "Polygon") {
    const rings = geom.coordinates as [number, number][][];
    for (let rIdx = 0; rIdx < rings.length; rIdx++) {
      const ring = rings[rIdx];
      if (ring.length < 4) {
        errors.push({
          path: `${basePath}/coordinates/${rIdx}`,
          code: "INVALID_COORDINATES",
          message: "Polygon linear ring must contain at least 4 coordinates",
        });
      } else {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          errors.push({
            path: `${basePath}/coordinates/${rIdx}`,
            code: "INVALID_COORDINATES",
            message: "Polygon linear ring must be closed (first and last coordinates must match)",
          });
        }
      }
    }
  } else if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates as [number, number][][][];
    for (let pIdx = 0; pIdx < polys.length; pIdx++) {
      const rings = polys[pIdx];
      for (let rIdx = 0; rIdx < rings.length; rIdx++) {
        const ring = rings[rIdx];
        if (ring.length < 4) {
          errors.push({
            path: `${basePath}/coordinates/${pIdx}/${rIdx}`,
            code: "INVALID_COORDINATES",
            message: "MultiPolygon linear ring must contain at least 4 coordinates",
          });
        } else {
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            errors.push({
              path: `${basePath}/coordinates/${pIdx}/${rIdx}`,
              code: "INVALID_COORDINATES",
              message: "MultiPolygon linear ring must be closed (first and last coordinates must match)",
            });
          }
        }
      }
    }
  }
}

export function validateGameDefinition(raw: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];


  // 1. Structural schema validation via TypeBox
  const schemaErrors = [...Value.Errors(GameDefinitionSchema, raw)];
  if (schemaErrors.length > 0) {
    for (const err of schemaErrors) {
      if (err.path.match(/^\/features\/\d+\/data$/) && err.value === undefined) {
        errors.push({
          path: err.path,
          code: "MISSING_FEATURE_DATA",
          message: "Feature must provide embedded GeoJSON data",
        });
      } else if (
        err.value === "MultiPoint" ||
        (typeof err.value === "object" &&
          err.value !== null &&
          "type" in err.value &&
          err.value.type === "MultiPoint")
      ) {
        errors.push({
          path: err.path,
          code: "UNSUPPORTED_GEOMETRY_TYPE",
          message: "MultiPoint geometry is not supported",
        });
      } else {
        errors.push({
          path: err.path || "/",
          code: "SCHEMA_VALIDATION_ERROR",
          message: err.message,
        });
      }
    }
    return { valid: false, errors, warnings };
  }

  const def = raw as GameDefinition;

  // 2. Resolve game ID
  const gameId = resolveGameDefinitionId(def);
  if (!gameId || gameId.length < 2) {
    errors.push({
      path: "/id",
      code: "INVALID_GAME_ID",
      message: "Game must have a valid non-empty id or name",
    });
  }

  // 3. The game's details: real dates, in order, and an https rules link
  errors.push(...validateGameDetails(def));

  // 4. Map bounds validation
  if (def.map.bounds) {
    const [west, south, east, north] = def.map.bounds;
    if (west > east) {
      errors.push({
        path: "/map/bounds",
        code: "INVALID_BOUNDS",
        message: `Bounds west (${west}) cannot be greater than east (${east})`,
      });
    }
    if (south > north) {
      errors.push({
        path: "/map/bounds",
        code: "INVALID_BOUNDS",
        message: `Bounds south (${south}) cannot be greater than north (${north})`,
      });
    }
  }

  // 5. Closed rings validation for Polygons
  def.map.playArea.features.forEach((feat, idx) => {
    validateClosedRings(feat.geometry, `/map/playArea/features/${idx}/geometry`, errors);
  });

  def.hidingZones.features.features.forEach((feat, idx) => {
    validateClosedRings(feat.geometry, `/hidingZones/features/features/${idx}/geometry`, errors);
  });

  // 6. Features collection validation (optional)
  if (def.features) {
    const names = new Set<string>();
    const seenQuestionIds = new Map<string, string>();

    def.features.forEach((feat, idx) => {
      if (names.has(feat.name)) {
        errors.push({
          path: `/features/${idx}/name`,
          code: "DUPLICATE_FEATURE_NAME",
          message: `Duplicate feature name "${feat.name}"; every layer needs its own name`,
        });
      }
      names.add(feat.name);

      // Validate question IDs generated by this feature
      for (const kind of feat.enabledFor) {
        const qId = deriveFeatureQuestionId(kind, feat.name);
        const prefix = `${kind}-`;
        const slug = qId.slice(prefix.length);

        if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          errors.push({
            path: `/features/${idx}/name`,
            code: "INVALID_FEATURE_QUESTION_ID",
            message: `Feature "${feat.name}" cannot generate a usable question ID for "${kind}". Derived ID "${qId}" has an empty or invalid slug.`,
          });
        } else if (seenQuestionIds.has(qId)) {
          const prior = seenQuestionIds.get(qId);
          errors.push({
            path: `/features/${idx}/name`,
            code: "COLLIDING_QUESTION_ID",
            message: `Feature "${feat.name}" generates question ID "${qId}" which collides with question ID from feature "${prior ?? "unknown"}".`,
          });
        } else {
          seenQuestionIds.set(qId, feat.name);
        }
      }

      // Validate geometry family and closed rings in feature layer
      const geomTypes = new Set<string>();
      feat.data.features.forEach((f, fIdx) => {
        validateClosedRings(f.geometry, `/features/${idx}/data/features/${fIdx}/geometry`, errors);
        geomTypes.add(f.geometry.type);
      });

      const hasPoints = geomTypes.has("Point");
      const hasLines = geomTypes.has("LineString") || geomTypes.has("MultiLineString");
      const hasPolygons = geomTypes.has("Polygon") || geomTypes.has("MultiPolygon");

      const familiesCount = (hasPoints ? 1 : 0) + (hasLines ? 1 : 0) + (hasPolygons ? 1 : 0);
      if (familiesCount > 1) {
        errors.push({
          path: `/features/${idx}/data/features`,
          code: "MIXED_GEOMETRY",
          message: `Feature layer "${feat.name}" contains mixed geometries (${[...geomTypes].join(", ")}). All features in a layer must share the same geometry family (Points, Lines, or Polygons).`,
        });
      }

      if (feat.enabledFor.includes("tentacle") && !hasPoints && geomTypes.size > 0) {
        errors.push({
          path: `/features/${idx}/enabledFor`,
          code: "INCOMPATIBLE_QUESTION_TYPE",
          message: `Feature layer "${feat.name}" (${[...geomTypes].join(", ")}) cannot be enabled for "tentacle". Tentacle questions only support Point features.`,
        });
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
