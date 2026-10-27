import { describe, expect, test } from "vitest";
import { compareWithExisting, namesMatch } from "./compare-games.js";

const LONDON = { name: "London 2026", bounds: [-0.5, 51.3, 0.3, 51.7], center: [-0.1, 51.5] };
const PARIS = { name: "Paris 2026", bounds: [2.2, 48.8, 2.5, 48.95], center: [2.35, 48.86] };

function existing(game: object, createdById: string | null = "me") {
  return { ...LONDON, revision: 3, createdById, ...game };
}

describe("namesMatch", () => {
  test("ignores case, punctuation and extra words", () => {
    expect(namesMatch("London 2026", "london-2026")).toBe(true);
    expect(namesMatch("London 2026", "London 2026 (revised)")).toBe(true);
    expect(namesMatch("Greater London Game 2026", "London Game 2026 v2")).toBe(true);
  });

  test("tells different names apart", () => {
    expect(namesMatch("London 2026", "Paris 2026")).toBe(false);
    expect(namesMatch("Zürich", "Bern")).toBe(false);
    // Whole words only.
    expect(namesMatch("Rome", "Jerome County")).toBe(false);
    expect(namesMatch("UK", "Ukraine")).toBe(false);
  });
});

describe("compareWithExisting", () => {
  test("the same game with a tweaked name and area is no mistake", () => {
    const result = compareWithExisting(
      existing({}),
      { name: "London 2026 v2", bounds: [-0.45, 51.35, 0.35, 51.75] },
      "me",
    );
    expect(result).toEqual({
      name: "London 2026",
      revision: 3,
      createdByYou: true,
      likelyMistake: false,
      differences: [],
    });
  });

  test("a different name is a likely mistake", () => {
    const result = compareWithExisting(existing({}), { ...LONDON, name: "Paris 2026" }, "me");
    expect(result.likelyMistake).toBe(true);
    expect(result.differences).toEqual(['Named "London 2026"; this file: "Paris 2026"']);
  });

  test("a play area that doesn't overlap is a likely mistake", () => {
    const result = compareWithExisting(existing({}), { ...PARIS, name: "London 2026" }, "me");
    expect(result.likelyMistake).toBe(true);
    expect(result.differences).toEqual(["Its play area doesn't overlap this file's"]);
  });

  test("a play area that barely overlaps is a likely mistake", () => {
    // Overlaps 0.1 x 0.4 of London's 0.8 x 0.4.
    const result = compareWithExisting(existing({}), { ...LONDON, bounds: [0.2, 51.3, 1.0, 51.7] }, "me");
    expect(result.likelyMistake).toBe(true);
    expect(result.differences).toEqual(["Its play area barely overlaps this file's"]);
  });

  test("falls back to the center when bounds are missing", () => {
    const inside = compareWithExisting(existing({}), { name: "London 2026", center: [-0.2, 51.45] }, "me");
    expect(inside.likelyMistake).toBe(false);
    const far = compareWithExisting(
      existing({ bounds: null }),
      { name: "London 2026", center: PARIS.center },
      "me",
    );
    expect(far.likelyMistake).toBe(true);
  });

  test("a play area that can't be compared isn't held against the file", () => {
    const result = compareWithExisting(existing({ bounds: null, center: null }), PARIS, "me");
    expect(result.differences).toEqual(['Named "London 2026"; this file: "Paris 2026"']);
  });

  test("mentions someone else's game without calling it a mistake", () => {
    const theirs = compareWithExisting(existing({}, "someone"), LONDON, "me");
    expect(theirs).toMatchObject({ createdByYou: false, likelyMistake: false });
    expect(theirs.differences).toEqual(["Created by someone else"]);

    const unknown = compareWithExisting(existing({}, null), LONDON, "me");
    expect(unknown).toMatchObject({ createdByYou: null, differences: [] });
  });
});
