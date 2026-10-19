import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameDefinition } from "../packages/shared/src/index.js";
// The import page's overlap fixer, so files fixed here match fixes made there.
import {
  findRegionOverlaps,
  markNoOverlaps,
  removeRegionOverlaps,
} from "../apps/web/src/maps/geo-utils/regionOverlaps.js";

// Fixes overlapping regions in game files, as the import page does: each
// overlap goes to the first region in the layer, and every region layer
// without overlaps (or whose overlaps are fixed) is marked noOverlaps.
// Arguments: *.game.json files; by default every preloaded game.

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "../..");
const PRELOADED_DIR = resolve(ROOT_DIR, "games/preloaded");

type Region = Parameters<typeof findRegionOverlaps>[0]["regions"][number];

async function main() {
  const files = process.argv.slice(2).length
    ? process.argv.slice(2).map((file) => resolve(file))
    : (await readdir(PRELOADED_DIR))
        .filter((file) => file.endsWith(".game.json"))
        .sort()
        .map((file) => resolve(PRELOADED_DIR, file));
  let failures = 0;
  for (const file of files) {
    const label = relative(process.cwd(), file);
    const definition = JSON.parse(await readFile(file, "utf8")) as GameDefinition;
    let changed = false;
    const features = (definition.features ?? []).map((layer) => {
      const regions = layer.data.features as Region[];
      const isRegionLayer =
        regions.length > 0 &&
        regions.every(
          (f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon",
        );
      if (!isRegionLayer) return layer;
      const overlaps = findRegionOverlaps({ regions });
      if (overlaps.hidden.length) {
        failures++;
        console.error(
          `${label} "${layer.name}": regions ${overlaps.hidden
            .map((h) => h.region + 1)
            .join(", ")} lie entirely inside earlier regions; fix by hand`,
        );
        return layer;
      }
      if (!overlaps.pieces.length && layer.noOverlaps) return layer;
      const widest = Math.max(0, ...overlaps.pieces.map((p) => p.width));
      console.log(
        overlaps.pieces.length
          ? `${label} "${layer.name}": fixed ${overlaps.pieces.length} overlaps, the widest ${widest.toFixed(1)} m`
          : `${label} "${layer.name}": no overlaps; marked`,
      );
      changed = true;
      return markNoOverlaps(
        layer,
        overlaps.pieces.length ? removeRegionOverlaps({ regions }) : regions,
      );
    });
    if (!changed) continue;
    await writeFile(
      file,
      `${JSON.stringify({ ...definition, features }, null, 2)}\n`,
    );
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
