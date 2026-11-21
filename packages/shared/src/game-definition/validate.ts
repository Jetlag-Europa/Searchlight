import {
  Value,
  type ValueError,
  type ValueErrorIterator,
  ValueErrorType,
} from "@sinclair/typebox/value";
import {
  deriveFeatureQuestionId,
  type GameDefinition,
  GameDefinitionSchema,
  PositionSchema,
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

// Cap inner-error scans so a multi-MB 3D KML geometry doesn't materialize
// tens of thousands of vertex errors just to report the first deepest one.
const MAX_UNION_INNER_ERRORS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathDepth(path: string): number {
  return path ? path.split("/").length : 0;
}

function formatSchemaErrorMessage(err: ValueError): string {
  if (err.type === ValueErrorType.TupleLength && err.schema === PositionSchema) {
    return "position must be [lng, lat] (exactly 2 numbers)";
  }
  return err.message;
}

function pickDeepestError(iter: ValueErrorIterator | undefined): ValueError | undefined {
  if (!iter) return undefined;
  let best: ValueError | undefined;
  let bestDepth = -1;
  let seen = 0;
  for (const inner of iter) {
    const depth = pathDepth(inner.path);
    if (depth > bestDepth) {
      best = inner;
      bestDepth = depth;
    }
    if (++seen >= MAX_UNION_INNER_ERRORS) break;
  }
  return best;
}

function deepestVariantIssue(
  err: ValueError,
  variantIdx: number,
  fallbackPath: string,
): ValidationIssue | null {
  if (variantIdx === -1) return null;
  const inner = pickDeepestError(err.errors[variantIdx]);
  if (!inner) return null;
  return {
    path: inner.path || fallbackPath,
    code: "SCHEMA_VALIDATION_ERROR",
    message: formatSchemaErrorMessage(inner),
  };
}

function getLiteralDiscriminator(anyOf: Record<string, unknown>[], prop: string): string[] | null {
  const values: string[] = [];
  for (const variant of anyOf) {
    const props = variant["properties"];
    if (!isPlainObject(props)) return null;
    const field = props[prop];
    if (!isPlainObject(field) || typeof field["const"] !== "string") return null;
    values.push(field["const"]);
  }
  return values.length > 0 ? values : null;
}

function unpackUnionError(err: ValueError): ValidationIssue {
  const path = err.path || "/";
  const rawAnyOf = (err.schema as { anyOf?: unknown }).anyOf;
  const anyOf = Array.isArray(rawAnyOf) ? (rawAnyOf as Record<string, unknown>[]) : [];

  // All-literal unions (e.g. unit, size, enabledFor items)
  if (anyOf.length > 0 && anyOf.every((v) => isPlainObject(v) && "const" in v)) {
    const allowed = anyOf.map((v) => String(v["const"])).join(", ");
    return {
      path,
      code: "SCHEMA_VALIDATION_ERROR",
      message: `must be one of ${allowed}`,
    };
  }

  // Geometry unions (playArea, hidingZones, features[i].data)
  const geometryTypes = getLiteralDiscriminator(anyOf, "type");
  if (geometryTypes) {
    const actualType = isPlainObject(err.value) ? err.value["type"] : undefined;
    if (actualType === "MultiPoint") {
      return {
        path,
        code: "UNSUPPORTED_GEOMETRY_TYPE",
        message: "MultiPoint geometry is not supported",
      };
    }
    const matchedIdx = typeof actualType === "string" ? geometryTypes.indexOf(actualType) : -1;
    const issue = deepestVariantIssue(err, matchedIdx, path);
    if (issue) return issue;
    const allowed = geometryTypes.join(", ");
    return {
      path,
      code: "SCHEMA_VALIDATION_ERROR",
      message:
        typeof actualType === "string" && actualType.length > 0
          ? `Unsupported geometry type "${actualType}"; must be one of ${allowed}`
          : `Geometry type must be one of ${allowed}`,
    };
  }

  // Visibility union
  const visibilityKinds = getLiteralDiscriminator(anyOf, "kind");
  if (visibilityKinds) {
    const actualKind = isPlainObject(err.value) ? err.value["kind"] : undefined;
    const matchedIdx = typeof actualKind === "string" ? visibilityKinds.indexOf(actualKind) : -1;
    const issue = deepestVariantIssue(err, matchedIdx, path);
    if (issue) return issue;
    const accepted = '{ kind: "server-members" } or { kind: "discord-role", guildId, roleId }';
    return {
      path,
      code: "SCHEMA_VALIDATION_ERROR",
      message:
        typeof actualKind === "string" && actualKind.length > 0
          ? `Unsupported visibility kind "${actualKind}"; must be ${accepted}`
          : `Visibility must be ${accepted}`,
    };
  }

  // Radars union (boolean | positive number[])
  if (err.path === "/radars") {
    if (Array.isArray(err.value) && err.value.length > 0) {
      const arrayIdx = anyOf.findIndex((v) => isPlainObject(v) && v["type"] === "array");
      const issue = deepestVariantIssue(err, arrayIdx, path);
      if (issue) return issue;
    }
    return {
      path,
      code: "SCHEMA_VALIDATION_ERROR",
      message: "Radars must be a boolean or a non-empty array of positive numbers",
    };
  }

  // Simple type unions (e.g. feature id: string | number, properties: object | null)
  if (anyOf.length > 0 && anyOf.every((v) => isPlainObject(v) && typeof v["type"] === "string")) {
    const types = anyOf.map((v) => String(v["type"])).join(" or ");
    return {
      path,
      code: "SCHEMA_VALIDATION_ERROR",
      message: `Expected ${types}`,
    };
  }

  return {
    path,
    code: "SCHEMA_VALIDATION_ERROR",
    message: err.message,
  };
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
              message:
                "MultiPolygon linear ring must be closed (first and last coordinates must match)",
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
    const seenMissingFeatureData = new Set<string>();
    for (const err of schemaErrors) {
      if (err.path.match(/^\/features\/\d+\/data$/) && err.value === undefined) {
        if (!seenMissingFeatureData.has(err.path)) {
          seenMissingFeatureData.add(err.path);
          errors.push({
            path: err.path,
            code: "MISSING_FEATURE_DATA",
            message: "Feature must provide embedded GeoJSON data",
          });
        }
      } else if (err.type === ValueErrorType.Union) {
        errors.push(unpackUnionError(err));
      } else {
        errors.push({
          path: err.path || "/",
          code: "SCHEMA_VALIDATION_ERROR",
          message: formatSchemaErrorMessage(err),
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
      message: "Game id (or slug derived from name) must be at least 2 characters",
    });
  }

  // 3. Map bounds validation
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

  // 4. Closed rings validation for Polygons
  def.map.playArea.features.forEach((feat, idx) => {
    validateClosedRings(feat.geometry, `/map/playArea/features/${idx}/geometry`, errors);
  });

  def.hidingZones.features.features.forEach((feat, idx) => {
    validateClosedRings(feat.geometry, `/hidingZones/features/features/${idx}/geometry`, errors);
  });

  // 5. Features collection validation (optional)
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

      const seenKinds = new Set<string>();
      const reportedDuplicateKinds = new Set<string>();

      // Validate question IDs generated by this feature
      for (const kind of feat.enabledFor) {
        if (seenKinds.has(kind)) {
          if (!reportedDuplicateKinds.has(kind)) {
            reportedDuplicateKinds.add(kind);
            errors.push({
              path: `/features/${idx}/enabledFor`,
              code: "DUPLICATE_ENABLED_FOR",
              message: `Feature "${feat.name}" lists "${kind}" more than once in enabledFor`,
            });
          }
          continue;
        }
        seenKinds.add(kind);

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
