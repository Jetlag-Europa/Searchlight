// Validate a bundled game's assets before seeding. Run from apps/api:
//   pnpm exec tsx scripts/validate-game.ts __bundled-paris-2026__
//   pnpm exec tsx scripts/validate-game.ts            # validates every game
//
// Checks (no network): asset files exist; stations KML has >=1 Point; POI KML
// folders resolve to categories; boundary GeoJSON parses to a polygon; any
// tierRadiusOverrides keys actually appear as <Data name="tier"> values.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { GAME_REGISTRY, type GameManifest } from "@taibled/shared";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../web/public");

const SKIPPED = new Set(["administrative", "water"]);

function read(asset: string): string | null {
  const path = resolve(PUBLIC_DIR, asset);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function countPoints(kml: string): number {
  return (kml.match(/<Point>/gi) ?? []).length;
}

function folderNames(kml: string): string[] {
  return kml
    .split(/<Folder>/i)
    .slice(1)
    .map((b) => b.match(/<name>([\s\S]*?)<\/name>/i)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function tierValues(kml: string): Set<string> {
  const out = new Set<string>();
  const re = /<Data name="tier">\s*<value>([\s\S]*?)<\/value>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(kml)) !== null) out.add(m[1].trim());
  return out;
}

function validate(g: GameManifest): string[] {
  const errors: string[] = [];
  const warn: string[] = [];

  // Asset existence.
  for (const asset of [g.kmlPath, g.stationsKml, g.boundaryGeoJson, g.hidingZoneGeoJson]) {
    if (asset && !existsSync(resolve(PUBLIC_DIR, asset))) {
      errors.push(`missing asset file: ${asset}`);
    }
  }

  // Stations: the stations file (or kmlPath when combined) must have points.
  const stationsFile = g.stationsKml ?? (g.hidingZoneGeoJson ? null : g.kmlPath);
  if (stationsFile) {
    const kml = read(stationsFile);
    if (kml) {
      const pts = countPoints(kml);
      if (pts === 0) errors.push(`stations file ${stationsFile} has 0 <Point> placemarks`);
      // Tier overrides must reference tiers that exist in the KML.
      if (g.tierRadiusOverrides) {
        const tiers = tierValues(kml);
        for (const key of Object.keys(g.tierRadiusOverrides)) {
          if (!tiers.has(key)) warn.push(`tierRadiusOverrides key "${key}" not found as a <Data name="tier"> value`);
        }
      }
    }
  }

  // POI folders resolve to categories.
  if (g.poiFolders && g.kmlPath) {
    const kml = read(g.kmlPath);
    if (kml) {
      const names = folderNames(kml);
      for (const name of names) {
        const cat = (g.poiFolders[name] ?? name.toLowerCase());
        if (!cat) warn.push(`POI folder "${name}" has no category mapping`);
        else if (SKIPPED.has(cat)) continue;
      }
      if (names.length === 0) warn.push(`POI file ${g.kmlPath} has no <Folder> blocks`);
    }
  }

  // Boundary GeoJSON parses to a polygon.
  if (g.boundaryGeoJson) {
    const txt = read(g.boundaryGeoJson);
    if (txt) {
      try {
        const geo = JSON.parse(txt);
        const t = geo.type === "FeatureCollection"
          ? geo.features?.[0]?.geometry?.type
          : geo.type === "Feature"
            ? geo.geometry?.type
            : geo.type;
        if (!["Polygon", "MultiPolygon"].includes(t)) {
          errors.push(`boundary ${g.boundaryGeoJson} is not a Polygon/MultiPolygon (got ${t})`);
        }
      } catch (e) {
        errors.push(`boundary ${g.boundaryGeoJson} is not valid JSON: ${(e as Error).message}`);
      }
    }
  }

  for (const w of warn) console.warn(`  ⚠ ${g.sentinel}: ${w}`);
  return errors;
}

const arg = process.argv[2];
const games = arg ? GAME_REGISTRY.filter((g) => g.sentinel === arg) : GAME_REGISTRY;

if (arg && games.length === 0) {
  console.error(`No game with sentinel "${arg}" in GAME_REGISTRY.`);
  process.exit(1);
}

let failed = 0;
for (const g of games) {
  const errors = validate(g);
  if (errors.length) {
    failed++;
    console.error(`✗ ${g.sentinel} (${g.name})`);
    for (const e of errors) console.error(`    ${e}`);
  } else {
    console.log(`✓ ${g.sentinel} (${g.name})`);
  }
}

if (failed) {
  console.error(`\n${failed} game(s) failed validation.`);
  process.exit(1);
}
console.log(`\nAll ${games.length} game(s) valid.`);
