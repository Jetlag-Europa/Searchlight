import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeGameDefinitionChecksum,
  resolveGameDefinitionId,
  validateGameDefinition,
} from "../packages/shared/src/index.js";
// The game creation skill's checker: the same play-quality checks authors run.
import {
  checkGame,
  STRICT_CODES,
} from "../apps/web/public/skills/create-game/check-game.mjs";

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "../..");
// Optional argument: another directory of *.game.json files to verify.
const PRELOADED_DIR = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(ROOT_DIR, "games/preloaded");
const CHECKER = "apps/web/public/skills/create-game/check-game.mjs";
const DIR_LABEL = relative(process.cwd(), PRELOADED_DIR) || ".";

async function main() {
  const files = (await readdir(PRELOADED_DIR))
    .filter((f) => f.endsWith(".game.json"))
    .sort();

  console.log(`Found ${files.length} preloaded game definitions in ${DIR_LABEL}/:\n`);

  if (files.length === 0) {
    console.error("No preloaded game definitions found!");
    process.exit(1);
  }

  let failures = 0;
  const gameIds = new Set<string>();

  for (const file of files) {
    const fullPath = resolve(PRELOADED_DIR, file);
    const content = await readFile(fullPath, "utf8");
    const parsed = JSON.parse(content);

    const validation = validateGameDefinition(parsed);
    if (!validation.valid) {
      console.error(`✗ ${file}: FAILED validation`);
      for (const err of validation.errors) {
        console.error(`  - [${err.code}] ${err.path}: ${err.message}`);
      }
      failures++;
      continue;
    }

    const problems: string[] = [];
    const gameId = resolveGameDefinitionId(parsed);
    // The API refuses to start preloading a file whose name isn't its game ID.
    const expectedFileName = `${gameId}.game.json`;
    if (file !== expectedFileName) {
      problems.push(`file name does not match resolved gameId "${gameId}" (expected "${expectedFileName}")`);
    }
    if (gameIds.has(gameId)) {
      problems.push(`DUPLICATE gameId "${gameId}"`);
    }
    gameIds.add(gameId);

    // Preloaded games must pass `check-game.mjs --strict`.
    const quality = checkGame(parsed, { fileSize: Buffer.byteLength(content) });
    for (const err of quality.errors) {
      problems.push(`${err.path}: ${err.message}`);
    }
    const strict = quality.warnings.filter((w) => STRICT_CODES.has(w.code));
    for (const w of strict) {
      problems.push(`[${w.code}] ${w.path}: ${w.message}`);
    }

    if (problems.length > 0) {
      console.error(`✗ ${file}: FAILED checks`);
      for (const problem of problems) console.error(`  - ${problem}`);
      failures++;
      continue;
    }

    const checksum = computeGameDefinitionChecksum(parsed);
    const zonesCount =
      parsed.hidingZones?.features?.features?.length ?? 0;
    const featuresCount = parsed.features?.length ?? 0;

    console.log(
      `✓ ${file.padEnd(35)} | ${parsed.name.padEnd(25)} | ${zonesCount} zones | ${featuresCount} POI layers | ${quality.warnings.length} warning(s) | sha256:${checksum.slice(0, 12)}...`,
    );
  }

  if (failures > 0) {
    console.error(`\nVerification failed: ${failures} game(s) have errors. For a full report run:\n  node ${CHECKER} --strict ${DIR_LABEL}/<file>`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} clean game definitions are valid and ready.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
