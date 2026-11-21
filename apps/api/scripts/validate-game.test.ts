import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const apiRoot = resolve(import.meta.dirname, "..");
const tsxBin = resolve(apiRoot, "node_modules/.bin/tsx");
const scriptPath = resolve(apiRoot, "scripts/validate-game.ts");

function runValidateGame(files: string[]) {
  const res = spawnSync(tsxBin, [scriptPath, ...files], {
    cwd: apiRoot,
    encoding: "utf8",
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function validDefinition() {
  return {
    name: "Paris 2026",
    serverId: "12345",
    map: {
      center: [2.35, 48.85],
      playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
      features: { type: "FeatureCollection", features: [] },
    },
  };
}

describe("validate-game script", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "searchlight-validate-game-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports validation errors without crashing on missing name or non-object JSON in a batch", () => {
    const missingName = join(dir, "missing-name.game.json");
    const nonObject = join(dir, "non-object.game.json");
    const nullJson = join(dir, "null.game.json");
    const valid = join(dir, "valid.game.json");

    writeFileSync(missingName, JSON.stringify({ serverId: "12345" }));
    writeFileSync(nonObject, JSON.stringify(["not", "an", "object"]));
    writeFileSync(nullJson, "null");
    writeFileSync(valid, JSON.stringify(validDefinition()));

    const res = runValidateGame([missingName, nonObject, nullJson, valid]);
    expect(res.status).toBe(1);
    expect(res.stderr).not.toContain("TypeError");
    expect(res.stderr).toContain("✗ missing-name.game.json");
    expect(res.stderr).toContain("✗ non-object.game.json");
    expect(res.stderr).toContain("✗ null.game.json");
    expect(res.stderr).toContain("[SCHEMA_VALIDATION_ERROR] /: Expected object");
    expect(res.stdout).toContain("✓ paris-2026 (Paris 2026)");
    expect(res.stderr).toContain("3 game(s) failed validation.");
  });
});
