import type {
    GameDefinition,
    GeoJsonGeometry,
    Position,
} from "@searchlight/shared";
import * as turf from "@turf/turf";

import { compileGameDefinition } from "@/game-definition/compile";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";

export interface KmlExportOptions {
    /**
     * Merges all point POI layers into a single styled "POIs" folder so the
     * KML stays within Google My Maps' 10-layer hard limit.
     */
    combinePoisForMyMaps?: boolean;
    /** Adds a "Hiding Zone Circles" folder with polygon circles per station. */
    includeHidingZoneCircles?: boolean;
    /** Optional hex color per feature layer name (e.g. "#e11d48"). */
    layerColors?: Record<string, string>;
}

export interface KmlExportResult {
    kml: string;
    folderCount: number;
    maxFeaturesPerFolder: number;
    byteLength: number;
    myMapsWarnings: string[];
}

const MY_MAPS_MAX_LAYERS = 10;
const MY_MAPS_MAX_FEATURES_PER_LAYER = 2000;
const MY_MAPS_MAX_BYTES = 5 * 1024 * 1024;

const FALLBACK_COLORS = [
    "#e11d48",
    "#7c3aed",
    "#0891b2",
    "#ea580c",
    "#16a34a",
    "#c026d3",
    "#ca8a04",
    "#4f46e5",
];

// XML 1.0 forbids C0 control characters other than HT (0x09), LF (0x0A), CR (0x0D),
// as well as U+FFFE and U+FFFF. Strip them so OSM tags can never corrupt the KML.
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
    description?: string,
    extraData?: Record<string, string>,
): string {
    const desc = description
        ? `<description>${escapeXml(description)}</description>`
        : "";
    const ext =
        extraData && Object.keys(extraData).length > 0
            ? `<ExtendedData>${Object.entries(extraData)
                  .map(
                      ([k, v]) =>
                          `<Data name="${escapeXml(k)}"><value>${escapeXml(v)}</value></Data>`,
                  )
                  .join("")}</ExtendedData>`
            : "";
    return `      <Placemark><name>${escapeXml(name)}</name>${desc}<styleUrl>#${escapeXml(styleId)}</styleUrl>${ext}${geometryKml(geometry)}</Placemark>`;
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

/**
 * Generates a Google My Maps-compatible KML 2.2 document for a Searchlight
 * GameDefinition, along with warnings if Google My Maps import limits would
 * be exceeded.
 */
export function buildGameKml(
    definition: GameDefinition,
    options: KmlExportOptions = {},
): KmlExportResult {
    const combinePois = options.combinePoisForMyMaps ?? true;
    const includeCircles = options.includeHidingZoneCircles ?? false;
    const styles: string[] = [
        polyStyleXml("play-area", "#111827", 3, "14"),
        pointStyleXml("station", "#2563eb"),
        polyStyleXml("zone-circle", "#2563eb", 1.5, "22"),
    ];

    const folders: Array<{ name: string; placemarks: string[] }> = [];

    // 1. Play area folder
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
                return placemarkXml(
                    name,
                    "station",
                    f.geometry,
                    undefined,
                    extra,
                );
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

    // 4. Feature layers
    const combinedPoiPlacemarks: string[] = [];
    const layers = definition.features ?? [];
    layers.forEach((layer, idx) => {
        const customColor =
            options.layerColors &&
            Object.prototype.hasOwnProperty.call(
                options.layerColors,
                layer.name,
            ) &&
            typeof options.layerColors[layer.name] === "string"
                ? options.layerColors[layer.name]
                : undefined;
        const color =
            customColor ?? FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
        const styleId = `layer-${idx}`;
        const allPoints = layer.data.features.every(
            (f) => f.geometry.type === "Point",
        );

        styles.push(
            allPoints
                ? pointStyleXml(styleId, color)
                : polyStyleXml(styleId, color, 2, "26"),
        );

        const placemarks = layer.data.features.map((f, fIdx) => {
            const name =
                typeof f.properties?.name === "string" && f.properties.name
                    ? f.properties.name
                    : `${layer.name} ${fIdx + 1}`;
            return placemarkXml(
                name,
                styleId,
                f.geometry,
                undefined,
                combinePois && allPoints ? { category: layer.name } : undefined,
            );
        });

        if (combinePois && allPoints) {
            combinedPoiPlacemarks.push(...placemarks);
        } else if (placemarks.length > 0) {
            folders.push({ name: layer.name, placemarks });
        }
    });

    if (combinedPoiPlacemarks.length > 0) {
        folders.push({ name: "POIs", placemarks: combinedPoiPlacemarks });
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
        ...styles,
        folderXml,
        `  </Document>`,
        `</kml>`,
        "",
    ].join("\n");

    const byteLength = new TextEncoder().encode(kml).byteLength;
    const maxFeaturesPerFolder = folders.reduce(
        (max, f) => Math.max(max, f.placemarks.length),
        0,
    );
    const myMapsWarnings: string[] = [];
    if (folders.length > MY_MAPS_MAX_LAYERS) {
        myMapsWarnings.push(
            `Google My Maps allows at most ${MY_MAPS_MAX_LAYERS} layers (this KML has ${folders.length}). Enable "Combine POIs into one layer" to fit.`,
        );
    }
    if (maxFeaturesPerFolder > MY_MAPS_MAX_FEATURES_PER_LAYER) {
        myMapsWarnings.push(
            `Google My Maps allows at most ${MY_MAPS_MAX_FEATURES_PER_LAYER} features per layer (a layer here has ${maxFeaturesPerFolder}). Try pruning pins or turning off "Combine POIs".`,
        );
    }
    if (byteLength > MY_MAPS_MAX_BYTES) {
        myMapsWarnings.push(
            `Google My Maps limits KML imports to 5 MB (this file is ${(byteLength / (1024 * 1024)).toFixed(1)} MB).`,
        );
    }

    return {
        kml,
        folderCount: folders.length,
        maxFeaturesPerFolder,
        byteLength,
        myMapsWarnings,
    };
}
