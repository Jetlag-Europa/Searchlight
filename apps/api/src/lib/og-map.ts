import { renderAsync } from "@resvg/resvg-js";

// The image link previews (Discord, Slack, ...) show for a game link: the
// game's play area and hiding zones on a plain background. 1200×630 is the
// size every platform's large preview card is made for.

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
const PADDING = 48;
// Points closer than this to the last one kept, in pixels, are dropped: a
// country outline has far more points than the image can show.
const MIN_STEP = 0.75;
const STATION_RADIUS = 4;

const BACKGROUND = "#1F2F3F";
const PLAY_AREA_FILL = "rgba(42, 129, 203, 0.25)";
const PLAY_AREA_STROKE = "#2A81CB";
const ZONE_FILL = "rgba(255, 255, 255, 0.85)";

type Position = [number, number];
type Ring = Position[];
type Polygon = Ring[];

interface Geometry {
  type?: unknown;
  coordinates?: unknown;
}

// The parts of a game definition the image uses. Revisions are stored as
// JSON, so every field is checked rather than trusted.
interface MapDefinition {
  map?: { playArea?: { features?: Array<{ geometry?: Geometry }> } };
  hidingZones?: { features?: { features?: Array<{ geometry?: Geometry }> } };
}

function polygonsOf(geometry: Geometry | undefined): Polygon[] {
  if (!geometry || !Array.isArray(geometry.coordinates)) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as Polygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as Polygon[];
  return [];
}

function pointOf(geometry: Geometry | undefined): Position | null {
  if (geometry?.type !== "Point" || !Array.isArray(geometry.coordinates)) return null;
  const [lng, lat] = geometry.coordinates as unknown[];
  return typeof lng === "number" && typeof lat === "number" ? [lng, lat] : null;
}

// Web Mercator, as on the app's map, in radians: y grows northwards.
function mercator([lng, lat]: Position): Position {
  const clamped = Math.max(-85, Math.min(85, lat));
  return [
    (lng * Math.PI) / 180,
    Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)),
  ];
}

function round(n: number) {
  return Math.round(n * 10) / 10;
}

// The SVG for a game definition, or null if it has no play area to draw.
export function gameMapSvg(definition: unknown): string | null {
  const def = (definition ?? {}) as MapDefinition;
  const playArea = (def.map?.playArea?.features ?? []).flatMap((f) => polygonsOf(f?.geometry));
  const zoneFeatures = def.hidingZones?.features?.features ?? [];
  const zoneAreas = zoneFeatures.flatMap((f) => polygonsOf(f?.geometry));
  const stations = zoneFeatures.map((f) => pointOf(f?.geometry)).filter((p) => p !== null);

  // Fit the play area, which every zone is meant to lie within.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of playArea) {
    for (const [x, y] of polygon[0]?.map(mercator) ?? []) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;

  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const scale = Math.min(
    (OG_IMAGE_WIDTH - 2 * PADDING) / spanX,
    (OG_IMAGE_HEIGHT - 2 * PADDING) / spanY,
  );
  const offsetX = (OG_IMAGE_WIDTH - spanX * scale) / 2;
  const offsetY = (OG_IMAGE_HEIGHT - spanY * scale) / 2;
  const project = (position: Position): Position => {
    const [x, y] = mercator(position);
    return [offsetX + (x - minX) * scale, offsetY + (maxY - y) * scale];
  };

  const ringPath = (ring: Ring) => {
    const points: Position[] = [];
    for (const position of ring) {
      const point = project(position);
      const last = points[points.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= MIN_STEP) {
        points.push(point);
      }
    }
    if (points.length < 3) return "";
    return `M${points.map(([x, y]) => `${round(x)} ${round(y)}`).join("L")}Z`;
  };
  // One path per polygon, so its holes cut out of it with the even-odd rule.
  const polygonPaths = (polygons: Polygon[]) =>
    polygons.map((polygon) => polygon.map(ringPath).join("")).filter(Boolean);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_IMAGE_WIDTH}" height="${OG_IMAGE_HEIGHT}" viewBox="0 0 ${OG_IMAGE_WIDTH} ${OG_IMAGE_HEIGHT}">`,
    `<rect width="100%" height="100%" fill="${BACKGROUND}"/>`,
    ...polygonPaths(playArea).map(
      (d) =>
        `<path d="${d}" fill="${PLAY_AREA_FILL}" fill-rule="evenodd" stroke="${PLAY_AREA_STROKE}" stroke-width="4" stroke-linejoin="round"/>`,
    ),
    ...polygonPaths(zoneAreas).map(
      (d) => `<path d="${d}" fill="${ZONE_FILL}" fill-opacity="0.35" fill-rule="evenodd"/>`,
    ),
    ...stations.map((position) => {
      const [x, y] = project(position);
      return `<circle cx="${round(x)}" cy="${round(y)}" r="${STATION_RADIUS}" fill="${ZONE_FILL}"/>`;
    }),
    `</svg>`,
  ];
  return svg.join("");
}

// Rendering a large game takes a moment, and revisions never change, so each
// revision's image is kept once made. Bounded, oldest first.
const MAX_CACHED = 32;
const cache = new Map<string, Promise<Buffer | null>>();

export function gameMapPng(revisionId: string, definition: () => Promise<unknown>) {
  let png = cache.get(revisionId);
  if (!png) {
    png = definition().then(async (def) => {
      const svg = gameMapSvg(def);
      if (!svg) return null;
      // Off the main thread. The image has no text, so no fonts are needed.
      const image = await renderAsync(svg, { font: { loadSystemFonts: false } });
      return image.asPng();
    });
    // A failed render is tried again on the next request.
    png.catch(() => cache.delete(revisionId));
    cache.set(revisionId, png);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  return png;
}
