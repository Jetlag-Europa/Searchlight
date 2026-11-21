import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeGameDefinitionChecksum,
  formatGameDefinitionJson,
  type GameDefinition,
  resolveGameDefinitionId,
} from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { formatGameExportJson } from "@/game-definition/export";

const fixture: GameDefinition = JSON.parse(
  readFileSync(resolve(process.cwd(), "tests/fixtures/games/rotterdam-2026-09.game.json"), "utf8"),
);

describe("formatGameExportJson", () => {
  it("materializes a missing id without changing the checksum and keeps an existing id", () => {
    const withoutId: GameDefinition = { ...fixture };
    delete withoutId.id;
    const derivedId = resolveGameDefinitionId(withoutId);

    const exported: GameDefinition = JSON.parse(formatGameExportJson(withoutId, derivedId));
    expect(exported.id).toBe(derivedId);
    expect(computeGameDefinitionChecksum(exported)).toBe(computeGameDefinitionChecksum(withoutId));
    expect(resolveGameDefinitionId({ ...exported, name: "Renamed" })).toBe(derivedId);
    expect(formatGameExportJson(fixture, "other-id")).toBe(formatGameDefinitionJson(fixture));
  });
});
