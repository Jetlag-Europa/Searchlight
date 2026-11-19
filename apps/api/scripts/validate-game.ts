// Validate game definition files with the server's validator, as an import
// does (no network). Run from apps/api:
//   pnpm validate-game path/to/paris-2026.game.json [more.game.json ...]

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  resolveGameDefinitionId,
  validateGameDefinition,
} from "@searchlight/shared";

// pnpm runs package scripts in apps/api; INIT_CWD is where it was called from.
const cwd = process.env["INIT_CWD"] ?? process.cwd();

function validateFile(path: string): { name: string; gameId: string; errors: string[] } {
  const errors: string[] = [];
  const fileName = basename(path);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`can't read ${path}: ${(e as Error).message}`);
    return { name: fileName, gameId: fileName, errors };
  }

  const result = validateGameDefinition(parsed);
  if (!result.valid) {
    for (const err of result.errors) {
      errors.push(`[${err.code}] ${err.path}: ${err.message}`);
    }
  }

  const gameId = resolveGameDefinitionId(parsed as { id?: string; name: string });
  const name = typeof parsed.name === "string" ? parsed.name : gameId;
  for (const warn of result.warnings) {
    console.warn(`  ⚠ ${gameId}: [${warn.code}] ${warn.path}: ${warn.message}`);
  }
  return { name, gameId, errors };
}

const files = process.argv.slice(2).map((file) => resolve(cwd, file));
if (!files.length) {
  console.error("Usage: pnpm --filter @searchlight/api validate-game <file.game.json>...");
  process.exit(1);
}

let failed = 0;
for (const file of files) {
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
console.log(`\nAll ${files.length} game(s) valid.`);
