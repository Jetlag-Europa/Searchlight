import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computeGameDefinitionChecksum,
  type GameDefinition,
  type GameImportResponse,
  resolveGameDefinitionId,
} from "@searchlight/shared";
import { importGameDefinition } from "./import-service.js";

export interface PreloadSummary {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  // Files unchanged since the last start while another revision was made
  // current since; the game keeps that revision.
  kept: { fileName: string; revision: number }[];
  // Files whose date or rules link changed the game's (whatever its map did).
  detailsUpdated: number;
  results: GameImportResponse[];
  // Files that could not be imported; the others are imported regardless.
  failures: { fileName: string; error: unknown }[];
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
      kept: [],
      detailsUpdated: 0,
      results: [],
      failures: [],
    };
  }

  const gameFiles = dirents
    .filter((name) => name.endsWith(".game.json"))
    .sort();

  const results: GameImportResponse[] = [];
  const failures: PreloadSummary["failures"] = [];
  const kept: PreloadSummary["kept"] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let detailsUpdated = 0;

  for (const fileName of gameFiles) {
    let result: GameImportResponse;
    let parsed: GameDefinition;
    try {
      const fullPath = resolve(dirPath, fileName);
      const content = await readFile(fullPath, "utf8");
      parsed = JSON.parse(content);

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
    if (result.detailsChanged && result.status !== "created") detailsUpdated++;
    if (result.status === "created") created++;
    else if (result.status === "updated") updated++;
    // An unchanged result names the current revision, so another checksum
    // means it was made current since the last start.
    else if (result.checksum !== computeGameDefinitionChecksum(parsed)) {
      kept.push({ fileName, revision: result.revision });
    } else unchanged++;
  }

  return {
    total: results.length,
    created,
    updated,
    unchanged,
    kept,
    detailsUpdated,
    results,
    failures,
  };
}
