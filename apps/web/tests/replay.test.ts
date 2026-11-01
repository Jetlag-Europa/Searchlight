import { describe, expect, it } from "vitest";

import {
    condenseReplay,
    guessRoles,
    type LoggedPosition,
    positionAt,
    questionsAt,
    type ReplaySnapshot,
    trail,
} from "@/lib/replay";
import { type Question, questionSchema } from "@/maps/schema";

const radar = (key: number, drag: boolean, radius = 5): Question =>
    questionSchema.parse({
        id: "radius",
        key,
        data: { lat: 52, lng: 5, drag, radius, unit: "kilometers" },
    });

const dragOf = (q: Question) => (q.data as { drag?: boolean }).drag;

const snap = (at: number, ...questions: Question[]): ReplaySnapshot => ({
    at,
    questions,
});

describe("condenseReplay", () => {
    it("keeps answered questions with when they were asked and first locked", () => {
        const replay = condenseReplay([
            snap(100, radar(1, true)),
            snap(110, radar(1, true, 7)),
            snap(120, radar(1, false, 7)),
            snap(130, radar(1, true, 7)),
            snap(140, radar(1, false, 8)),
        ]);
        expect(replay.questions).toHaveLength(1);
        expect(replay.questions[0]).toMatchObject({
            askedAt: 100,
            answeredAt: 120,
        });
        // The final answer, not the first.
        expect(replay.questions[0]!.question.data).toMatchObject({
            radius: 8,
            drag: false,
        });
        expect(replay).toMatchObject({ start: 100, end: 140, clears: [] });
    });

    it("drops questions deleted on their own, even locked ones", () => {
        const replay = condenseReplay([
            snap(100, radar(1, false)),
            snap(110, radar(1, false), radar(2, false)),
            snap(120, radar(1, false)),
        ]);
        expect(replay.questions.map((q) => q.question.key)).toEqual([1]);
    });

    it("drops questions that were never locked", () => {
        const replay = condenseReplay([
            snap(100, radar(1, false), radar(2, true)),
        ]);
        expect(replay.questions.map((q) => q.question.key)).toEqual([1]);
    });

    it("keeps locked questions a clear removed, and records the clear", () => {
        const replay = condenseReplay([
            snap(100, radar(1, false), radar(4, false)),
            snap(110, radar(1, false), radar(4, false), radar(2, true)),
            snap(120),
            snap(130, radar(3, true)),
            snap(140, radar(3, false)),
        ]);
        // 2 was still a draft when the board was cleared.
        expect(replay.questions.map((q) => q.question.key)).toEqual([1, 4, 3]);
        expect(replay.clears).toEqual([120]);
    });

    it("treats deleting the only question, or undoing a clear, as no clear", () => {
        const deletedLast = condenseReplay([
            snap(100, radar(1, false)),
            snap(110),
        ]);
        expect(deletedLast.questions).toEqual([]);
        expect(deletedLast.clears).toEqual([]);

        const undone = condenseReplay([
            snap(100, radar(1, false), radar(2, false)),
            snap(110),
            snap(120, radar(1, false), radar(2, false)),
        ]);
        expect(undone.clears).toEqual([]);
        expect(undone.questions).toHaveLength(2);
    });

    it("handles no history", () => {
        expect(condenseReplay([])).toEqual({
            questions: [],
            clears: [],
            start: 0,
            end: 0,
        });
    });
});

describe("questionsAt", () => {
    const replay = condenseReplay([
        snap(100, radar(1, true)),
        snap(120, radar(1, false)),
        snap(200, radar(1, false), radar(2, true)),
        snap(250, radar(1, false), radar(2, false)),
    ]);

    it("shows asked questions unlocked until answered, then locked", () => {
        expect(questionsAt(replay, 99)).toEqual([]);
        expect(questionsAt(replay, 110).map((q) => [q.key, dragOf(q)])).toEqual(
            [[1, true]],
        );
        expect(questionsAt(replay, 210).map((q) => [q.key, dragOf(q)])).toEqual(
            [
                [1, false],
                [2, true],
            ],
        );
        expect(questionsAt(replay, 300).map((q) => dragOf(q))).toEqual([
            false,
            false,
        ]);
    });
});

describe("positionAt", () => {
    const positions: LoggedPosition[] = [
        [100, 52, 4, 10],
        [200, 53, 5, 20],
    ];

    it("interpolates between reports and holds the last one", () => {
        expect(positionAt(positions, 50)).toBeNull();
        expect(positionAt(positions, 150)).toEqual({
            lat: 52.5,
            lng: 4.5,
            accuracy: 10,
            reportedAt: 100,
        });
        expect(positionAt(positions, 300)).toEqual({
            lat: 53,
            lng: 5,
            accuracy: 20,
            reportedAt: 200,
        });
    });

    it("builds a trail ending at the interpolated position", () => {
        expect(trail(positions, 0, 150)).toEqual([
            [52, 4],
            [52.5, 4.5],
        ]);
    });
});

describe("guessRoles", () => {
    it("takes whoever stays put once questions start for the hider", () => {
        const roles = guessRoles(
            [
                // Travelled to the zone before questions, then stayed.
                {
                    id: "h",
                    positions: [
                        [0, 52.0, 4.0, null],
                        [50, 52.3, 4.5, null],
                        [100, 52.3, 4.5, null],
                        [200, 52.301, 4.501, null],
                    ],
                },
                // Waited, then travelled once questions started.
                {
                    id: "s",
                    positions: [
                        [0, 52.0, 4.0, null],
                        [100, 52.0, 4.0, null],
                        [200, 52.2, 4.3, null],
                        [300, 52.25, 4.4, null],
                    ],
                },
            ],
            100,
        );
        expect(Object.fromEntries(roles)).toEqual({ h: "hider", s: "seeker" });
    });

    it("guesses nothing for fewer than two people", () => {
        expect(
            guessRoles([{ id: "a", positions: [[0, 52, 4, null]] }], 0).size,
        ).toBe(0);
    });
});
