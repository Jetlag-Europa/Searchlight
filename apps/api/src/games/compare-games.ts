import type { ExistingGameComparison } from "@searchlight/shared";

// A rough check of whether an imported file is the game whose id it uses or a
// different game that reused the id by mistake (copied from another file,
// say). It only looks at the name and where the play area is, which is enough
// to tell "London 2026, revised" from "Paris 2026".

// Names whose word sets share at least this much (Jaccard) are the same name.
const MIN_NAME_SIMILARITY = 0.5;
// Play areas are the same if they overlap by this share of the smaller one.
const MIN_AREA_OVERLAP = 0.25;
// Without bounds a play area is just its center: the same if within this many
// degrees (~50 km) of the other's center or box.
const CENTER_TOLERANCE_DEG = 0.5;

/** [west, south, east, north] in degrees. */
type Box = [number, number, number, number];
type Point = [number, number];

/** What the comparison reads of each game: its name and `map.bounds`/`map.center`. */
export interface ComparedGame {
  name: string;
  bounds?: unknown;
  center?: unknown;
}

function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function namesMatch(a: string, b: string): boolean {
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  // One name's words all appear in the other ("London 2026" and "London 2026
  // revised"); whole words, so "Rome" isn't found in "Jerome County".
  const shared = [...tokensA].filter((token) => tokensB.has(token)).length;
  if (shared === tokensA.size || shared === tokensB.size) return true;
  return shared / (tokensA.size + tokensB.size - shared) >= MIN_NAME_SIMILARITY;
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function toBox(bounds: unknown): Box | null {
  if (!isNumberTuple(bounds, 4)) return null;
  const [west, south, east, north] = bounds;
  // Boxes across the antimeridian are rare enough to fall back to the center.
  return west <= east && south <= north ? [west, south, east, north] : null;
}

function toPoint(center: unknown): Point | null {
  return isNumberTuple(center, 2) ? [center[0], center[1]] : null;
}

function area([west, south, east, north]: Box): number {
  return (east - west) * (north - south);
}

function overlapShare(a: Box, b: Box): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (width < 0 || height < 0) return 0;
  const smaller = Math.min(area(a), area(b));
  // A box with no area (a single point or line) overlaps fully if it touches.
  return smaller === 0 ? 1 : (width * height) / smaller;
}

function nearBox([lng, lat]: Point, [west, south, east, north]: Box): boolean {
  return (
    lng >= west - CENTER_TOLERANCE_DEG &&
    lng <= east + CENTER_TOLERANCE_DEG &&
    lat >= south - CENTER_TOLERANCE_DEG &&
    lat <= north + CENTER_TOLERANCE_DEG
  );
}

/**
 * Whether two games' play areas overlap: "no" (false), "barely" (some overlap,
 * below MIN_AREA_OVERLAP), "yes" (true), or null if either has no usable
 * bounds or center.
 */
function areasOverlap(a: ComparedGame, b: ComparedGame): boolean | "barely" | null {
  const boxA = toBox(a.bounds);
  const boxB = toBox(b.bounds);
  if (boxA && boxB) {
    const share = overlapShare(boxA, boxB);
    return share >= MIN_AREA_OVERLAP ? true : share > 0 ? "barely" : false;
  }
  const pointA = toPoint(a.center);
  const pointB = toPoint(b.center);
  if (boxA && pointB) return nearBox(pointB, boxA);
  if (boxB && pointA) return nearBox(pointA, boxB);
  if (pointA && pointB) return nearBox(pointA, [pointB[0], pointB[1], pointB[0], pointB[1]]);
  return null;
}

/**
 * Compares the game an import would update with the file. Differences in
 * name or play area make it a likely mistake; who created the game is only
 * mentioned. A play area that can't be compared counts as the same.
 */
export function compareWithExisting(
  existing: ComparedGame & { revision: number; createdById: string | null },
  incoming: ComparedGame,
  userId: string | null | undefined,
): ExistingGameComparison {
  const createdByYou = existing.createdById === null ? null : existing.createdById === userId;
  const sameName = namesMatch(existing.name, incoming.name);
  const overlap = areasOverlap(existing, incoming);

  const differences: string[] = [];
  if (!sameName) differences.push(`Named "${existing.name}"; this file: "${incoming.name}"`);
  if (overlap === false) differences.push("Its play area doesn't overlap this file's");
  if (overlap === "barely") differences.push("Its play area barely overlaps this file's");
  if (createdByYou === false) differences.push("Created by someone else");

  return {
    name: existing.name,
    revision: existing.revision,
    createdByYou,
    likelyMistake: !sameName || overlap === false || overlap === "barely",
    differences,
  };
}
