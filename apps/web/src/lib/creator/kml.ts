import type {
    GameDefinition,
    GeoJsonGeometry,
    Position,
} from "@searchlight/shared";
import * as turf from "@turf/turf";

import { compileGameDefinition } from "@/game-definition/compile";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";

/**
 * Google Maps mobile displays at most 9 layers from a Google My Maps KML
 * (desktop My Maps allows 10). Default to 9 so mobile players see every layer.
 */
export const MY_MAPS_MOBILE_MAX_LAYERS = 9;
export const MY_MAPS_DESKTOP_MAX_LAYERS = 10;
export const MY_MAPS_MAX_FEATURES_PER_LAYER = 2000;
export const MY_MAPS_MAX_BYTES = 5 * 1024 * 1024;

export interface KmlExportOptions {
    /**
     * Maximum target KML folder count (defaults to 9 for mobile Google Maps).
     * Users can lower this (e.g. 8) to reserve slots for manual My Maps layers.
     */
    maxLayers?: number;
    /** Include Play Area polygon folder (default true). */
    includePlayArea?: boolean;
    /**
     * Legacy boolean: when explicitly `false`, disables automatic POI packing
     * so every feature layer gets its own KML folder unless overridden.
     */
    combinePoisForMyMaps?: boolean;
    /** Include hiding zone circle polygons as a KML folder (default false). */
    includeHidingZoneCircles?: boolean;
    /** Optional `#rrggbb` color per Searchlight layer name. */
    layerColors?: Record<string, string>;
    /** Optional thematic group hint per POI layer name (e.g. "Public Amenities"). */
    layerGroups?: Record<string, string>;
    /**
     * Optional manual KML folder assignment per Searchlight layer name.
     * Works for ANY layer (Points, Lines, or Polygons) so users can override
     * auto-grouping (e.g. combine two line layers or a line + POI layer).
     */
    layerFolderOverrides?: Record<string, string>;
}

export interface KmlFolderPlan {
    name: string;
    kind: "base" | "features";
    /** Searchlight feature layer names placed in this folder (empty for base folders). */
    layerNames: string[];
    featureCount: number;
}

export interface KmlFolderPlanResult {
    folders: KmlFolderPlan[];
    /** Resolved KML folder name for each Searchlight feature layer name. */
    layerAssignments: Record<string, string>;
    totalFolders: number;
    maxLayers: number;
    warnings: string[];
}

export interface KmlExportResult {
    kml: string;
    folderCount: number;
    byteLength: number;
    myMapsWarnings: string[];
    plan: KmlFolderPlanResult;
}

const FALLBACK_COLORS = [
    "#0284c7",
    "#e11d48",
    "#16a34a",
    "#d97706",
    "#9333ea",
    "#0891b2",
    "#dc2626",
    "#4f46e5",
    "#ea580c",
    "#ca8a04",
];

// XML 1.0 forbids C0 control chars except TAB (0x09), LF (0x0A), CR (0x0D).
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

function escapeXml(text: string): string {
    return text
        .replace(XML_FORBIDDEN_RE, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function ownString(
    record: Record<string, string> | undefined,
    key: string,
): string | undefined {
    if (!record || !Object.prototype.hasOwnProperty.call(record, key)) {
        return undefined;
    }
    const v = record[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Converts `#rrggbb` + alpha hex (`ff`) into KML's `aabbggrr` format. */
export function hexToKmlColor(hex: string, alpha = "ff"): string {
    if (typeof hex !== "string") return `${alpha}d86325`;
    const clean = hex.replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return `${alpha}d86325`;
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    return `${alpha}${b}${g}${r}`.toLowerCase();
}

function coordsText(coords: readonly Position[]): string {
    return coords.map(([lng, lat]) => `${lng},${lat},0`).join(" ");
}

function orientRingForKml(
    ring: readonly Position[],
    clockwise: boolean,
): readonly Position[] {
    if (ring.length < 4) return ring;
    try {
        const isCw = turf.booleanClockwise(ring as Position[]);
        return isCw === clockwise ? ring : [...ring].reverse();
    } catch {
        return ring;
    }
}

function polygonKml(rings: readonly Position[][]): string {
    const [outer, ...holes] = rings;
    // KML 2.2 expects counter-clockwise outer rings and clockwise inner holes.
    const ccwOuter = orientRingForKml(outer, false);
    const holeXml = holes
        .map(
            (ring) =>
                `<innerBoundaryIs><LinearRing><coordinates>${coordsText(orientRingForKml(ring, true))}</coordinates></LinearRing></innerBoundaryIs>`,
        )
        .join("");
    return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordsText(ccwOuter)}</coordinates></LinearRing></outerBoundaryIs>${holeXml}</Polygon>`;
}

function geometryKml(geometry: GeoJsonGeometry): string {
    switch (geometry.type) {
        case "Point":
            return `<Point><coordinates>${geometry.coordinates[0]},${geometry.coordinates[1]},0</coordinates></Point>`;
        case "LineString":
            return `<LineString><coordinates>${coordsText(geometry.coordinates)}</coordinates></LineString>`;
        case "MultiLineString":
            return `<MultiGeometry>${geometry.coordinates
                .map(
                    (line) =>
                        `<LineString><coordinates>${coordsText(line)}</coordinates></LineString>`,
                )
                .join("")}</MultiGeometry>`;
        case "Polygon":
            return polygonKml(geometry.coordinates);
        case "MultiPolygon":
            return `<MultiGeometry>${geometry.coordinates
                .map((poly) => polygonKml(poly))
                .join("")}</MultiGeometry>`;
    }
}

function placemarkXml(
    name: string,
    styleId: string,
    geometry: GeoJsonGeometry,
    extraData?: Record<string, string>,
): string {
    const ext =
        extraData && Object.keys(extraData).length > 0
            ? `<ExtendedData>${Object.entries(extraData)
                  .map(
                      ([k, v]) =>
                          `<Data name="${escapeXml(k)}"><value>${escapeXml(v)}</value></Data>`,
                  )
                  .join("")}</ExtendedData>`
            : "";
    return `      <Placemark><name>${escapeXml(name)}</name><styleUrl>#${escapeXml(styleId)}</styleUrl>${ext}${geometryKml(geometry)}</Placemark>`;
}

function pointStyleXml(id: string, hexColor: string): string {
    return [
        `    <Style id="${escapeXml(id)}">`,
        `      <IconStyle>`,
        `        <color>${hexToKmlColor(hexColor, "ff")}</color>`,
        `        <scale>1.0</scale>`,
        `        <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>`,
        `      </IconStyle>`,
        `    </Style>`,
    ].join("\n");
}

function polyStyleXml(
    id: string,
    hexColor: string,
    lineWidth: number,
    fillAlpha: string,
): string {
    return [
        `    <Style id="${escapeXml(id)}">`,
        `      <LineStyle><color>${hexToKmlColor(hexColor, "ff")}</color><width>${lineWidth}</width></LineStyle>`,
        `      <PolyStyle><color>${hexToKmlColor(hexColor, fillAlpha)}</color></PolyStyle>`,
        `    </Style>`,
    ].join("\n");
}

function inferThematicGroup(layerName: string): string {
    const lower = layerName.toLowerCase();
    if (
        /hospital|airport|university|college|library|consulate|embassy|station|school|clinic|pharmacy/.test(
            lower,
        )
    ) {
        return "Public Amenities";
    }
    if (
        /park|mountain|peak|golf|beach|lake|forest|nature|garden|trail/.test(
            lower,
        )
    ) {
        return "Nature & Leisure";
    }
    return "Places of Interest";
}

/**
 * Plans how Searchlight layers map into Google My Maps KML folders.
 *
 * By default:
 * - Base layers (Play Area, Stations, optional Hiding Zone Circles) and
 *   non-POI feature layers (Polygons & Lines) each get their own folder.
 * - Point (POI) layers automatically fill the remaining slots up to
 *   `maxLayers` (default 9 for mobile Google Maps): if enough slots exist,
 *   each POI gets its own folder; otherwise POIs pack into thematic groups
 *   (Public Amenities, Places of Interest, Nature & Leisure) or 1 POIs folder.
 * - Any layer (Point, Line, or Polygon) can be overridden via
 *   `options.layerFolderOverrides` to place it in any chosen folder.
 */
export function planKmlFolders(
    definition: GameDefinition,
    options: KmlExportOptions = {},
): KmlFolderPlanResult {
    const maxLayers = Math.max(
        1,
        Math.min(
            MY_MAPS_DESKTOP_MAX_LAYERS,
            Math.round(options.maxLayers ?? MY_MAPS_MOBILE_MAX_LAYERS),
        ),
    );
    const includePlayArea = options.includePlayArea ?? true;
    const includeCircles = options.includeHidingZoneCircles ?? false;
    const autoPackPois = options.combinePoisForMyMaps !== false;

    const baseFolders: KmlFolderPlan[] = [];
    if (includePlayArea && definition.map.playArea.features.length > 0) {
        baseFolders.push({
            name: "Play Area",
            kind: "base",
            layerNames: [],
            featureCount: definition.map.playArea.features.length,
        });
    }
    const stationCount = definition.hidingZones.features.features.length;
    if (stationCount > 0) {
        baseFolders.push({
            name: "Stations",
            kind: "base",
            layerNames: [],
            featureCount: stationCount,
        });
    }
    if (includeCircles && stationCount > 0) {
        baseFolders.push({
            name: "Hiding Zone Circles",
            kind: "base",
            layerNames: [],
            featureCount: stationCount,
        });
    }

    const activeLayers = (definition.features ?? []).filter(
        (l) => l.data.features.length > 0,
    );
    const isPoiLayer = (l: (typeof activeLayers)[number]) =>
        l.data.features.every((f) => f.geometry.type === "Point");

    const assignments = Object.create(null) as Record<string, string>;
    const fixedFeatureFolderNames = new Set<string>();
    const autoPois: (typeof activeLayers)[number][] = [];

    // 1. Assign all overridden layers and all non-POI (polygon/line) layers first.
    for (const layer of activeLayers) {
        const override = ownString(options.layerFolderOverrides, layer.name);
        if (override) {
            assignments[layer.name] = override;
            fixedFeatureFolderNames.add(override);
        } else if (!isPoiLayer(layer) || !autoPackPois) {
            assignments[layer.name] = layer.name;
            fixedFeatureFolderNames.add(layer.name);
        } else {
            autoPois.push(layer);
        }
    }

    // 2. Pack auto-assigned POI layers into the remaining slots up to `maxLayers`.
    const remainingSlots =
        maxLayers - baseFolders.length - fixedFeatureFolderNames.size;

    if (autoPois.length > 0) {
        if (autoPois.length <= remainingSlots) {
            // Plenty of room: every POI layer gets its own dedicated folder.
            for (const layer of autoPois) {
                assignments[layer.name] = layer.name;
            }
        } else if (remainingSlots <= 1) {
            // Only 1 (or 0) slot left: pack all auto POIs into one "POIs" folder.
            for (const layer of autoPois) {
                assignments[layer.name] = "POIs";
            }
        } else {
            // 2+ slots available: start from thematic groups, then expand or merge
            // to use all `remainingSlots` cleanly.
            const buckets = new Map<string, (typeof activeLayers)[number][]>();
            for (const layer of autoPois) {
                const groupName =
                    ownString(options.layerGroups, layer.name) ??
                    inferThematicGroup(layer.name);
                const list = buckets.get(groupName) ?? [];
                list.push(layer);
                buckets.set(groupName, list);
            }

            // If a thematic bucket has only 1 layer, rename it to that layer's own name.
            const groups: Array<{
                name: string;
                layers: (typeof activeLayers)[number][];
            }> = [...buckets.entries()].map(([name, layers]) => ({
                name: layers.length === 1 ? layers[0].name : name,
                layers,
            }));

            // Too many groups for remainingSlots -> merge the two smallest groups until it fits.
            while (groups.length > remainingSlots) {
                groups.sort((a, b) => a.layers.length - b.layers.length);
                const a = groups.shift()!;
                const b = groups.shift()!;
                groups.push({
                    name:
                        b.layers.length > 1
                            ? b.name
                            : a.layers.length > 1
                              ? a.name
                              : "Places of Interest",
                    layers: [...b.layers, ...a.layers],
                });
            }

            // Extra free slots -> peel off the largest layer from the biggest multi-layer group
            // into its own dedicated folder so no available slot goes unused.
            while (groups.length < remainingSlots) {
                const splittable = groups
                    .filter((g) => g.layers.length > 1)
                    .sort((a, b) => b.layers.length - a.layers.length)[0];
                if (!splittable) break;
                // Extract the layer with the most features so crowded layers get their own folder.
                splittable.layers.sort(
                    (a, b) =>
                        b.data.features.length - a.data.features.length,
                );
                const peeled = splittable.layers.shift()!;
                if (splittable.layers.length === 1) {
                    splittable.name = splittable.layers[0].name;
                }
                groups.push({ name: peeled.name, layers: [peeled] });
            }

            for (const g of groups) {
                for (const layer of g.layers) {
                    assignments[layer.name] = g.name;
                }
            }
        }
    }

    // 3. Build ordered folder plans (base folders first, then feature folders in order of appearance).
    const featureFolderMap = new Map<string, KmlFolderPlan>();
    for (const layer of activeLayers) {
        const folderName = assignments[layer.name] ?? layer.name;
        const existing = featureFolderMap.get(folderName);
        if (existing) {
            existing.layerNames.push(layer.name);
            existing.featureCount += layer.data.features.length;
        } else {
            featureFolderMap.set(folderName, {
                name: folderName,
                kind: "features",
                layerNames: [layer.name],
                featureCount: layer.data.features.length,
            });
        }
    }

    const folders: KmlFolderPlan[] = [
        ...baseFolders,
        ...featureFolderMap.values(),
    ];

    const warnings: string[] = [];
    if (folders.length > maxLayers) {
        warnings.push(
            `This KML has ${folders.length} layers (target limit is ${maxLayers}; mobile Google Maps displays at most ${MY_MAPS_MOBILE_MAX_LAYERS} layers). Group some layers together or lower included base layers.`,
        );
    } else if (folders.length > MY_MAPS_MOBILE_MAX_LAYERS) {
        warnings.push(
            `This KML has ${folders.length} layers (mobile Google Maps only displays ${MY_MAPS_MOBILE_MAX_LAYERS} layers, though desktop My Maps supports ${MY_MAPS_DESKTOP_MAX_LAYERS}).`,
        );
    }
    for (const folder of folders) {
        if (folder.featureCount > MY_MAPS_MAX_FEATURES_PER_LAYER) {
            warnings.push(
                `Layer "${folder.name}" has ${folder.featureCount} features (Google My Maps allows at most ${MY_MAPS_MAX_FEATURES_PER_LAYER} per layer).`,
            );
        }
    }

    return {
        folders,
        layerAssignments: assignments,
        totalFolders: folders.length,
        maxLayers,
        warnings,
    };
}

/**
 * Generates a Google My Maps-compatible KML 2.2 document for a Searchlight
 * GameDefinition, along with warnings if Google My Maps limits would be exceeded.
 */
export function buildGameKml(
    definition: GameDefinition,
    options: KmlExportOptions = {},
): KmlExportResult {
    const plan = planKmlFolders(definition, options);
    const includePlayArea = options.includePlayArea ?? true;
    const includeCircles = options.includeHidingZoneCircles ?? false;

    const styles: string[] = [
        polyStyleXml("play-area", "#111827", 3, "14"),
        pointStyleXml("station", "#2563eb"),
        polyStyleXml("zone-circle", "#2563eb", 1.5, "22"),
    ];

    const folders: Array<{ name: string; placemarks: string[] }> = [];

    // 1. Play area folder (optional)
    if (includePlayArea && definition.map.playArea.features.length > 0) {
        folders.push({
            name: "Play Area",
            placemarks: definition.map.playArea.features.map((f, i) =>
                placemarkXml(
                    typeof f.properties?.name === "string" && f.properties.name
                        ? f.properties.name
                        : `${definition.name} Play Area${i > 0 ? ` ${i + 1}` : ""}`,
                    "play-area",
                    f.geometry,
                ),
            ),
        });
    }

    // 2. Hiding zones (stations) folder
    if (definition.hidingZones.features.features.length > 0) {
        folders.push({
            name: "Stations",
            placemarks: definition.hidingZones.features.features.map((f, i) => {
                const name =
                    typeof f.properties?.name === "string" && f.properties.name
                        ? f.properties.name
                        : `Zone ${i + 1}`;
                const extra: Record<string, string> = {};
                const rawTier = f.properties?.tier;
                if (
                    rawTier !== undefined &&
                    rawTier !== null &&
                    String(rawTier).trim() !== ""
                ) {
                    extra.tier = String(rawTier).trim();
                }
                return placemarkXml(name, "station", f.geometry, extra);
            }),
        });
    }

    // 3. Optional hiding zone circle polygons
    if (includeCircles && definition.hidingZones.features.features.length > 0) {
        const compiled = compileGameDefinition(definition);
        const circles = hidingZoneCircles(compiled);
        const circlePlacemarks: string[] = [];
        for (const circle of circles) {
            const geom = circle.geometry;
            if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") {
                continue;
            }
            const simplified = turf.truncate(circle, { precision: 6 });
            const stationName = circle.properties?.properties?.name;
            const name =
                typeof stationName === "string" && stationName
                    ? stationName
                    : "Hiding Zone";
            circlePlacemarks.push(
                placemarkXml(
                    name,
                    "zone-circle",
                    simplified.geometry as GeoJsonGeometry,
                ),
            );
        }
        if (circlePlacemarks.length > 0) {
            folders.push({
                name: "Hiding Zone Circles",
                placemarks: circlePlacemarks,
            });
        }
    }

    // 4. Feature layers grouped according to `plan.layerAssignments`
    const featureFolderBuckets = new Map<string, string[]>();
    const layers = (definition.features ?? []).filter(
        (l) => l.data.features.length > 0,
    );
    const layerCountByFolder = new Map<string, number>();
    for (const layer of layers) {
        const folderName = plan.layerAssignments[layer.name] ?? layer.name;
        layerCountByFolder.set(
            folderName,
            (layerCountByFolder.get(folderName) ?? 0) + 1,
        );
    }

    layers.forEach((layer, idx) => {
        const color =
            ownString(options.layerColors, layer.name) ??
            FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
        const styleId = `layer-${idx}`;
        const allPoints = layer.data.features.every(
            (f) => f.geometry.type === "Point",
        );

        styles.push(
            allPoints
                ? pointStyleXml(styleId, color)
                : polyStyleXml(styleId, color, 2, "26"),
        );

        const folderName = plan.layerAssignments[layer.name] ?? layer.name;
        const isSharedFolder = (layerCountByFolder.get(folderName) ?? 1) > 1;

        const placemarks = layer.data.features.map((f, fIdx) => {
            const name =
                typeof f.properties?.name === "string" && f.properties.name
                    ? f.properties.name
                    : `${layer.name} ${fIdx + 1}`;
            return placemarkXml(
                name,
                styleId,
                f.geometry,
                isSharedFolder
                    ? { type: layer.name, category: layer.name }
                    : undefined,
            );
        });

        const bucket = featureFolderBuckets.get(folderName) ?? [];
        bucket.push(...placemarks);
        featureFolderBuckets.set(folderName, bucket);
    });

    for (const [name, placemarks] of featureFolderBuckets.entries()) {
        if (placemarks.length > 0) {
            folders.push({ name, placemarks });
        }
    }

    const folderXml = folders
        .map(
            (folder) =>
                `    <Folder>\n      <name>${escapeXml(folder.name)}</name>\n${folder.placemarks.join("\n")}\n    </Folder>`,
        )
        .join("\n");

    const kml = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<kml xmlns="http://www.opengis.net/kml/2.2">`,
        `  <Document>`,
        `    <name>${escapeXml(definition.name)}</name>`,
        styles.join("\n"),
        folderXml,
        `  </Document>`,
        `</kml>`,
        "",
    ].join("\n");

    const byteLength = new TextEncoder().encode(kml).byteLength;
    const myMapsWarnings = [...plan.warnings];
    if (byteLength > MY_MAPS_MAX_BYTES) {
        myMapsWarnings.push(
            `KML file is ${(byteLength / (1024 * 1024)).toFixed(1)} MB (Google My Maps limit is 5 MB).`,
        );
    }

    return {
        kml,
        folderCount: folders.length,
        byteLength,
        myMapsWarnings,
        plan,
    };
}
