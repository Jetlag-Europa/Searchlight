import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import {
    arrivedAt,
    boardAt,
    condenseReplay,
    findEndgame,
    guessRoles,
    hiderZone,
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

describe("boardAt", () => {
    const replay = condenseReplay([
        snap(100, radar(1, false), radar(2, false)),
        snap(200),
        snap(300, radar(3, true)),
        snap(310, radar(3, false)),
    ]);
    const keys = (time: number, endgameAt: number | null) =>
        boardAt(replay, time, endgameAt).questions.map((q) => q.key);

    it("shows every question without an endgame", () => {
        expect(boardAt(replay, 400, null).endgame).toBe(false);
        expect(keys(400, null)).toEqual([1, 2, 3]);
    });

    it("shows the questions before the endgame on the play area", () => {
        expect(boardAt(replay, 150, 250)).toEqual({
            questions: expect.any(Array),
            endgame: false,
        });
        expect(keys(150, 250)).toEqual([1, 2]);
    });

    it("shows only the endgame's questions from its start on", () => {
        expect(boardAt(replay, 250, 250)).toEqual({
            questions: [],
            endgame: true,
        });
        const late = boardAt(replay, 400, 250);
        expect(late.questions.map((q) => [q.key, dragOf(q)])).toEqual([
            [3, false],
        ]);
    });
});

describe("hiderZone", () => {
    const a = turf.circle([4.0, 52.0], 0.5, {
        units: "kilometers",
        properties: { id: "a" },
    });
    const b = turf.circle([4.1, 52.0], 0.5, {
        units: "kilometers",
        properties: { id: "b" },
    });

    it("picks the zone the hider is in", () => {
        expect(
            hiderZone([a, b], { lat: 52.0, lng: 4.101 })?.properties.id,
        ).toBe("b");
    });

    it("takes a zone just outside, but not a far one", () => {
        // ~0.7 km east of b's centre: 0.2 km outside it.
        expect(hiderZone([a, b], { lat: 52.0, lng: 4.11 })?.properties.id).toBe(
            "b",
        );
        expect(hiderZone([a, b], { lat: 52.2, lng: 4.5 })).toBeNull();
    });
});

// Around a 0.5 km zone at (52, 4): ~0.0045° of latitude is 0.5 km.
const MIN = 60_000;
const inZone: [number, number] = [52.0, 4.0];
const outside: [number, number] = [52.05, 4.0];
const nearby: [number, number] = [52.01, 4.0];
const track = (...points: [number, [number, number]][]): LoggedPosition[] =>
    points.map(([minute, [lat, lng]]) => [minute * MIN, lat, lng, 10]);

describe("arrivedAt", () => {
    const zone = turf.circle([4.0, 52.0], 0.5, { units: "kilometers" });

    it("finds the start of the first stay", () => {
        const seeker = track(
            [0, outside],
            [10, inZone],
            [13, inZone],
            [16, inZone],
        );
        expect(arrivedAt(seeker, zone, 0, Infinity)).toBe(10 * MIN);
    });

    it("ignores passing through, and short dips outside", () => {
        const seeker = track(
            [0, inZone],
            [2, outside],
            [20, inZone],
            [22, nearby],
            [23, inZone],
            [26, inZone],
        );
        expect(arrivedAt(seeker, zone, 0, Infinity)).toBe(20 * MIN);
    });

    it("counts a stay the reports end in, but nothing before `from`", () => {
        expect(arrivedAt(track([5, inZone]), zone, 0, Infinity)).toBe(5 * MIN);
        expect(
            arrivedAt(track([5, inZone]), zone, 6 * MIN, Infinity),
        ).toBeNull();
    });
});

describe("findEndgame", () => {
    const zones = [
        turf.circle([4.0, 52.0], 0.5, {
            units: "kilometers",
            properties: { id: "hider" },
        }),
        turf.circle([4.5, 52.0], 0.5, {
            units: "kilometers",
            properties: { id: "other" },
        }),
    ];
    const at = (minute: number, lat: number, lng: number, drag = false) =>
        questionSchema.parse({
            id: "radius",
            key: minute,
            data: { lat, lng, drag, radius: 1, unit: "kilometers" },
        });
    const hider = track(
        [0, [52.0, 4.5]],
        [5, inZone],
        [30, inZone],
        [60, inZone],
    );
    const seeker = track([0, outside], [40, inZone], [50, inZone]);

    it("starts when a seeker arrives in the hider's zone", () => {
        const replay = condenseReplay([
            snap(1 * MIN, at(1, ...outside)),
            snap(45 * MIN, at(1, ...outside), at(45, ...inZone)),
            snap(60 * MIN, at(1, ...outside), at(45, ...inZone)),
        ]);
        const endgame = findEndgame(replay, zones, hider, [seeker]);
        expect(endgame?.at).toBe(40 * MIN);
        expect(endgame?.zone?.properties.id).toBe("hider");
        expect(endgame?.by).toBe("arrival");
    });

    it("starts with a question asked near the zone just before", () => {
        const replay = condenseReplay([
            snap(1 * MIN, at(1, ...outside)),
            snap(35 * MIN, at(1, ...outside), at(35, ...nearby)),
            snap(60 * MIN, at(1, ...outside), at(35, ...nearby)),
        ]);
        expect(findEndgame(replay, zones, hider, [seeker])?.at).toBe(35 * MIN);
    });

    it("falls back to the clear without the seekers' positions", () => {
        const replay = condenseReplay([
            snap(1 * MIN, at(1, ...outside), at(2, ...outside)),
            snap(30 * MIN),
            snap(60 * MIN, at(50, ...inZone)),
        ]);
        expect(findEndgame(replay, zones, hider, [])).toMatchObject({
            at: 30 * MIN,
            by: "clear",
            zone: { properties: { id: "hider" } },
        });
        expect(findEndgame(replay, zones, null, [])?.zone).toBeNull();
    });
});
