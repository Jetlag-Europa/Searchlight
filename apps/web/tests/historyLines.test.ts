import type { QuestionChange, QuestionHistoryEntry } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { historyLines } from "@/lib/historyLines";

// The next double up: a key saved one ulp off by an older client.
const nextUp = (x: number) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    return view.getFloat64(0);
};

const K1 = 0.12345678901234566;
const K2 = 0.7654321098765432;
const K3 = 0.3141592653589793;

const T0 = Date.parse("2026-11-02T14:00:00Z");
let sequence = 0;
const entry = (
    changes: QuestionChange[],
    extra: Partial<QuestionHistoryEntry> & { seconds?: number } = {},
): QuestionHistoryEntry => {
    const { seconds = 0, ...rest } = extra;
    return {
        sequence: ++sequence,
        userId: "u1",
        displayName: "Sam",
        at: new Date(T0 + seconds * 1000).toISOString(),
        changes,
        ...rest,
    };
};

const added = (key: number, typeIndex = 1, id = "radius"): QuestionChange => ({
    kind: "added",
    key,
    id,
    index: typeIndex - 1,
    typeIndex,
    after: {},
});
const removed = (key: number, typeIndex = 1): QuestionChange => ({
    kind: "removed",
    key,
    id: "radius",
    index: typeIndex - 1,
    typeIndex,
    question: { id: "radius", key, data: { lat: 1, lng: 2 } },
});
const changed = (
    key: number,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    id = "radius",
    typeIndex = 1,
): QuestionChange => ({
    kind: "changed",
    key,
    id,
    index: typeIndex - 1,
    typeIndex,
    fields: [...new Set([...Object.keys(before), ...Object.keys(after)])],
    before,
    after,
});

const texts = (
    entries: QuestionHistoryEntry[],
    options: Partial<Parameters<typeof historyLines>[1]> = {},
) => historyLines(entries, options).map((line) => `${line.who} ${line.text}`);

describe("question history lines", () => {
    it("says who added a question, newest first", () => {
        const lines = historyLines(
            [
                entry([added(K1)]),
                entry([added(K2, 2)], { userId: "u2", displayName: "Alex" }),
            ],
            {},
        );
        expect(lines.map((l) => `${l.who} ${l.text}`)).toEqual([
            "Alex added Radius 2",
            "Sam added Radius 1",
        ]);
        expect(lines[0].at).toBe(new Date(T0).toISOString());
    });

    it("says You for the reader's own changes", () => {
        expect(texts([entry([added(K1)])], { selfId: "u1" })).toEqual([
            "You added Radius 1",
        ]);
        expect(texts([entry([added(K1)])], { selfId: "u2" })).toEqual([
            "Sam added Radius 1",
        ]);
    });

    it("makes one line of a save that adds 3 or more questions", () => {
        const lines = historyLines(
            [entry([added(K1), added(K2, 2), added(K3, 1, "matching")])],
            {},
        );
        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe("added 3 questions");
        expect(lines[0].items?.map((i) => i.label)).toEqual([
            "Radius 1",
            "Radius 2",
            "Matching 1",
        ]);
        expect(texts([entry([added(K1), added(K2, 2)])])).toEqual([
            "Sam added Radius 1",
            "Sam added Radius 2",
        ]);
    });

    it("offers a deleted question back, with the order it was deleted from", () => {
        const [line] = historyLines(
            [entry([removed(K2, 2)], { order: [K1, K2] })],
            {},
        );
        expect(line.text).toBe("deleted Radius 2");
        expect(line.removed).toEqual([
            {
                key: K2,
                index: 1,
                label: "Radius 2",
                question: removed(K2).question,
                order: [K1, K2],
            },
        ]);
        expect(line.order).toEqual([K1, K2]);
    });

    it("groups a delete of 3 or more, each restorable", () => {
        const [line] = historyLines(
            [entry([removed(K1), removed(K2, 2), removed(K3, 3)])],
            {},
        );
        expect(line.text).toBe("deleted 3 questions");
        expect(line.removed).toHaveLength(3);
        expect(line.items?.every((item) => item.removed)).toBe(true);
    });

    it("says restored when a deleted question comes back", () => {
        expect(
            texts([
                entry([added(K1)]),
                entry([removed(K1)]),
                entry([added(nextUp(K1))]),
            ]),
        ).toEqual([
            "Sam restored Radius 1",
            "Sam deleted Radius 1",
            "Sam added Radius 1",
        ]);
    });

    it("uses the cards' words for answers, as the conflict window does", () => {
        const location = {
            type: "Feature",
            geometry: { type: "Point", coordinates: [4, 52] },
            properties: { name: "Rijksmuseum" },
        };
        expect(
            texts([
                entry([changed(K1, { within: true }, { within: false })]),
                entry([
                    changed(
                        K2,
                        { warmer: true },
                        { warmer: false },
                        "thermometer",
                    ),
                ]),
                entry([
                    changed(K3, { same: true }, { same: false }, "matching"),
                ]),
                entry([
                    changed(
                        K1,
                        { hiderCloser: true },
                        { hiderCloser: false },
                        "measuring",
                    ),
                ]),
                entry([
                    changed(K2, { location: false }, { location }, "tentacles"),
                ]),
                entry([
                    changed(K2, { location }, { location: false }, "tentacles"),
                ]),
            ]).reverse(),
        ).toEqual([
            "Sam answered Radius 1: Outside",
            "Sam answered Thermometer 1: Colder",
            "Sam answered Matching 1: Different",
            "Sam answered Measuring 1: Hider Further",
            "Sam answered Tentacles 1: Rijksmuseum",
            "Sam answered Tentacles 1: Not Within",
        ]);
        // An answer taken back.
        expect(texts([entry([changed(K1, { within: true }, {})])])).toEqual([
            "Sam cleared the answer of Radius 1",
        ]);
        // A place without a name.
        expect(
            texts([
                entry([
                    changed(
                        K2,
                        { location: false },
                        { location: { ...location, properties: {} } },
                        "tentacles",
                    ),
                ]),
            ]),
        ).toEqual(["Sam answered Tentacles 1: Location"]);
    });

    it("says how far a pin moved, in the player's unit", () => {
        const move = changed(K1, { lat: 52, lng: 4 }, { lat: 52.01, lng: 4 });
        expect(texts([entry([move])])).toEqual([
            "Sam moved Radius 1 (1.112 km)",
        ]);
        expect(texts([entry([move])], { unit: "miles" })).toEqual([
            "Sam moved Radius 1 (0.691 mi)",
        ]);
        // A thermometer: the end that moved.
        const thermometer = changed(
            K2,
            { latA: 52, lngA: 4, latB: 52, lngB: 4 },
            { latA: 52, lngA: 4, latB: 52.001, lngB: 4 },
            "thermometer",
        );
        thermometer.fields = ["latB"];
        expect(texts([entry([thermometer])])).toEqual([
            "Sam moved Thermometer 1 (end 111 m)",
        ]);
        // Both ends, one of them without a place to measure from.
        const both = changed(
            K2,
            { latA: 52, lngA: 4, lngB: 4 },
            { latA: 52.001, lngA: 4, latB: 52, lngB: 4 },
            "thermometer",
        );
        both.fields = ["latA", "latB"];
        expect(texts([entry([both])])).toEqual([
            "Sam moved Thermometer 1 (start 111 m, end)",
        ]);
    });

    it("describes names, locks, hiding and other fields", () => {
        const line = (change: QuestionChange) => texts([entry([change])])[0];
        expect(
            [
                changed(K1, {}, { name: "Airport radar" }),
                changed(K1, { name: "Airport radar" }, { name: "Airport" }),
                changed(K1, { name: "Airport" }, {}),
                changed(K1, { drag: true }, { drag: false }),
                changed(K1, { drag: false }, { drag: true }),
                changed(K1, { enabled: true }, { enabled: false }),
                changed(K1, { enabled: false }, { enabled: true }),
                changed(
                    K1,
                    { radius: 2, unit: "kilometers" },
                    { radius: 3, unit: "miles" },
                ),
                changed(
                    K1,
                    { multiplier: 1.5 },
                    { multiplier: 2 },
                    "zone-size",
                ),
            ].map(line),
        ).toEqual([
            "Sam renamed Radius 1 to Airport radar",
            "Sam renamed Airport radar to Airport",
            "Sam removed the name Airport from Radius 1",
            "Sam locked Radius 1",
            "Sam unlocked Radius 1",
            "Sam turned off Radius 1",
            "Sam turned on Radius 1",
            "Sam changed Radius 1 (radius)",
            "Sam changed Zone Size 1 (size)",
        ]);
    });

    it("names an area or places changed, which the history leaves out", () => {
        const zone = (seconds: number) =>
            entry(
                [
                    changed(
                        K1,
                        { geo: { omitted: true } },
                        { geo: { omitted: true } },
                        "matching",
                    ),
                ],
                { seconds },
            );
        expect(texts([zone(0)])).toEqual(["Sam changed Matching 1 (area)"]);
        // Two quick edits of it still read as a change.
        expect(texts([zone(0), zone(20)])).toEqual([
            "Sam changed Matching 1 (area)",
        ]);
        expect(
            texts([entry([changed(K1, { mystery: 1 }, { mystery: 2 })])]),
        ).toEqual(["Sam changed Radius 1 (other details)"]);
    });

    it("combines several kinds of change in one line", () => {
        expect(
            texts([
                entry([
                    changed(
                        K1,
                        { within: true, drag: true },
                        { within: false, drag: false },
                    ),
                ]),
            ]),
        ).toEqual(["Sam answered Radius 1: Outside and locked it"]);
        expect(
            texts([
                entry([
                    changed(
                        K1,
                        { name: undefined, radius: 2, enabled: true },
                        { name: "Big", radius: 5, enabled: false },
                    ),
                ]),
            ]),
        ).toEqual([
            "Sam renamed Radius 1 to Big, changed it (radius) and turned it off",
        ]);
    });

    it("says what a deleted question asked, kept short", () => {
        const deleted = (data: Record<string, unknown>) => ({
            ...removed(K1),
            question: { id: "radius", key: K1, data },
        });
        expect(
            texts([
                entry([
                    deleted({
                        lat: 1,
                        lng: 2,
                        radius: 500,
                        unit: "meters",
                        within: false,
                    }),
                ]),
            ]),
        ).toEqual(["Sam deleted Radius 1 (500\u00a0m, Outside)"]);
    });

    it("names a deleted question for a spectator, who gets only what it was", () => {
        const data = {
            name: "Airport",
            lat: 1,
            lng: 2,
            radius: 2,
            unit: "kilometers",
            within: true,
        };
        const { question: _, ...withoutQuestion } = removed(K1);
        const lines = historyLines(
            [
                entry([{ ...added(K1), after: data }]),
                entry([{ ...withoutQuestion, before: data }]),
                // Put back by a player: a copy under a new key.
                entry([{ ...added(K2), after: data }]),
            ],
            {},
        );
        expect(lines.map((line) => line.text)).toEqual([
            "restored Airport",
            "deleted Airport (2\u00a0km, Inside)",
            "added Airport",
        ]);
        expect(lines[1].removed?.[0]).toMatchObject({
            question: undefined,
            restoredAs: [K2],
        });
    });

    it("says when only the order changed", () => {
        expect(texts([entry([], { reordered: true })])).toEqual([
            "Sam reordered the questions",
        ]);
    });

    it("labels questions as their cards showed them at the time", () => {
        const radius = (key: number, typeIndex: number, name?: string) => ({
            ...added(key, typeIndex),
            after: name ? { name } : {},
        });
        expect(
            texts([
                entry([radius(K1, 1), radius(K2, 2, "Airport")]),
                entry([removed(K1)]),
                entry([
                    {
                        ...changed(
                            K2,
                            { within: true },
                            { within: false },
                            "radius",
                            1,
                        ),
                        // The name comes along with every change.
                        before: { within: true, name: "Airport" },
                        after: { within: false, name: "Airport" },
                    },
                ]),
                entry([radius(K3, 2)]),
            ]),
        ).toEqual([
            // Second among the radars when it was added, after Radius 1 went.
            "Sam added Radius 2",
            "Sam answered Airport: Outside",
            "Sam deleted Radius 1",
            "Sam added Radius 1",
            "Sam added Airport",
        ]);
        // A deleted question keeps the name it had.
        const named = removed(0.5);
        named.question = { id: "radius", key: 0.5, data: { name: "Old" } };
        expect(texts([entry([named])])).toEqual(["Sam deleted Old"]);
    });

    it("makes one line of quick edits to the same question", () => {
        const lines = historyLines(
            [
                entry([changed(K1, { radius: 2 }, { radius: 20 })]),
                entry([changed(K1, { radius: 20 }, { radius: 25 })], {
                    seconds: 30,
                }),
                entry(
                    [changed(K1, { lat: 52, lng: 4 }, { lat: 52.001, lng: 4 })],
                    { seconds: 80 },
                ),
            ],
            {},
        );
        expect(lines.map((l) => l.text)).toEqual([
            "moved Radius 1 (111 m) and changed it (radius)",
        ]);
        expect(lines[0].at).toBe(new Date(T0 + 80_000).toISOString());
    });

    it("counts the 90 s from a line's first edit", () => {
        const radius = (from: number, to: number) =>
            changed(K1, { radius: from }, { radius: to });
        expect(
            texts([
                entry([radius(1, 2)]),
                entry([radius(2, 3)], { seconds: 80 }),
                entry([radius(3, 4)], { seconds: 160 }),
            ]),
        ).toHaveLength(2);
    });

    it("keeps a merged line's name for a question no longer on the board", () => {
        const move = (from: number, to: number) =>
            changed(
                K1,
                { lat: from, lng: 4, name: "Home" },
                { lat: to, lng: 4, name: "Home" },
            );
        const merged = (c: QuestionChange) => ({
            ...c,
            fields: ["lat"],
        });
        expect(
            texts([
                entry([merged(move(52, 52.001))]),
                entry([merged(move(52.001, 52.002))], { seconds: 20 }),
            ]),
        ).toEqual(["Sam moved Home (222 m)"]);
    });

    it("keeps edits apart when far apart, by someone else, or answering", () => {
        const radius = (from: number, to: number) =>
            changed(K1, { radius: from }, { radius: to });
        // More than 90 s apart.
        expect(
            texts([
                entry([radius(1, 2)]),
                entry([radius(2, 3)], { seconds: 91 }),
            ]),
        ).toHaveLength(2);
        // Someone else.
        expect(
            texts([
                entry([radius(1, 2)]),
                entry([radius(2, 3)], { userId: "u2", displayName: "Alex" }),
            ]),
        ).toHaveLength(2);
        // An answer is always its own line.
        expect(
            texts([
                entry([radius(1, 2)]),
                entry([changed(K1, { within: true }, { within: false })]),
                entry([radius(2, 3)]),
            ]),
        ).toEqual([
            "Sam changed Radius 1 (radius)",
            "Sam answered Radius 1: Outside",
            "Sam changed Radius 1 (radius)",
        ]);
        // Another question in between.
        expect(
            texts([
                entry([radius(1, 2)]),
                entry([changed(K2, { radius: 1 }, { radius: 2 }, "radius", 2)]),
                entry([radius(2, 3)]),
            ]),
        ).toHaveLength(3);
    });

    it("merges quick edits field by field, keeping a name that was unset", () => {
        // Named, then moved: the name wasn't there before.
        expect(
            texts([
                entry([changed(K1, {}, { name: "Bob" })]),
                entry(
                    [
                        changed(
                            K1,
                            { lat: 52, lng: 4, name: "Bob" },
                            { lat: 52.001, lng: 4, name: "Bob" },
                        ),
                    ],
                    { seconds: 20 },
                ),
            ]),
        ).toEqual(["Sam renamed Radius 1 to Bob and moved it (111 m)"]);
        // Renamed, then the name cleared: it ends up unnamed.
        expect(
            texts([
                entry([changed(K1, { name: "A" }, { name: "B" })]),
                entry([changed(K1, { name: "B" }, {})], { seconds: 20 }),
            ]),
        ).toEqual(["Sam removed the name A from Radius 1"]);
    });

    it("leaves no line for quick edits that undid themselves", () => {
        expect(
            texts([
                entry([changed(K1, { drag: true }, { drag: false })]),
                entry([changed(K1, { drag: false }, { drag: true })], {
                    seconds: 10,
                }),
            ]),
        ).toEqual([]);
        expect(
            texts([
                entry([
                    changed(K1, { lat: 52, lng: 4 }, { lat: 52.01, lng: 4 }),
                ]),
                entry(
                    [changed(K1, { lat: 52.01, lng: 4 }, { lat: 52, lng: 4 })],
                    {
                        seconds: 10,
                    },
                ),
            ]),
        ).toEqual([]);
        // A third edit still joins them.
        expect(
            texts([
                entry([changed(K1, { drag: true }, { drag: false })]),
                entry([changed(K1, { drag: false }, { drag: true })], {
                    seconds: 10,
                }),
                entry([changed(K1, { drag: true }, { drag: false })], {
                    seconds: 20,
                }),
            ]),
        ).toEqual(["Sam locked Radius 1"]);
    });

    it("doesn't take a twin that was never deleted for a restore", () => {
        // Two unnamed ×1.5 curses: the same content.
        const curse = (key: number, typeIndex: number): QuestionChange => ({
            ...added(key, typeIndex, "zone-size"),
            after: { multiplier: 1.5 },
        });
        const lines = historyLines(
            [
                entry([curse(K1, 1), curse(K2, 2)]),
                entry([
                    {
                        ...removed(K1),
                        id: "zone-size",
                        question: {
                            id: "zone-size",
                            key: K1,
                            data: { multiplier: 1.5 },
                        },
                    },
                ]),
            ],
            {},
        );
        expect(lines.map((l) => l.text)).toEqual([
            "deleted Zone Size 1 (×1.5)",
            "added Zone Size 1",
            "added Zone Size 2",
        ]);
        expect(lines[0].removed?.[0].restoredAs).toBeUndefined();
    });

    it("says restored for a deleted question put back under a new key", () => {
        const radar = (key: number, data: Record<string, unknown>) => ({
            ...added(key),
            after: { ...data, geo: { omitted: true } },
        });
        const deleted = (key: number, data: Record<string, unknown>) => ({
            ...removed(key),
            question: { id: "radius", key, data: { ...data, geo: [1, 2] } },
        });
        expect(
            texts([
                entry([deleted(K1, { lat: 1, lng: 2 })]),
                // Folded and locked differently, the same question.
                entry([
                    radar(K2, { lat: 1, lng: 2, drag: false, collapsed: true }),
                ]),
                entry([radar(K3, { lat: 1, lng: 3 })]),
            ]),
        ).toEqual([
            "Sam added Radius 1",
            "Sam restored Radius 1",
            "Sam deleted Radius 1",
        ]);
        // The deleted one knows what it was restored as.
        expect(
            historyLines(
                [
                    entry([deleted(K1, { lat: 1, lng: 2 })]),
                    entry([radar(K2, { lat: 1, lng: 2 })]),
                ],
                {},
            )[1].removed?.[0].restoredAs,
        ).toEqual([K2]);
        // Three at once, each under a new key.
        const all = [
            { ...deleted(K1, { lat: 1 }), index: 0 },
            { ...deleted(K2, { lat: 2 }), index: 1, typeIndex: 2 },
            { ...deleted(K3, { lat: 3 }), index: 2, typeIndex: 3 },
        ];
        expect(
            historyLines(
                [
                    entry(all),
                    entry([
                        radar(0.11, { lat: 1 }),
                        { ...radar(0.22, { lat: 2 }), typeIndex: 2 },
                        { ...radar(0.33, { lat: 3 }), typeIndex: 3 },
                    ]),
                ],
                {},
            ).map((l) => l.text),
        ).toEqual(["restored 3 questions", "deleted 3 questions"]);
    });

    it("says restored for a save that brings back 3 or more deleted questions", () => {
        const all = [removed(K1), removed(K2, 2), removed(K3, 3)];
        const lines = historyLines(
            [
                entry(all),
                entry([added(K1), added(K2, 2), added(K3, 3)], { seconds: 5 }),
            ],
            {},
        );
        expect(lines.map((l) => l.text)).toEqual([
            "restored 3 questions",
            "deleted 3 questions",
        ]);
        // Not every one of them was deleted: they were added.
        expect(
            texts([
                entry([removed(K1)]),
                entry([added(K1), added(K2, 2), added(K3, 3)]),
            ])[0],
        ).toBe("Sam added 3 questions");
    });
});
