import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POI_CATEGORIES, validateGameDefinition } from "@searchlight/shared";

const PRELOADED_DIR = resolve(__dirname, "../../../games/preloaded");

describe("Preloaded Games Integrity", () => {
  const files = readdirSync(PRELOADED_DIR).filter((f) =>
    f.endsWith(".game.json"),
  );
  const games = files.map((f) =>
    JSON.parse(readFileSync(resolve(PRELOADED_DIR, f), "utf8")),
  );

  it("has unique preloaded game IDs and names", () => {
    const ids = games.map((g) => g.id);
    expect(new Set(ids).size).toBe(games.length);
    const names = games.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every game definition is strictly valid", () => {
    for (const g of games) {
      const validation = validateGameDefinition(g);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toEqual([]);
    }
  });

  it("exposes the 13 canonical rulebook POI categories", () => {
    expect(POI_CATEGORIES).toContain("mountain");
    expect(POI_CATEGORIES).toContain("rail");
    expect(POI_CATEGORIES).toHaveLength(13);
  });
});
