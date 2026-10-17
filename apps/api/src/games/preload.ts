import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type GameImportResponse, resolveGameDefinitionId } from "@searchlight/shared";
import { importGameDefinition, PRELOAD_SUPERSEDED } from "./import-service.js";

export interface PreloadSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  results: GameImportResponse[];
  // Files that could not be imported; the others are imported regardless.
  failures: { fileName: string; error: unknown }[];
  // Files left unapplied because an upload replaced their content.
  superseded: { fileName: string; message: string }[];
}

/**
 * Preloads all *.game.json definitions from the specified directory.
 * File discovery is sorted alphabetically to ensure deterministic execution.
 */
export async function preloadGameDefinitions(
  dirPath: string,
): Promise<PreloadSummary> {
  let dirents: string[];
  try {
    dirents = await readdir(dirPath);
  } catch (err) {
    // Directory might not exist yet if no games are preloaded
    return {
      total: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      results: [],
      failures: [],
      superseded: [],
    };
  }

  const gameFiles = dirents
    .filter((name) => name.endsWith(".game.json"))
    .sort();

  const results: GameImportResponse[] = [];
  const failures: PreloadSummary["failures"] = [];
  const superseded: PreloadSummary["superseded"] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const fileName of gameFiles) {
    let result: GameImportResponse;
    try {
      const fullPath = resolve(dirPath, fileName);
      const content = await readFile(fullPath, "utf8");
      const parsed = JSON.parse(content);

      const gameId = resolveGameDefinitionId(parsed);
      const expectedFileName = `${gameId}.game.json`;
      if (fileName !== expectedFileName) {
        throw new Error(
          `Preloaded file name "${fileName}" does not match resolved gameId "${gameId}" (expected "${expectedFileName}")`,
        );
      }

      result = await importGameDefinition({
        raw: parsed,
        source: "preload",
      });
    } catch (error) {
      failures.push({ fileName, error });
      continue;
    }

    results.push(result);
    for (const warning of result.warnings) {
      if (warning.code === PRELOAD_SUPERSEDED) {
        superseded.push({ fileName, message: warning.message });
      }
    }
    if (result.status === "created") created++;
    else if (result.status === "updated") updated++;
    else if (result.status === "unchanged") unchanged++;
  }

  return {
    total: results.length,
    created,
    updated,
    unchanged,
    results,
    failures,
    superseded,
  };
}
