import { describe, expect, it } from "vitest";
import { computeGameDefinitionChecksum } from "./canonicalize.js";
import {
  compareByEventDate,
  isCalendarDate,
  isRulesUrl,
  splitGameDetails,
  validateGameDetails,
} from "./details.js";
import type { GameDefinition } from "./schema.js";
import { validateGameDefinition } from "./validate.js";

function definition(details: Partial<GameDefinition> = {}): GameDefinition {
  return {
    id: "paris-2026",
    name: "Paris 15-08",
    serverId: "1190673594649415730",
    map: { center: [2.35, 48.85], playArea: { type: "FeatureCollection", features: [] } },
    hidingZones: { radius: 400, features: { type: "FeatureCollection", features: [] } },
    ...details,
  };
}

const codes = (def: GameDefinition) => validateGameDefinition(def).errors.map((e) => e.code);

describe("game details", () => {
  it("accept a date, an end date on or after it and an https rules link", () => {
    expect(
      codes(
        definition({
          date: "2026-10-02",
          endDate: "2026-10-03",
          rulesUrl: "https://docs.google.com/document/d/abc/edit",
        }),
      ),
    ).toEqual([]);
    expect(codes(definition({ date: "2026-10-02", endDate: "2026-10-02" }))).toEqual([]);
  });

  it("reject dates that aren't calendar days as YYYY-MM-DD", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-2-1", "x2026-01-01", "2026-01-01T00:00"]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
    expect(codes(definition({ date: "2026-02-30" }))).toEqual(["INVALID_DATE"]);
    // The schema's pattern is anchored.
    expect(codes(definition({ date: "x2026-01-01y" }))).toEqual(["SCHEMA_VALIDATION_ERROR"]);
  });

  it("reject an end date without a date or before it", () => {
    expect(codes(definition({ endDate: "2026-10-03" }))).toEqual(["END_DATE_WITHOUT_DATE"]);
    expect(codes(definition({ date: "2026-10-03", endDate: "2026-10-02" }))).toEqual(["END_DATE_BEFORE_DATE"]);
  });

  it("reject rules links that aren't https", () => {
    expect(isRulesUrl("https://discord.com/channels/1/2/3")).toBe(true);
    for (const bad of ["http://example.com", "javascript:alert(1)", "https://", "https://a b.com", "docs.google.com"]) {
      expect(isRulesUrl(bad)).toBe(false);
    }
    expect(codes(definition({ rulesUrl: "http://example.com/rules" }))).toEqual(["INVALID_RULES_URL"]);
    expect(validateGameDetails({ rulesUrl: null, date: null, endDate: null })).toEqual([]);
  });

  it("aren't part of the map: the checksum ignores them", () => {
    const plain = computeGameDefinitionChecksum(definition());
    expect(
      computeGameDefinitionChecksum(
        definition({ date: "2026-08-15", rulesUrl: "https://docs.google.com/document/d/abc/edit" }),
      ),
    ).toBe(plain);
  });

  it("split off a definition, keeping only the keys it set", () => {
    const { map, details } = splitGameDetails(definition({ date: "2026-08-15" }));
    expect(details).toEqual({ date: "2026-08-15" });
    expect(map).toEqual(definition());
  });

  it("sort newest event first, undated games last by name", () => {
    const games = [
      { name: "B undated", date: null },
      { name: "Old", date: "2026-05-30" },
      { name: "A undated", date: null },
      { name: "New", date: "2026-10-02" },
    ];
    expect(games.sort(compareByEventDate).map((g) => g.name)).toEqual(["New", "Old", "A undated", "B undated"]);
  });
});
