import { describe, expect, test } from "vitest";

import {
    conflictAuthorName,
    conflictCountText,
    conflictDeletionLine,
    conflictQuestionLabel,
    questionDifferences,
    questionTypeLabel,
    rawDifferences,
    summarizeQuestion,
} from "@/lib/questionSummary";

const radius = (data: Record<string, unknown> = {}, key = 0.1) => ({
    id: "radius",
    key,
    data: {
        lat: 51.5,
        lng: -0.12,
        radius: 2,
        unit: "kilometers",
        within: true,
        drag: true,
        collapsed: false,
        color: "red",
        ...data,
    },
});

describe("summarizing a question", () => {
    test("says what each type asks and its answer, in the cards' words", () => {
        expect(summarizeQuestion(radius())).toBe("2 km, Inside");
        expect(
            summarizeQuestion(
                radius({ radius: 500, unit: "meters", within: false }),
            ),
        ).toBe("500 m, Outside");
        expect(
            summarizeQuestion(radius({ radius: 2000, unit: "meters" })),
        ).toBe("2 km, Inside");
        expect(
            summarizeQuestion({
                id: "thermometer",
                key: 1,
                data: { warmer: false },
            }),
        ).toBe("Colder");
        expect(
            summarizeQuestion({
                id: "tentacles",
                key: 1,
                data: {
                    radius: 1,
                    unit: "kilometers",
                    locationType: "tentacle-museums",
                    location: {
                        type: "Feature",
                        properties: { name: "Library" },
                    },
                },
            }),
        ).toBe("Museums 1 km: Library");
        expect(
            summarizeQuestion({
                id: "tentacles",
                key: 1,
                data: {
                    radius: 1,
                    unit: "miles",
                    locationType: "custom",
                    location: false,
                },
            }),
        ).toBe("Custom locations 1 mi: None chosen");
        expect(
            summarizeQuestion({
                id: "matching",
                key: 1,
                data: { type: "matching-airport", same: true },
            }),
        ).toBe("Airport: Same");
        expect(
            summarizeQuestion({
                id: "measuring",
                key: 1,
                data: { type: "measuring-coastline", hiderCloser: true },
            }),
        ).toBe("Coastline: Hider Closer");
        expect(
            summarizeQuestion({
                id: "zone-size",
                key: 1,
                data: { multiplier: 1.5 },
            }),
        ).toBe("×1.5");
    });

    test("uses the game's names for its question kinds", () => {
        const kindLabel = (kind: string) =>
            ({
                "matching-airport": "Nearest Airport",
                "tentacle-museums": "Tentacles: Museums",
            })[kind];
        expect(
            summarizeQuestion(
                {
                    id: "matching",
                    key: 1,
                    data: { type: "matching-airport", same: false },
                },
                { kindLabel },
            ),
        ).toBe("Nearest Airport: Different");
        expect(
            summarizeQuestion(
                {
                    id: "tentacles",
                    key: 1,
                    data: {
                        radius: 2,
                        unit: "kilometers",
                        locationType: "tentacle-museums",
                    },
                },
                { kindLabel },
            ),
        ).toBe("Museums 2 km: None chosen");
    });

    test("notes a hidden question", () => {
        expect(summarizeQuestion(radius({ enabled: false }))).toBe(
            "2 km, Inside, Hidden",
        );
    });

    test("falls back to the type for anything it can't read, and never throws", () => {
        expect(summarizeQuestion({ id: "radius", key: 1 })).toBe("Radius");
        expect(summarizeQuestion({ id: "teleport", key: 1, data: {} })).toBe(
            "Question",
        );
        expect(summarizeQuestion(null)).toBe("Question");
        expect(summarizeQuestion("nonsense")).toBe("Question");
        expect(
            summarizeQuestion({
                id: "radius",
                data: { radius: "far", within: "yes" },
            }),
        ).toBe("Radius");
        const throwing = {
            id: "matching",
            data: { type: "matching-x", same: true },
        };
        expect(
            summarizeQuestion(throwing, {
                kindLabel: () => {
                    throw new Error("boom");
                },
            }),
        ).toBe("X: Same");
        expect(questionTypeLabel({ id: "zone-size" })).toBe("Zone Size");
        expect(questionTypeLabel(undefined)).toBe("Question");
    });
});

describe("what differs between two versions", () => {
    test("says how far the pin moved when only the location changed", () => {
        // 0.0027° of latitude is about 300 m.
        expect(questionDifferences(radius(), radius({ lat: 51.5027 }))).toEqual(
            ["pin moved 300 m"],
        );
        expect(
            questionDifferences(radius(), radius({ lat: 51.5027 }), {
                unit: "miles",
            }),
        ).toEqual(["pin moved 0.187 mi"]);
    });

    test("names the fields that differ, once each", () => {
        expect(
            questionDifferences(radius(), radius({ within: false })),
        ).toEqual(["answer"]);
        expect(
            questionDifferences(
                radius(),
                radius({ radius: 3, unit: "miles", name: "Park" }),
            ),
        ).toEqual(["radius", "name"]);
        expect(
            questionDifferences(
                {
                    id: "thermometer",
                    data: { latA: 1, lngA: 1, latB: 2, lngB: 2, warmer: true },
                },
                {
                    id: "thermometer",
                    data: {
                        latA: 1,
                        lngA: 1,
                        latB: 2.01,
                        lngB: 2,
                        warmer: false,
                    },
                },
            ),
        ).toEqual(["end moved 1.112 km", "answer"]);
        expect(
            questionDifferences(radius(), { id: "thermometer", data: {} }),
        ).toEqual(["type"]);
    });

    test("ignores how a device shows it, the key, and field order", () => {
        expect(
            questionDifferences(
                radius({ drag: false, collapsed: true }, 0.2),
                radius(),
            ),
        ).toEqual([]);
        const reordered = {
            data: { ...radius().data },
            key: 0.1,
            id: "radius",
        };
        expect(questionDifferences(radius(), reordered)).toEqual([]);
    });

    test("copes with unreadable versions", () => {
        expect(questionDifferences(radius(), radius({ lat: "north" }))).toEqual(
            ["pin moved"],
        );
        expect(questionDifferences(null, null)).toEqual([]);
        expect(questionDifferences(radius(), radius({ shiny: true }))).toEqual([
            "other details",
        ]);
        expect(
            questionDifferences({ ...radius(), extra: 1 }, radius()),
        ).toEqual(["other details"]);
    });
});

describe("a conflict in words", () => {
    const board = [
        radius({}, 0.1),
        { id: "thermometer", key: 0.2, data: {} },
        radius({}, 0.3),
    ];

    test("labels a question on the board as its card does, preferring its name", () => {
        expect(
            conflictQuestionLabel(board, {
                key: 0.3,
                mine: null,
                theirs: null,
            }),
        ).toEqual({
            label: "Radius 2",
            name: undefined,
        });
        const named = [
            ...board.slice(0, 2),
            radius({ name: "  The park " }, 0.3),
        ];
        expect(
            conflictQuestionLabel(named, {
                key: 0.3,
                mine: null,
                theirs: null,
            }),
        ).toEqual({
            label: "Radius 2",
            name: "The park",
        });
        // A key read back a unit in the last place off is the same question.
        expect(
            conflictQuestionLabel(board, {
                key: 0.30000000000000004,
                mine: null,
                theirs: null,
            }).label,
        ).toBe("Radius 2");
    });

    test("doesn't number one the board doesn't hold, which another may be", () => {
        // The board's "Radius 1" and "Radius 2" are other questions.
        const deleted = radius({ name: "Mine" }, 0.4);
        expect(
            conflictQuestionLabel(board, {
                key: 0.4,
                mine: deleted,
                theirs: null,
            }),
        ).toEqual({ label: "Radius (not on the map)", name: "Mine" });
        expect(
            conflictQuestionLabel(board, {
                key: 0.4,
                mine: null,
                theirs: { id: "thermometer", key: 0.4, data: {} },
            }).label,
        ).toBe("Thermometer (not on the map)");
        expect(
            conflictQuestionLabel(board, {
                key: 0.4,
                mine: { id: "teleport", key: 0.4, data: {} },
                theirs: null,
            }).label,
        ).toBe("Question (not on the map)");
    });

    test("shows the raw values of versions that read the same", () => {
        const km = radius({ radius: 2, unit: "kilometers" });
        const m = radius({ radius: 2000, unit: "meters" });
        expect(summarizeQuestion(km)).toBe(summarizeQuestion(m));
        expect(rawDifferences(km, m)).toEqual({
            a: ["radius 2 km"],
            b: ["radius 2000 m"],
        });
        expect(rawDifferences(radius({ name: "Park" }), radius())).toEqual({
            a: ['name "Park"'],
            b: ["no name"],
        });
        expect(
            rawDifferences(radius({ color: "red" }), radius({ color: "blue" })),
        ).toEqual({ a: ["color red"], b: ["color blue"] });
        // Pins and areas say what differs elsewhere; device fields never do.
        expect(
            rawDifferences(
                radius({ lat: 1, drag: false, geo: { a: 1 } }),
                radius({ geo: { a: 2 } }),
            ),
        ).toEqual({ a: [], b: [] });
        expect(rawDifferences(null, "x")).toEqual({ a: [], b: [] });
    });

    test("names the other player", () => {
        expect(conflictAuthorName({ displayName: "Alex", self: false })).toBe(
            "Alex",
        );
        expect(conflictAuthorName({ displayName: "Alex", self: true })).toBe(
            "you on another device",
        );
        expect(conflictAuthorName({ displayName: " ", self: false })).toBe(
            "another player",
        );
        expect(conflictAuthorName(null)).toBe("another player");
        expect(conflictAuthorName(undefined)).toBe("another player");
    });

    test("says who deleted it", () => {
        const alex = { displayName: "Alex", self: false };
        expect(conflictDeletionLine("they-deleted", alex)).toBe(
            "you edited it · Alex deleted it",
        );
        expect(conflictDeletionLine("we-deleted", alex)).toBe(
            "you deleted it · Alex edited it",
        );
        expect(conflictDeletionLine("both-changed", alex)).toBeUndefined();
    });

    test("counts the questions waiting", () => {
        expect(conflictCountText(1)).toBe("1 question needs a decision");
        expect(conflictCountText(3)).toBe("3 questions need a decision");
    });
});
