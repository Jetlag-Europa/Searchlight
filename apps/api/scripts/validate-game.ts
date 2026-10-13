// Validate bundled games against canonical JSON definitions.
// Run from apps/api:
//   pnpm exec tsx scripts/validate-game.ts paris-2026
//   pnpm exec tsx scripts/validate-game.ts            # validates every game
//
// Checks (no network): canonical game definition exists in games/preloaded;
// valid per shared validateGameDefinition schema.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  resolveGameDefinitionId,
  validateGameDefinition,
} from "@searchlight/shared";

const PRELOADED_DIR = resolve(import.meta.dirname, "../../../games/preloaded");
function validateFile(fileName: string): { name: string; gameId: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const canonicalPath = resolve(PRELOADED_DIR, fileName);

  if (!existsSync(canonicalPath)) {
    errors.push(`missing canonical game definition: games/preloaded/${fileName}`);
    return { name: fileName, gameId: fileName, errors, warnings };
  }

  let canonicalContent = "";
  let parsed: Record<string, unknown>;
  try {
    canonicalContent = readFileSync(canonicalPath, "utf8");
    parsed = JSON.parse(canonicalContent);
  } catch (e) {
    errors.push(`invalid JSON in games/preloaded/${fileName}: ${(e as Error).message}`);
    return { name: fileName, gameId: fileName, errors, warnings };
  }

  const result = validateGameDefinition(parsed);
  if (!result.valid) {
    for (const err of result.errors) {
      errors.push(`[${err.code}] ${err.path}: ${err.message}`);
    }
  }
  for (const warn of result.warnings) {
    warnings.push(`[${warn.code}] ${warn.path}: ${warn.message}`);
  }


  const gameId = resolveGameDefinitionId(parsed as { id?: string; name: string });
  const name = typeof parsed.name === "string" ? parsed.name : gameId;

  for (const w of warnings) console.warn(`  ⚠ ${gameId}: ${w}`);
  return { name, gameId, errors, warnings };
}

const allFiles = readdirSync(PRELOADED_DIR)
  .filter((f) => f.endsWith(".game.json"))
  .sort();

const arg = process.argv[2];
let targetFiles = allFiles;

if (arg) {
  const normalizedArg = arg.replace(/\.game\.json$/, "");
  targetFiles = allFiles.filter((f) => {
    const base = f.replace(/\.game\.json$/, "");
    return base === normalizedArg || f === arg;
  });

  if (targetFiles.length === 0) {
    console.error(`No preloaded game matching "${arg}".`);
    process.exit(1);
  }
}

let failed = 0;
for (const file of targetFiles) {
  const { name, gameId, errors } = validateFile(file);
  if (errors.length) {
    failed++;
    console.error(`✗ ${gameId} (${name})`);
    for (const e of errors) console.error(`    ${e}`);
  } else {
    console.log(`✓ ${gameId} (${name})`);
  }
}

if (failed) {
  console.error(`\n${failed} game(s) failed validation.`);
  process.exit(1);
}
console.log(`\nAll ${targetFiles.length} game(s) valid.`);
