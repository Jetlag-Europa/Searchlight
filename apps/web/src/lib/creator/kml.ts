import type { FeatureIcon, GameDefinition, GeoJsonGeometry, Position } from "@searchlight/shared";
import * as turf from "@turf/turf";

import { compileGameDefinition } from "@/game-definition/compile";
import {
  FEATURE_ICON_META,
  inferLayerColor,
  inferLayerIcon,
  REGION_POLY_PALETTE,
} from "@/lib/creator/presets";
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
  /** Optional `#rrggbb` color override per Searchlight layer name (falls back to `layer.color`). */
  layerColors?: Record<string, string>;
  /** Optional semantic icon override per Searchlight layer name (falls back to `layer.icon`). */
  layerIcons?: Record<string, FeatureIcon>;
  /** Optional thematic group hint per POI layer name (e.g. "Public Amenities"). */
  layerGroups?: Record<string, string>;
  /**
   * Optional manual KML folder assignment per Searchlight layer name.
   * Works for ANY layer (Points, Lines, or Polygons) so users can override
   * auto-grouping (e.g. combine two line layers or a line + POI layer).
   */
  layerFolderOverrides?: Record<string, string>;
  /**
   * When set, exports ONLY the single planned KML folder with this exact name
   * (useful for Google My Maps "Reimport and merge -> Replace all items").
   */
  onlyFolder?: string;
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

function ownString(record: Record<string, string> | undefined, key: string): string | undefined {
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

function orientRingForKml(ring: readonly Position[], clockwise: boolean): readonly Position[] {
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
        .map((line) => `<LineString><coordinates>${coordsText(line)}</coordinates></LineString>`)
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
          .map(([k, v]) => `<Data name="${escapeXml(k)}"><value>${escapeXml(v)}</value></Data>`)
          .join("")}</ExtendedData>`
      : "";
  return `      <Placemark><name>${escapeXml(name)}</name><styleUrl>#${escapeXml(styleId)}</styleUrl>${ext}${geometryKml(geometry)}</Placemark>`;
}

const MY_MAPS_BLANK_PIN_HREF =
  "https://www.gstatic.com/mapspro/images/stock/503-wht-blank_maps.png";

function normalizeHex6(hex: string, fallback = "0288D1"): string {
  const clean = hex.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
}

/**
 * Emits Google My Maps's native `<Style>` + `<StyleMap>` pair for a built-in
 * POI icon (`icon-<id>-<RRGGBB>`), with hover-only labels (`LabelStyle` 0 → 1)
 * and the stock tintable pin fallback URL for Google Earth / other viewers.
 */
function myMapsPointStyleXml(
  icon: FeatureIcon,
  hexColor: string,
): { styleId: string; xml: string } {
  const iconId = FEATURE_ICON_META[icon]?.myMapsId ?? 1899;
  const hex6 = normalizeHex6(hexColor);
  const styleId = `icon-${iconId}-${hex6}`;
  const kmlColor = hexToKmlColor(`#${hex6}`, "ff");
  const xml = [
    `    <Style id="${styleId}-normal">`,
    `      <IconStyle>`,
    `        <color>${kmlColor}</color>`,
    `        <scale>1</scale>`,
    `        <Icon><href>${MY_MAPS_BLANK_PIN_HREF}</href></Icon>`,
    `      </IconStyle>`,
    `      <LabelStyle><scale>0</scale></LabelStyle>`,
    `    </Style>`,
    `    <Style id="${styleId}-highlight">`,
    `      <IconStyle>`,
    `        <color>${kmlColor}</color>`,
    `        <scale>1</scale>`,
    `        <Icon><href>${MY_MAPS_BLANK_PIN_HREF}</href></Icon>`,
    `      </IconStyle>`,
    `      <LabelStyle><scale>1</scale></LabelStyle>`,
    `    </Style>`,
    `    <StyleMap id="${styleId}">`,
    `      <Pair><key>normal</key><styleUrl>#${styleId}-normal</styleUrl></Pair>`,
    `      <Pair><key>highlight</key><styleUrl>#${styleId}-highlight</styleUrl></Pair>`,
    `    </StyleMap>`,
  ].join("\n");
  return { styleId, xml };
}

function lineStyleXml(hexColor: string, lineWidth: number): { styleId: string; xml: string } {
  const hex6 = normalizeHex6(hexColor, "000000");
  const widthTag = Math.round(lineWidth * 1000);
  const styleId = `line-${hex6}-${widthTag}`;
  const xml = [
    `    <Style id="${styleId}">`,
    `      <LineStyle><color>${hexToKmlColor(`#${hex6}`, "ff")}</color><width>${lineWidth}</width></LineStyle>`,
    `    </Style>`,
  ].join("\n");
  return { styleId, xml };
}

function polyStyleXml(
  hexColor: string,
  lineWidth: number,
  fillAlpha: string,
): { styleId: string; xml: string } {
  const hex6 = normalizeHex6(hexColor, "000000");
  const widthTag = Math.round(lineWidth * 1000);
  const alphaDec = parseInt(fillAlpha, 16);
  const styleId = `poly-${hex6}-${widthTag}-${alphaDec}`;
  const xml = [
    `    <Style id="${styleId}">`,
    `      <LineStyle><color>${hexToKmlColor(`#${hex6}`, "ff")}</color><width>${lineWidth}</width></LineStyle>`,
    `      <PolyStyle><color>${hexToKmlColor(`#${hex6}`, fillAlpha)}</color></PolyStyle>`,
    `    </Style>`,
  ].join("\n");
  return { styleId, xml };
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
  if (/park|mountain|peak|golf|beach|lake|forest|nature|garden|trail/.test(lower)) {
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

  const activeLayers = (definition.features ?? []).filter((l) => l.data.features.length > 0);
  const isPoiLayer = (l: (typeof activeLayers)[number]) =>
    l.data.features.every((f) => f.geometry.type === "Point");

  const assignments = Object.create(null) as Record<string, string>;
  const fixedFeatureFolderNames = new Set<string>();
  const autoPois: (typeof activeLayers)[number][] = [];

  // 1. Assign all overridden layers, persisted `layer.kmlFolder` layers,
  //    and non-POI (polygon/line) layers first.
  for (const layer of activeLayers) {
    const override =
      ownString(options.layerFolderOverrides, layer.name) ??
      (typeof layer.kmlFolder === "string" && layer.kmlFolder.trim()
        ? layer.kmlFolder.trim()
        : undefined);
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
  const remainingSlots = maxLayers - baseFolders.length - fixedFeatureFolderNames.size;

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
          ownString(options.layerGroups, layer.name) ?? inferThematicGroup(layer.name);
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
          name: b.layers.length > 1 ? b.name : a.layers.length > 1 ? a.name : "Places of Interest",
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
        splittable.layers.sort((a, b) => b.data.features.length - a.data.features.length);
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
  // Disambiguate any feature folder whose name collides with an active base folder
  // while reserving all existing non-colliding feature folder names so distinct folders never merge.
  const baseFolderNames = new Set(baseFolders.map((f) => f.name));
  const usedFolderNames = new Set(baseFolderNames);
  for (const layer of activeLayers) {
    const raw = assignments[layer.name] ?? layer.name;
    if (!baseFolderNames.has(raw)) usedFolderNames.add(raw);
  }
  const baseCollisionAliases = new Map<string, string>();
  const disambiguateFolder = (name: string) => {
    if (!baseFolderNames.has(name)) return name;
    const existingAlias = baseCollisionAliases.get(name);
    if (existingAlias) return existingAlias;
    let candidate = `${name} (Features)`;
    let n = 2;
    while (usedFolderNames.has(candidate)) {
      candidate = `${name} (Features ${n++})`;
    }
    usedFolderNames.add(candidate);
    baseCollisionAliases.set(name, candidate);
    return candidate;
  };
  const featureFolderMap = new Map<string, KmlFolderPlan>();
  for (const layer of activeLayers) {
    const folderName = disambiguateFolder(assignments[layer.name] ?? layer.name);
    assignments[layer.name] = folderName;
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

  const folders: KmlFolderPlan[] = [...baseFolders, ...featureFolderMap.values()];

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
  const onlyFolder = options.onlyFolder?.trim() || undefined;
  const wantFolder = (name: string) => !onlyFolder || name === onlyFolder;

  const styles: string[] = [];
  const emittedStyleIds = new Set<string>();
  const ensureStyle = (defStyle: { styleId: string; xml: string }) => {
    if (!emittedStyleIds.has(defStyle.styleId)) {
      emittedStyleIds.add(defStyle.styleId);
      styles.push(defStyle.xml);
    }
    return defStyle.styleId;
  };

  const folders: Array<{ name: string; placemarks: string[] }> = [];

  // 1. Play area folder (optional)
  if (includePlayArea && wantFolder("Play Area") && definition.map.playArea.features.length > 0) {
    const playAreaStyleId = ensureStyle(polyStyleXml("#111827", 2.5, "14"));
    folders.push({
      name: "Play Area",
      placemarks: definition.map.playArea.features.map((f, i) =>
        placemarkXml(
          typeof f.properties?.name === "string" && f.properties.name
            ? f.properties.name
            : `${definition.name} Play Area${i > 0 ? ` ${i + 1}` : ""}`,
          playAreaStyleId,
          f.geometry,
        ),
      ),
    });
  }

  const compiled = compileGameDefinition(definition);

  // 2. Hiding zones (stations) folder
  if (wantFolder("Stations") && definition.hidingZones.features.features.length > 0) {
    const hasPointZones = definition.hidingZones.features.features.some(
      (f) => f.geometry.type === "Point",
    );
    const hasPolyZones = definition.hidingZones.features.features.some(
      (f) => f.geometry.type !== "Point",
    );
    const stationStyleId = hasPointZones
      ? ensureStyle(myMapsPointStyleXml("station", "#1A237E"))
      : "";
    const polyZoneStyleId = hasPolyZones ? ensureStyle(polyStyleXml("#1A237E", 1.5, "26")) : "";
    folders.push({
      name: "Stations",
      placemarks: definition.hidingZones.features.features.map((f, i) => {
        const name =
          typeof f.properties?.name === "string" && f.properties.name
            ? f.properties.name
            : `Zone ${i + 1}`;
        const extra: Record<string, string> = {};
        const rawTier = f.properties?.tier;
        if (rawTier !== undefined && rawTier !== null && String(rawTier).trim() !== "") {
          extra.tier = String(rawTier).trim();
        }
        // The radius goes with each station, so re-importing the file keeps it.
        const radius = compiled.hidingZones.stations?.[i]?.radius;
        if (f.geometry.type === "Point" && radius) {
          // Exact: convertDistanceUnit rounds miles to 2 significant figures.
          extra.radius_m = String(turf.convertLength(radius.value, radius.unit, "meters"));
        }
        const styleId = f.geometry.type === "Point" ? stationStyleId : polyZoneStyleId;
        return placemarkXml(name, styleId, f.geometry, extra);
      }),
    });
  }

  // 3. Optional hiding zone circle outlines (line rings keep My Maps readable)
  if (
    includeCircles &&
    wantFolder("Hiding Zone Circles") &&
    definition.hidingZones.features.features.length > 0
  ) {
    const zoneCircleStyleId = ensureStyle(lineStyleXml("#1A237E", 1.5));
    const circles = hidingZoneCircles(compiled);
    const circlePlacemarks: string[] = [];
    for (const circle of circles) {
      const geom = circle.geometry;
      if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") {
        continue;
      }
      const simplified = turf.truncate(circle, { precision: 6 });
      const stationName = circle.properties?.properties?.name;
      const name = typeof stationName === "string" && stationName ? stationName : "Hiding Zone";
      const rawRings =
        simplified.geometry.type === "Polygon"
          ? [simplified.geometry.coordinates[0]]
          : simplified.geometry.coordinates.map((poly) => poly[0]);
      const rings: Position[][] = rawRings.map((ring) =>
        ring.map(([lng, lat]) => [lng, lat] as Position),
      );
      const ringGeom: GeoJsonGeometry =
        rings.length === 1
          ? { type: "LineString", coordinates: rings[0] }
          : { type: "MultiLineString", coordinates: rings };
      circlePlacemarks.push(placemarkXml(name, zoneCircleStyleId, ringGeom));
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
  const layers = (definition.features ?? []).filter((l) => l.data.features.length > 0);
  const layerCountByFolder = new Map<string, number>();
  for (const layer of layers) {
    const folderName = plan.layerAssignments[layer.name] ?? layer.name;
    layerCountByFolder.set(folderName, (layerCountByFolder.get(folderName) ?? 0) + 1);
  }

  layers.forEach((layer, idx) => {
    const folderName = plan.layerAssignments[layer.name] ?? layer.name;
    if (!wantFolder(folderName)) return;

    const explicitColor = ownString(options.layerColors, layer.name) ?? layer.color;
    const color = explicitColor ?? inferLayerColor(layer.name, idx);
    const icon: FeatureIcon =
      (options.layerIcons && Object.prototype.hasOwnProperty.call(options.layerIcons, layer.name)
        ? options.layerIcons[layer.name]
        : undefined) ??
      layer.icon ??
      inferLayerIcon(layer.name);

    const allPoints = layer.data.features.every((f) => f.geometry.type === "Point");
    const allLines = layer.data.features.every(
      (f) => f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
    );
    // Uncolored small multi-region polygon layers (2-15 regions) get distinct
    // per-region colors automatically; an explicit layer color is always honored.
    const usePerRegionColors =
      !explicitColor &&
      !allPoints &&
      !allLines &&
      layer.data.features.length >= 2 &&
      layer.data.features.length <= REGION_POLY_PALETTE.length;

    const baseStyleId = allPoints
      ? ensureStyle(myMapsPointStyleXml(icon, color))
      : allLines
        ? ensureStyle(lineStyleXml(color, 2.4))
        : ensureStyle(polyStyleXml(color, 1.2, "20"));

    const isSharedFolder = (layerCountByFolder.get(folderName) ?? 1) > 1;

    const placemarks = layer.data.features.map((f, fIdx) => {
      const name =
        typeof f.properties?.name === "string" && f.properties.name
          ? f.properties.name
          : `${layer.name} ${fIdx + 1}`;
      const featureStyleId = usePerRegionColors
        ? ensureStyle(
            polyStyleXml(REGION_POLY_PALETTE[fIdx % REGION_POLY_PALETTE.length], 1.2, "4c"),
          )
        : baseStyleId;
      return placemarkXml(
        name,
        featureStyleId,
        f.geometry,
        isSharedFolder ? { type: layer.name, category: layer.name } : undefined,
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

  const docName = onlyFolder || definition.name;
  const kml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<kml xmlns="http://www.opengis.net/kml/2.2">`,
    `  <Document>`,
    `    <name>${escapeXml(docName)}</name>`,
    styles.join("\n"),
    folderXml,
    `  </Document>`,
    `</kml>`,
    "",
  ].join("\n");

  const byteLength = new TextEncoder().encode(kml).byteLength;
  const myMapsWarnings = onlyFolder
    ? folders
        .filter((f) => f.placemarks.length > MY_MAPS_MAX_FEATURES_PER_LAYER)
        .map(
          (f) =>
            `Layer "${f.name}" has ${f.placemarks.length} features (Google My Maps allows at most ${MY_MAPS_MAX_FEATURES_PER_LAYER} per layer).`,
        )
    : [...plan.warnings];
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
