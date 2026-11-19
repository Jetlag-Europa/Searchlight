import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import {
  formatGameDefinitionJson,
  type GameDefinition,
} from "../packages/shared/src/index.js";
// The import page's overlap fixer, so files fixed here match fixes made there.
import {
  findRegionOverlaps,
  markNoOverlaps,
  removeRegionOverlaps,
} from "../apps/web/src/maps/geo-utils/regionOverlaps.js";

// Fixes overlapping regions in game files, as the import page does: each
// overlap goes to the first region in the layer, and every region layer
// without overlaps (or whose overlaps are fixed) is marked noOverlaps.
// Arguments: the *.game.json files to fix.

type Region = Parameters<typeof findRegionOverlaps>[0]["regions"][number];

async function main() {
  const files = process.argv.slice(2).map((file) => resolve(file));
  if (!files.length) {
    console.error("Usage: pnpm fix:region-overlaps <file.game.json>...");
    process.exit(1);
  }
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
          ? `${label} "${layer.name}": fixed ${overlaps.pieces.length} overlaps, reaching up to ${widest.toFixed(1)} m`
          : `${label} "${layer.name}": no overlaps; marked`,
      );
      changed = true;
      return markNoOverlaps(
        layer,
        overlaps.pieces.length ? removeRegionOverlaps({ regions }) : regions,
      );
    });
    if (!changed) continue;
    await writeFile(file, formatGameDefinitionJson({ ...definition, features }));
  }
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
