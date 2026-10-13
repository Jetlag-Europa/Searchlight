import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GAME_DEFINITION_SCHEMA_URL,
  GameDefinitionSchema,
} from "../packages/shared/src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const TARGET_PATHS = [
  resolve(ROOT_DIR, "games/schema/game-definition.v1.schema.json"),
  resolve(ROOT_DIR, "apps/web/public/schemas/game-definition.v1.schema.json"),
];


export function buildJsonSchema(): string {
  const schemaObj = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: GAME_DEFINITION_SCHEMA_URL,
    title: "GameDefinition",
    description: "Searchlight Game Definition v1 specification",
    ...GameDefinitionSchema,
  };

  return JSON.stringify(schemaObj, null, 2) + "\n";
}

async function main() {
  const isCheck = process.argv.includes("--check");
  const content = buildJsonSchema();

  if (isCheck) {
    let hasDrift = false;
    for (const targetPath of TARGET_PATHS) {
      try {
        const existing = await readFile(targetPath, "utf8");
        if (existing !== content) {
          console.error(`Schema drift detected in ${targetPath}`);
          hasDrift = true;
        }
      } catch (err) {
        console.error(`Missing schema file: ${targetPath}`);
        hasDrift = true;
      }
    }
    if (hasDrift) {
      process.exit(1);
    }
    console.log("Game definition schemas are up to date.");
    return;
  }

  for (const targetPath of TARGET_PATHS) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
    console.log(`Wrote JSON schema to ${targetPath}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
