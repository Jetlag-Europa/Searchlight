import { diffQuestionLists } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { buildQuestionsFile, parseQuestionsFile, questionsFileName } from "@/lib/questionsFile";
import { asRestored } from "@/lib/questionUndo";
import { questionSchema } from "@/maps/schema";

const game = {
  questionMap: new Map([
    ["radius", { id: "radius", family: "radius" }],
    ["matching-borough", { id: "matching-borough", family: "matching" }],
  ]),
} as any;
const session = {
  name: "Friday Night: Zürich!",
  gameId: "cgame1",
  gameName: "Zurich",
  gameRevisionId: "crev1",
};

const radius = questionSchema.parse({
  id: "radius",
  key: 0.1,
  data: { lat: 47.37, lng: 8.54, radius: 2 },
});
const borough = questionSchema.parse({
  id: "matching",
  key: 0.2,
  data: { type: "matching-borough", lat: 47.4, lng: 8.5 },
});
const withoutKeys = (list: { key: number }[]) => list.map((q) => ({ ...q, key: 0 }));
const exported = (questions: unknown[], changes: object = {}) =>
  JSON.stringify({
    ...buildQuestionsFile(session, questions as any),
    ...changes,
  });

describe("questions file", () => {
  it("names the file after the session", () => {
    expect(questionsFileName(session.name)).toBe("friday-night-zürich.questions.json");
    expect(questionsFileName("…")).toBe("session.questions.json");
    expect(questionsFileName("東京 26")).toBe("東京-26.questions.json");
    expect(questionsFileName("a".repeat(400))).toBe(`${"a".repeat(80)}.questions.json`);
  });

  it("exports the session's game, not the definition's", () => {
    expect(buildQuestionsFile(session, [radius], new Date("2026-11-15T10:00:00Z"))).toEqual({
      searchlightQuestions: 1,
      sessionName: "Friday Night: Zürich!",
      gameId: "cgame1",
      gameName: "Zurich",
      gameRevisionId: "crev1",
      exportedAt: "2026-11-15T10:00:00.000Z",
      questions: [radius],
    });
  });

  it("reads back what it exported, in order, as new questions", () => {
    const board = [radius, borough];
    const result = parseQuestionsFile(exported(board), game, "cgame1");
    if ("error" in result) throw new Error(result.error);
    expect(result).toMatchObject({
      skipped: 0,
      sessionName: session.name,
      otherGame: null,
    });
    expect(withoutKeys(result.questions)).toEqual(withoutKeys(board));
    // The questions replaced show in the history as deleted, to restore.
    expect(diffQuestionLists(board, result.questions).changes.map((c) => c.kind)).toEqual([
      "added",
      "added",
      "removed",
      "removed",
    ]);
  });

  it("gives two questions with one key a key each", () => {
    const result = parseQuestionsFile(exported([radius, { ...radius }]), game, "cgame1");
    if ("error" in result) throw new Error(result.error);
    const keys = result.questions.map((q) => q.key);
    expect(new Set([...keys, radius.key]).size).toBe(3);
  });

  it("imports a restored question as one that restores nothing", () => {
    const result = parseQuestionsFile(exported([asRestored(radius)]), game, "cgame1");
    if ("error" in result) throw new Error(result.error);
    expect(result.questions[0].data).not.toHaveProperty("restoredFrom");
  });

  it("rejects what isn't a questions file", () => {
    for (const text of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ questions: [radius] }),
      exported([radius], { searchlightQuestions: 2 }),
      exported([radius], { questions: { 0: radius } }),
    ]) {
      expect(parseQuestionsFile(text, game, "cgame1")).toEqual({
        error: expect.any(String),
      });
    }
  });

  it("skips broken questions and ones the game lacks", () => {
    const thermometer = {
      id: "thermometer",
      data: { latA: 1, lngA: 2, latB: 3, lngB: 4 },
    };
    const result = parseQuestionsFile(
      exported([thermometer, radius, { id: "radius", data: { lat: "north" } }, null]),
      game,
      "cgame1",
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.skipped).toBe(3);
    expect(withoutKeys(result.questions)).toEqual(withoutKeys([radius]));

    expect(parseQuestionsFile(exported([thermometer]), game, "cgame1")).toEqual({
      error: "That file has no questions for this game",
    });
  });

  it("says when the file is from another game, not another revision", () => {
    const other = parseQuestionsFile(
      exported([radius], { gameId: "cgame2", gameName: "Bern" }),
      game,
      "cgame1",
    );
    expect(other).toMatchObject({ otherGame: "Bern" });
    const revision = parseQuestionsFile(
      exported([radius], { gameRevisionId: "crev2" }),
      game,
      "cgame1",
    );
    expect(revision).toMatchObject({ otherGame: null });
  });

  it("skips shapes the map can't draw, and keeps the ones it can", () => {
    const point = (coordinates: unknown, name: unknown = "Kiosk") => ({
      type: "Feature",
      geometry: { type: "Point", coordinates },
      properties: { name },
    });
    const custom = (type: string, geo: unknown) => ({
      id: type === "custom-measure" ? "measuring" : "matching",
      data: { type, lat: 47.4, lng: 8.5, geo },
    });
    const tentacle = (place: unknown) => ({
      id: "tentacles",
      data: {
        locationType: "custom",
        lat: 47.4,
        lng: 8.5,
        places: [place],
      },
    });
    const zone = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [8, 47],
            [9, 47],
            [9, 48],
            [8, 47],
          ],
        ],
      },
    };
    const good = [
      custom("custom-points", [point([8.5, 47.4])]),
      custom("custom-zone", zone),
      custom("custom-zone", { type: "FeatureCollection", features: [] }),
      custom("custom-measure", {
        type: "FeatureCollection",
        features: [point([8.5, 47.4])],
      }),
      tentacle(point([8.5, 47.4])),
    ];
    const bad = [
      custom("custom-points", {}),
      custom("custom-points", [point([8.5])]),
      custom("custom-zone", "bad"),
      custom("custom-zone", [zone]),
      custom("custom-zone", point([8.5, 47.4])),
      custom("custom-measure", {
        type: "FeatureCollection",
        features: 1,
      }),
      tentacle(point([])),
      tentacle(point([8.5, 47.4], { a: 1 })),
    ];
    const result = parseQuestionsFile(exported([...good, ...bad]), game, "cgame1");
    if ("error" in result) throw new Error(result.error);
    expect(result.questions).toHaveLength(good.length);
    expect(result.skipped).toBe(bad.length);
  });

  it("rejects numbers JSON can't save and files too big to save", () => {
    const infinite = exported([radius]).replace('"radius":2', '"radius":1e999');
    expect(infinite).toContain("1e999");
    expect(parseQuestionsFile(infinite, game, "cgame1")).toEqual({
      error: "That file has no questions for this game",
    });
    expect(
      parseQuestionsFile(
        exported([radius], { sessionName: "x".repeat(1_000_000) }),
        game,
        "cgame1",
      ),
    ).toEqual({ error: "That file is too big to import" });
    // A crafted game name is not text to show.
    expect(
      parseQuestionsFile(
        exported([radius], { gameId: "x", gameName: { toString: 0 } }),
        game,
        "cgame1",
      ),
    ).toMatchObject({ otherGame: "" });
  });

  it("leaves out a radius the map can't buffer", () => {
    const withRadius = (radius: number, unit = "kilometers") => ({
      id: "radius",
      data: { lat: 47.37, lng: 8.54, radius, unit },
    });
    const kept = [
      withRadius(0.001),
      withRadius(1, "meters"),
      withRadius(20_000),
      withRadius(12_000, "miles"),
    ];
    const result = parseQuestionsFile(
      exported([
        ...kept,
        withRadius(0),
        withRadius(5e-324),
        withRadius(0.5, "meters"),
        withRadius(20_001),
        withRadius(13_000, "miles"),
        withRadius(1e300),
      ]),
      game,
      "cgame1",
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.skipped).toBe(6);
    expect(result.questions.map((q) => q.data)).toMatchObject(kept.map((q) => q.data));
  });

  it("takes only as many drawn corners and places as the map can work out", () => {
    const custom = {
      questionMap: new Map([
        ["measuring", { id: "measuring", family: "measuring" }],
        ["matching", { id: "matching", family: "matching" }],
      ]),
    } as any;
    const point = (i: number) => ({
      type: "Feature",
      properties: { name: `p${i}` },
      geometry: { type: "Point", coordinates: [8 + i / 1e4, 47] },
    });
    const line = (corners: number) => ({
      id: "measuring",
      data: {
        type: "custom-measure",
        lat: 47.37,
        lng: 8.54,
        geo: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: Array.from({ length: corners }, (_, i) => [
                  8 + i / 1e4,
                  47 + (i % 2) / 1e3,
                ]),
              },
            },
          ],
        },
      },
    });
    const points = (count: number) => ({
      id: "matching",
      data: {
        type: "custom-points",
        lat: 47.37,
        lng: 8.54,
        geo: Array.from({ length: count }, (_, i) => point(i)),
      },
    });
    const tentacle = (count: number) => ({
      id: "tentacles",
      data: {
        locationType: "custom",
        lat: 47.37,
        lng: 8.54,
        radius: 15,
        unit: "kilometers",
        places: Array.from({ length: count }, (_, i) => point(i)),
      },
    });
    const kept = (questions: unknown[]) => {
      const result = parseQuestionsFile(exported(questions), custom, "cgame1");
      if ("error" in result) throw new Error(result.error);
      return result.questions.length;
    };

    expect(kept([line(200)])).toBe(1);
    expect(kept([line(201), line(2)])).toBe(1);
    // Across the file, not per question: the third is one too many.
    expect(kept([line(100), line(100), line(2)])).toBe(2);
    // A smaller one after it still fits.
    expect(kept([line(150), line(100), line(50)])).toBe(2);

    expect(kept([points(300)])).toBe(1);
    expect(kept([points(301), points(1)])).toBe(1);
    // Custom points, tentacle places and lines to measure to share it.
    expect(kept([points(150), tentacle(149), line(2), tentacle(1)])).toBe(3);

    // Lines as one feature, not in a collection: the map ignores those.
    const bare = line(2);
    (bare.data as any).geo = bare.data.geo.features[0];
    expect(kept([bare, line(2)])).toBe(1);
  });

  it("leaves out malformed polygons, lines and out-of-range coordinates", () => {
    const custom = {
      questionMap: new Map([
        ["measuring", { id: "measuring", family: "measuring" }],
        ["matching", { id: "matching", family: "matching" }],
      ]),
    } as any;
    const zone = (ring: number[][]) => ({
      id: "matching",
      data: {
        type: "custom-zone",
        lat: 47.37,
        lng: 8.54,
        geo: {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      },
    });
    const line = (coords: number[][]) => ({
      id: "measuring",
      data: {
        type: "custom-measure",
        lat: 47.37,
        lng: 8.54,
        geo: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: coords,
              },
            },
          ],
        },
      },
    });
    const validRing = [
      [8.5, 47.3],
      [8.6, 47.3],
      [8.6, 47.4],
      [8.5, 47.3],
    ];
    const result = parseQuestionsFile(
      exported([
        zone(validRing),
        zone([
          [179.8, 47.3],
          [179.8 + 1e-7, 47.3],
          [179.8, 47.3 + 1e-7],
          [179.8, 47.3],
        ]), // small valid triangle near antimeridian
        line([
          [8.5, 47.3],
          [8.6, 47.4],
        ]),
        line([
          [179.8, 47.3],
          [180.2, 47.4],
        ]), // antimeridian-crossing Leaflet line
        zone([[8.5, 47.3]]), // 1-point ring
        zone([
          [8.5, 47.3],
          [8.6, 47.3],
          [8.6, 47.4],
          [8.5, 47.4],
        ]), // unclosed ring
        zone([
          [8.5, 47.3],
          [8.5, 47.3],
          [8.5, 47.3],
          [8.5, 47.3],
        ]), // degenerate ring
        zone([
          [8.501, 47.3],
          [8.516625, 47.346875],
          [8.53225, 47.39375],
          [8.501, 47.3],
        ]), // diagonal collinear ring
        zone([
          [8.5, 47.3],
          [8.501, 47.3],
          [8.501, 47.301],
          [8.6, 47.31],
          [8.501, 47.301],
          [8.501, 47.3],
          [8.5, 47.3],
        ]), // retraced zero-area ring with floating-point residue
        line([[8.5, 47.3]]), // 1-point line
        zone([
          [400, 47.3],
          [8.6, 47.3],
          [8.6, 47.4],
          [400, 47.3],
        ]), // longitude out of range
        line([
          [8.5, 95],
          [8.6, 47.4],
        ]), // latitude out of range
      ]),
      custom,
      "cgame1",
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.questions).toHaveLength(4);
    expect(result.skipped).toBe(8);
  });

  it("counts the size in bytes, as the API does", () => {
    // 400,000 characters, 1.2 MB.
    const named = {
      ...radius,
      data: { ...radius.data, name: "中".repeat(400_000) },
    };
    expect(parseQuestionsFile(exported([named]), game, "cgame1")).toEqual({
      error: "That file is too big to import",
    });
  });

  it("rejects questions that are small one by one and too big together", () => {
    // Under the limit as a file, over it with what each is saved with.
    const many = Array.from({ length: 9_000 }, () => ({
      id: "radius",
      data: { lat: 1, lng: 2, radius: 3, unit: "miles" },
    }));
    const text = exported(many);
    expect(new TextEncoder().encode(text).length).toBeLessThan(1_000_000);
    expect(parseQuestionsFile(text, game, "cgame1")).toEqual({
      error: "That file is too big to import",
    });
  });

  it("shortens the names it shows in the confirm", () => {
    const result = parseQuestionsFile(
      exported([radius], {
        sessionName: "s".repeat(5_000),
        gameId: "other",
        gameName: "g".repeat(5_000),
      }),
      game,
      "cgame1",
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.sessionName).toBe("s".repeat(80));
    expect(result.otherGame).toBe("g".repeat(80));
  });
});
