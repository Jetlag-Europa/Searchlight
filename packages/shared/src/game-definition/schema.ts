import { type Static, Type } from "@sinclair/typebox";
import { DISTANCE_UNITS } from "./operators.js";

export const GAME_DEFINITION_SCHEMA_URL =
  "https://sl-dev.jl-e.org/schemas/game-definition.v1.schema.json" as const;

// ── Visibility ───────────────────────────────────────────────────────────────

export const ServerMembersVisibilitySchema = Type.Object({
  kind: Type.Literal("server-members"),
});

export const DiscordRoleVisibilitySchema = Type.Object({
  kind: Type.Literal("discord-role"),
  guildId: Type.String({ minLength: 1 }),
  roleId: Type.String({ minLength: 1 }),
});

export const VisibilitySchema = Type.Union([
  ServerMembersVisibilitySchema,
  DiscordRoleVisibilitySchema,
]);
export type Visibility = Static<typeof VisibilitySchema>;

// ── Map & Coordinates ────────────────────────────────────────────────────────

export const PositionSchema = Type.Tuple([
  Type.Number({ minimum: -180, maximum: 180 }), // lng
  Type.Number({ minimum: -90, maximum: 90 }), // lat
]);
export type Position = Static<typeof PositionSchema>;

export const BoundsSchema = Type.Tuple([
  Type.Number({ minimum: -180, maximum: 180 }), // west
  Type.Number({ minimum: -90, maximum: 90 }), // south
  Type.Number({ minimum: -180, maximum: 180 }), // east
  Type.Number({ minimum: -90, maximum: 90 }), // north
]);
export type Bounds = Static<typeof BoundsSchema>;

// ── GeoJSON Geometry Specifications ───────────────────────────────────────────

export const PointGeometrySchema = Type.Object({
  type: Type.Literal("Point"),
  coordinates: PositionSchema,
});
export type PointGeometry = Static<typeof PointGeometrySchema>;

export const LineStringGeometrySchema = Type.Object({
  type: Type.Literal("LineString"),
  coordinates: Type.Array(PositionSchema, { minItems: 2 }),
});
export type LineStringGeometry = Static<typeof LineStringGeometrySchema>;

export const PolygonGeometrySchema = Type.Object({
  type: Type.Literal("Polygon"),
  coordinates: Type.Array(Type.Array(PositionSchema, { minItems: 4 }), { minItems: 1 }),
});
export type PolygonGeometry = Static<typeof PolygonGeometrySchema>;

export const MultiLineStringGeometrySchema = Type.Object({
  type: Type.Literal("MultiLineString"),
  coordinates: Type.Array(Type.Array(PositionSchema, { minItems: 2 }), { minItems: 1 }),
});
export type MultiLineStringGeometry = Static<typeof MultiLineStringGeometrySchema>;

export const MultiPolygonGeometrySchema = Type.Object({
  type: Type.Literal("MultiPolygon"),
  coordinates: Type.Array(
    Type.Array(Type.Array(PositionSchema, { minItems: 4 }), { minItems: 1 }),
    { minItems: 1 },
  ),
});
export type MultiPolygonGeometry = Static<typeof MultiPolygonGeometrySchema>;

export const GeoJsonGeometrySchema = Type.Union([
  PointGeometrySchema,
  LineStringGeometrySchema,
  PolygonGeometrySchema,
  MultiLineStringGeometrySchema,
  MultiPolygonGeometrySchema,
]);
export type GeoJsonGeometry = Static<typeof GeoJsonGeometrySchema>;

export const GeoJsonFeatureSchema = Type.Object({
  type: Type.Literal("Feature"),
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  geometry: GeoJsonGeometrySchema,
  properties: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])),
});
export type GeoJsonFeature = Static<typeof GeoJsonFeatureSchema>;

export const GeoJsonFeatureCollectionSchema = Type.Object({
  type: Type.Literal("FeatureCollection"),
  features: Type.Array(GeoJsonFeatureSchema),
});
export type GeoJsonFeatureCollection = Static<typeof GeoJsonFeatureCollectionSchema>;

// ── Play Area (Polygon or MultiPolygon) ───────────────────────────────────────

export const PlayAreaGeometrySchema = Type.Union([
  PolygonGeometrySchema,
  MultiPolygonGeometrySchema,
]);
export type PlayAreaGeometry = Static<typeof PlayAreaGeometrySchema>;

export const PlayAreaFeatureSchema = Type.Object({
  type: Type.Literal("Feature"),
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  geometry: PlayAreaGeometrySchema,
  properties: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])),
});
export type PlayAreaFeature = Static<typeof PlayAreaFeatureSchema>;

export const PlayAreaFeatureCollectionSchema = Type.Object({
  type: Type.Literal("FeatureCollection"),
  features: Type.Array(PlayAreaFeatureSchema),
});
export type PlayAreaFeatureCollection = Static<typeof PlayAreaFeatureCollectionSchema>;

export const CleanMapConfigSchema = Type.Object({
  center: PositionSchema,
  bounds: Type.Optional(BoundsSchema),
  playArea: PlayAreaFeatureCollectionSchema,
});
export type CleanMapConfig = Static<typeof CleanMapConfigSchema>;

// ── Hiding Zones (Point, Polygon, or MultiPolygon) ─────────────────────────────

export const HidingZoneGeometrySchema = Type.Union([
  PointGeometrySchema,
  PolygonGeometrySchema,
  MultiPolygonGeometrySchema,
]);
export type HidingZoneGeometry = Static<typeof HidingZoneGeometrySchema>;

export const HidingZoneFeatureSchema = Type.Object({
  type: Type.Literal("Feature"),
  id: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  geometry: HidingZoneGeometrySchema,
  properties: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Any()), Type.Null()])),
});
export type HidingZoneFeature = Static<typeof HidingZoneFeatureSchema>;

export const HidingZoneFeatureCollectionSchema = Type.Object({
  type: Type.Literal("FeatureCollection"),
  features: Type.Array(HidingZoneFeatureSchema),
});
export type HidingZoneFeatureCollection = Static<typeof HidingZoneFeatureCollectionSchema>;

export const CleanHidingZonesSchema = Type.Object({
  radius: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  unit: Type.Optional(Type.Union(DISTANCE_UNITS.map((u) => Type.Literal(u)))),
  tierOverrides: Type.Optional(
    Type.Record(Type.String({ minLength: 1 }), Type.Number({ exclusiveMinimum: 0 })),
  ),
  features: HidingZoneFeatureCollectionSchema,
});
export type CleanHidingZones = Static<typeof CleanHidingZonesSchema>;

// ── Feature Collections (Questions / Datasets) ───────────────────────────────

export const FeatureEnabledForSchema = Type.Union([
  Type.Literal("matching"),
  Type.Literal("measuring"),
  Type.Literal("tentacle"),
]);
export type FeatureEnabledFor = Static<typeof FeatureEnabledForSchema>;

export const GameFeatureSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    enabledFor: Type.Array(FeatureEnabledForSchema, { minItems: 1 }),
    data: GeoJsonFeatureCollectionSchema,
  },
  { additionalProperties: false },
);
export type GameFeature = Static<typeof GameFeatureSchema>;

// ── Clean Game Definition Root ───────────────────────────────────────────────

export const GameDefinitionSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    // A lowercase slug, like the ids derived from `name`: it appears in URLs and
    // export file names.
    id: Type.Optional(Type.String({ minLength: 1, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })),
    // Revisions are stored as 32-bit integers.
    revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    serverId: Type.String({ minLength: 1 }),
    size: Type.Optional(
      Type.Union([
        Type.Literal("small"),
        Type.Literal("medium"),
        Type.Literal("large"),
      ]),
    ),
    visibility: Type.Optional(VisibilitySchema),
    unit: Type.Optional(
      Type.Union(DISTANCE_UNITS.map((u) => Type.Literal(u))),
    ),
    map: CleanMapConfigSchema,
    hidingZones: CleanHidingZonesSchema,
    radars: Type.Optional(
      Type.Union([
        Type.Boolean(),
        Type.Array(Type.Number({ exclusiveMinimum: 0 }), { minItems: 1 }),
      ]),
    ),
    thermometer: Type.Optional(Type.Boolean()),
    features: Type.Optional(Type.Array(GameFeatureSchema)),
  },
  { additionalProperties: false },
);
export type GameDefinition = Static<typeof GameDefinitionSchema>;
/**
 * Resolves the canonical game definition ID from `id` or derives it from `name`.
 */
export function resolveGameDefinitionId(def: { id?: string; name: string }): string {
  if (def.id) return def.id;
  return def.name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derives a question ID for a feature by prefixing kind and slugifying the feature name.
 */
export function deriveFeatureQuestionId(kind: string, name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${kind}-${slug}`;
}
