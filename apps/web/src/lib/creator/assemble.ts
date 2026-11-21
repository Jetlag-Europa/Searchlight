import {
    type Bounds,
    CASUAL_SERVER_ID,
    deriveFeatureQuestionId,
    type DistanceUnit,
    type FeatureEnabledFor,
    GAME_DEFINITION_SCHEMA_URL,
    type GameDefinition,
    type GameFeature,
    type HidingZoneFeature,
    type PlayAreaFeatureCollection,
    resolveGameDefinitionId,
} from "@searchlight/shared";

import type { GeometryFamily } from "@/lib/creator/importFile";
import type { CreatorGeoFeatureItem } from "@/lib/creator/osmGeometry";
import {
    type CreatorPointItem,
    expandBoundsKm,
    tryPlayAreaBounds,
} from "@/lib/creator/overpass";
import type { GameScale } from "@/lib/creator/presets";

export interface CreatorLayerState {
    id: string;
    name: string;
    osmFilter: string;
    enabledFor: FeatureEnabledFor[];
    color: string;
    selected: boolean;
    notableOnly: boolean;
    custom?: boolean;
    items: CreatorPointItem[];
    fetched: boolean;
}

export interface CreatorGeometryLayer {
    id: string;
    name: string;
    family: GeometryFamily;
    enabledFor: FeatureEnabledFor[];
    color: string;
    selected: boolean;
    noOverlaps?: boolean;
    sourceLabel: string;
    items: CreatorGeoFeatureItem[];
    vertexCount: number;
}

export interface PreservedGameMetadata {
    serverId?: string;
    visibility?: GameDefinition["visibility"];
    bounds?: Bounds;
    center?: [number, number];
}

export interface CreatorDraftInput {
    name: string;
    id?: string;
    size: GameScale;
    unit: DistanceUnit;
    hidingRadius: number;
    tierOverrides: Record<string, number>;
    radars: boolean | number[];
    thermometer: boolean;
    playArea: PlayAreaFeatureCollection;
    stations: readonly CreatorPointItem[];
    /** Non-point hiding zone features (e.g. Polygon zones) preserved from a loaded .game.json. */
    extraHidingZones?: readonly HidingZoneFeature[];
    /** Server/visibility/map metadata preserved when editing an existing .game.json. */
    preservedMetadata?: PreservedGameMetadata | null;
    layers: readonly CreatorLayerState[];
    geometryLayers?: readonly CreatorGeometryLayer[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function slugify(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function layerSlugOf(name: string): string {
    return slugify(name.trim());
}

/**
 * Checks selected feature layers using the same uniqueness rules as shared
 * `validateGameDefinition`: unique exact names, non-empty ASCII question IDs,
 * and unique `(kind, slug)` question IDs across layers.
 */
export function validateCreatorLayers(
    layers: readonly Pick<
        CreatorLayerState,
        "name" | "selected" | "enabledFor"
    >[],
): string[] {
    const errors: string[] = [];
    const seenNames = new Set<string>();
    const seenQuestionIds = new Map<string, string>();
    for (const layer of layers) {
        if (!layer.selected) continue;
        const trimmed = layer.name.trim();
        if (!trimmed) {
            errors.push(
                'Layer "(unnamed)" must include at least one ASCII letter or digit (a–z, 0–9).',
            );
            continue;
        }
        if (seenNames.has(trimmed)) {
            errors.push(
                `Duplicate layer name "${trimmed}"; every layer needs its own name.`,
            );
        }
        seenNames.add(trimmed);

        const slug = slugify(trimmed);
        if (!slug) {
            errors.push(
                `Layer "${trimmed}" must include at least one ASCII letter or digit (a–z, 0–9).`,
            );
            continue;
        }
        const kinds: FeatureEnabledFor[] =
            layer.enabledFor.length > 0 ? layer.enabledFor : ["matching"];
        for (const kind of kinds) {
            const qId = deriveFeatureQuestionId(kind, trimmed);
            const existing = seenQuestionIds.get(qId);
            if (existing && existing !== trimmed) {
                errors.push(
                    `Layer "${trimmed}" collides with "${existing}" on question ID "${qId}". Rename one of them.`,
                );
            } else {
                seenQuestionIds.set(qId, trimmed);
            }
        }
    }
    return errors;
}

function uniqueId(name: string, fallback: string, seen: Set<string>): string {
    const base = slugify(name) || fallback;
    let candidate = base;
    let n = 2;
    while (seen.has(candidate)) {
        candidate = `${base}-${n++}`;
    }
    seen.add(candidate);
    return candidate;
}

/**
 * Assembles a canonical, schema-valid Searchlight GameDefinition from the
 * Map Creator's state. Only enabled stations and enabled features in selected
 * layers are emitted.
 */
export function assembleGameDefinition(
    draft: CreatorDraftInput,
): GameDefinition {
    const trimmedName = draft.name.trim() || "Untitled Game";
    const resolvedId =
        slugify(draft.id?.trim() || "") ||
        resolveGameDefinitionId({ name: trimmedName }) ||
        "custom-game";

    const rawBounds = tryPlayAreaBounds(draft.playArea);
    const bounds: Bounds | undefined = rawBounds
        ? expandBoundsKm(rawBounds, 0.5)
        : draft.preservedMetadata?.bounds;
    const center: [number, number] = rawBounds
        ? [
              round6((rawBounds[0] + rawBounds[2]) / 2),
              round6((rawBounds[1] + rawBounds[3]) / 2),
          ]
        : draft.preservedMetadata?.center
          ? [
                round6(draft.preservedMetadata.center[0]),
                round6(draft.preservedMetadata.center[1]),
            ]
          : bounds
            ? [round6((bounds[0] + bounds[2]) / 2), round6((bounds[1] + bounds[3]) / 2)]
            : [0, 0];

    const zoneIds = new Set<string>();
    const activeTierKeys = new Set<string>();
    const zoneFeatures: HidingZoneFeature[] = [];

    // Claim every loaded zone's original ID (both point and polygon zones) up front
    // so newly added stations never steal or duplicate an existing zone ID.
    const claimedOriginalIds = new Set<string>();
    for (const extra of draft.extraHidingZones ?? []) {
        if (extra.id !== undefined) {
            zoneIds.add(String(extra.id));
            claimedOriginalIds.add(String(extra.id));
        }
    }
    const stationResolvedOriginalIds = new Map<CreatorPointItem, string | number>();
    for (const station of draft.stations) {
        if (!station.enabled || station.originalId === undefined) continue;
        const key = String(station.originalId);
        if (key && !claimedOriginalIds.has(key)) {
            claimedOriginalIds.add(key);
            zoneIds.add(key);
            stationResolvedOriginalIds.set(station, station.originalId);
        }
    }

    for (const station of draft.stations) {
        if (!station.enabled) continue;
        const baseProps: Record<string, unknown> = station.originalProperties
            ? { ...station.originalProperties }
            : {};
        baseProps.name = station.name.trim() || "Station";
        const tier = station.tier?.trim();
        if (tier) {
            // Preserve numeric tier type if it came from a loaded .game.json unchanged.
            const origTier = station.originalProperties?.tier;
            baseProps.tier =
                typeof origTier === "number" && String(origTier) === tier
                    ? origTier
                    : tier;
            if (
                Number.isFinite(draft.tierOverrides[tier]) &&
                draft.tierOverrides[tier] > 0
            ) {
                activeTierKeys.add(tier);
            }
        } else {
            delete baseProps.tier;
        }
        const preservedId = stationResolvedOriginalIds.get(station);
        const id: string | number =
            preservedId !== undefined
                ? preservedId
                : uniqueId(station.name, "zone", zoneIds);
        zoneFeatures.push({
            type: "Feature",
            id,
            geometry: {
                type: "Point",
                coordinates: [round6(station.lng), round6(station.lat)],
            },
            properties: baseProps,
        });
    }

    for (const extra of draft.extraHidingZones ?? []) {
        const extraTier =
            extra.properties?.tier !== undefined && extra.properties?.tier !== null
                ? String(extra.properties.tier).trim()
                : "";
        if (
            extraTier &&
            Number.isFinite(draft.tierOverrides[extraTier]) &&
            draft.tierOverrides[extraTier] > 0
        ) {
            activeTierKeys.add(extraTier);
        }
        zoneFeatures.push(extra);
    }

    const usedTierOverrides: Record<string, number> = {};
    for (const key of activeTierKeys) {
        usedTierOverrides[key] = draft.tierOverrides[key];
    }

    const features: GameFeature[] = [];
    const seenLayerNames = new Set<string>();
    const seenQuestionIds = new Set<string>();
    for (const layer of draft.layers) {
        if (!layer.selected || layer.enabledFor.length === 0) continue;
        const activeItems = layer.items.filter((item) => item.enabled);
        if (activeItems.length === 0) continue;
        const layerName = layer.name.trim();
        const layerSlug = slugify(layerName);
        if (!layerSlug || seenLayerNames.has(layerName)) continue;
        const qIds = layer.enabledFor.map((k) =>
            deriveFeatureQuestionId(k, layerName),
        );
        if (qIds.some((id) => seenQuestionIds.has(id))) continue;
        seenLayerNames.add(layerName);
        qIds.forEach((id) => seenQuestionIds.add(id));

        const itemIds = new Set<string>();
        features.push({
            name: layerName,
            enabledFor: [...layer.enabledFor],
            data: {
                type: "FeatureCollection",
                features: activeItems.map((item) => ({
                    type: "Feature",
                    id: uniqueId(item.name, "site", itemIds),
                    geometry: {
                        type: "Point",
                        coordinates: [round6(item.lng), round6(item.lat)],
                    },
                    properties: {
                        name: item.name.trim() || layerName,
                    },
                })),
            },
        });
    }

    for (const geoLayer of draft.geometryLayers ?? []) {
        if (!geoLayer.selected) continue;
        // Tentacles are only allowed on point layers.
        const allowedKinds =
            geoLayer.family === "points"
                ? geoLayer.enabledFor
                : geoLayer.enabledFor.filter((k) => k !== "tentacle");
        if (allowedKinds.length === 0) continue;
        const activeItems = geoLayer.items.filter((item) => item.enabled);
        if (activeItems.length === 0) continue;
        const layerName = geoLayer.name.trim();
        const layerSlug = slugify(layerName);
        if (!layerSlug || seenLayerNames.has(layerName)) continue;
        const qIds = allowedKinds.map((k) =>
            deriveFeatureQuestionId(k, layerName),
        );
        if (qIds.some((id) => seenQuestionIds.has(id))) continue;
        seenLayerNames.add(layerName);
        qIds.forEach((id) => seenQuestionIds.add(id));

        const itemIds = new Set<string>();
        const preservedItemIds = new Map<
            (typeof activeItems)[number],
            string | number
        >();
        for (const item of activeItems) {
            if (item.originalId === undefined) continue;
            const key = String(item.originalId);
            if (key && !itemIds.has(key)) {
                itemIds.add(key);
                preservedItemIds.set(item, item.originalId);
            }
        }
        features.push({
            name: layerName,
            enabledFor: [...allowedKinds],
            ...(geoLayer.family === "polygons" &&
                geoLayer.noOverlaps && { noOverlaps: true }),
            data: {
                type: "FeatureCollection",
                features: activeItems.map((item) => {
                    const baseProps: Record<string, unknown> =
                        item.originalProperties
                            ? { ...item.originalProperties }
                            : {};
                    baseProps.name = item.name.trim() || layerName;
                    const preservedId = preservedItemIds.get(item);
                    return {
                        type: "Feature",
                        id:
                            preservedId !== undefined
                                ? preservedId
                                : uniqueId(item.name, "feature", itemIds),
                        geometry: item.geometry,
                        properties: baseProps,
                    };
                }),
            },
        });
    }

    const definition: GameDefinition = {
        $schema: GAME_DEFINITION_SCHEMA_URL,
        id: resolvedId,
        name: trimmedName.slice(0, 120),
        serverId: draft.preservedMetadata?.serverId || CASUAL_SERVER_ID,
        ...(draft.preservedMetadata?.visibility && {
            visibility: draft.preservedMetadata.visibility,
        }),
        size: draft.size,
        map: {
            center,
            ...(bounds && { bounds }),
            playArea: draft.playArea,
        },
        hidingZones: {
            radius: draft.hidingRadius > 0 ? draft.hidingRadius : 400,
            unit: draft.unit,
            ...(Object.keys(usedTierOverrides).length > 0 && {
                tierOverrides: usedTierOverrides,
            }),
            features: {
                type: "FeatureCollection",
                features: zoneFeatures,
            },
        },
        radars: Array.isArray(draft.radars)
            ? draft.radars.filter((r) => Number.isFinite(r) && r > 0)
            : Boolean(draft.radars),
        thermometer: Boolean(draft.thermometer),
        ...(features.length > 0 && { features }),
    };

    // An empty radar array is schema-invalid (`minItems: 1`): turn radars off.
    if (Array.isArray(definition.radars) && definition.radars.length === 0) {
        definition.radars = false;
    }

    return definition;
}
