import { diffQuestionLists } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import {
    buildQuestionsFile,
    parseQuestionsFile,
    questionsFileName,
} from "@/lib/questionsFile";
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
const withoutKeys = (list: { key: number }[]) =>
    list.map((q) => ({ ...q, key: 0 }));
const exported = (questions: unknown[], changes: object = {}) =>
    JSON.stringify({
        ...buildQuestionsFile(session, questions as any),
        ...changes,
    });

describe("questions file", () => {
    it("names the file after the session", () => {
        expect(questionsFileName(session.name)).toBe(
            "friday-night-z-rich.questions.json",
        );
        expect(questionsFileName("…")).toBe("session.questions.json");
    });

    it("exports the session's game, not the definition's", () => {
        expect(
            buildQuestionsFile(
                session,
                [radius],
                new Date("2026-11-15T10:00:00Z"),
            ),
        ).toEqual({
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
        expect(
            diffQuestionLists(board, result.questions).changes.map(
                (c) => c.kind,
            ),
        ).toEqual(["added", "added", "removed", "removed"]);
    });

    it("gives two questions with one key a key each", () => {
        const result = parseQuestionsFile(
            exported([radius, { ...radius }]),
            game,
            "cgame1",
        );
        if ("error" in result) throw new Error(result.error);
        const keys = result.questions.map((q) => q.key);
        expect(new Set([...keys, radius.key]).size).toBe(3);
    });

    it("imports a restored question as one that restores nothing", () => {
        const result = parseQuestionsFile(
            exported([asRestored(radius)]),
            game,
            "cgame1",
        );
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
            exported([
                thermometer,
                radius,
                { id: "radius", data: { lat: "north" } },
                null,
            ]),
            game,
            "cgame1",
        );
        if ("error" in result) throw new Error(result.error);
        expect(result.skipped).toBe(3);
        expect(withoutKeys(result.questions)).toEqual(withoutKeys([radius]));

        expect(
            parseQuestionsFile(exported([thermometer]), game, "cgame1"),
        ).toEqual({ error: "That file has no questions for this game" });
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
        const result = parseQuestionsFile(
            exported([...good, ...bad]),
            game,
            "cgame1",
        );
        if ("error" in result) throw new Error(result.error);
        expect(result.questions).toHaveLength(good.length);
        expect(result.skipped).toBe(bad.length);
    });

    it("rejects numbers JSON can't save and files too big to save", () => {
        const infinite = exported([radius]).replace(
            '"radius":2',
            '"radius":1e999',
        );
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
});
