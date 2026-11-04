import { describe, expect, it } from "vitest";

import {
    answerInput,
    type MapResult,
    planningPreviewKey,
    sameResult,
    standingResult,
    writeBackAnswers,
} from "@/maps/mapResult";

const radius = (key: number, lng: number, drag = false): any => ({
    id: "radius",
    key,
    data: {
        lat: 51.5,
        lng,
        radius: 10,
        unit: "kilometers",
        within: true,
        drag,
        color: "black",
        collapsed: false,
    },
});

describe("skipping a map refresh", () => {
    const base = { type: "FeatureCollection", features: [] };
    const compiled = {};
    const regions = [{}, {}];
    const answered = [
        { question: radius(1, 4.3), region: regions[0], zoneScale: 1 },
        { question: radius(2, 4.7), region: regions[1], zoneScale: 1 },
    ];
    const mask = {};
    const shown: MapResult = {
        inputs: [base, compiled],
        answered,
        mask,
        previewKey: "",
    };
    const published = { answered, mask };
    // A refresh after a teammate's save: fresh questions, the cached regions.
    const refreshed = () => [
        { question: radius(1, 4.3), region: regions[0], zoneScale: 1 },
        { question: radius(2, 4.7), region: regions[1], zoneScale: 1 },
    ];

    it("keeps the map when the same regions come back", () => {
        const standing = standingResult(shown, [base, compiled], published);
        expect(standing).toBe(shown);
        expect(sameResult(standing!, refreshed(), "")).toBe(true);
    });

    it("redraws when a region or its zone size changes", () => {
        const changed = refreshed();
        changed[1].region = {};
        expect(sameResult(shown, changed, "")).toBe(false);

        const resized = refreshed();
        resized[1].zoneScale = 0.5;
        expect(sameResult(shown, resized, "")).toBe(false);

        expect(sameResult(shown, refreshed().slice(0, 1), "")).toBe(false);
        expect(sameResult(shown, refreshed().reverse(), "")).toBe(false);
    });

    it("redraws when the same region belongs to another question", () => {
        const moved = refreshed();
        moved[0].question = radius(3, 4.3);
        expect(sameResult(shown, moved, "")).toBe(false);
    });

    it("redraws when the planning outlines change", () => {
        expect(sameResult(shown, refreshed(), "[]")).toBe(false);
    });

    it("redraws against a new base or game", () => {
        expect(
            standingResult(shown, [structuredClone(base), compiled], published),
        ).toBeUndefined();
        expect(
            standingResult(shown, [base, { ...compiled }], published),
        ).toBeUndefined();
        expect(
            standingResult(null, [base, compiled], published),
        ).toBeUndefined();
    });

    it("redraws once the published results were cleared behind its back", () => {
        // As resetGameState does.
        expect(
            standingResult(shown, [base, compiled], { answered: [], mask }),
        ).toBeUndefined();
        expect(
            standingResult(shown, [base, compiled], { answered, mask: null }),
        ).toBeUndefined();
    });
});

describe("planning outlines", () => {
    it("are only drawn in planning mode", () => {
        expect(planningPreviewKey([radius(1, 4.3, true)], false)).toBe("");
        expect(planningPreviewKey([radius(1, 4.3, true)], true)).not.toBe(
            planningPreviewKey([], true),
        );
    });

    it("don't change with an unlocked question's name or colours", () => {
        const renamed = radius(1, 4.3, true);
        renamed.data.name = "Airport";
        renamed.data.color = "red";
        renamed.data.collapsed = true;
        expect(planningPreviewKey([renamed], true)).toBe(
            planningPreviewKey([radius(1, 4.3, true)], true),
        );
    });

    it("change when an unlocked question moves or is locked", () => {
        const key = planningPreviewKey([radius(1, 4.3, true)], true);
        expect(planningPreviewKey([radius(1, 4.4, true)], true)).not.toBe(key);
        expect(planningPreviewKey([radius(1, 4.3, false)], true)).not.toBe(key);
    });

    it("change when matching questions start drawing every cell", () => {
        const matching = {
            id: "matching",
            key: 3,
            data: { lat: 51.5, lng: 4.3, drag: true, type: "custom-points" },
        } as any;
        const questions = [radius(1, 4.3, true), matching];
        expect(planningPreviewKey(questions, true, true)).not.toBe(
            planningPreviewKey(questions, true),
        );
        expect(planningPreviewKey(questions, false, true)).toBe("");
        // Without an unlocked matching question, nothing would change.
        expect(planningPreviewKey([radius(1, 4.3, true)], true, true)).toBe(
            planningPreviewKey([radius(1, 4.3, true)], true),
        );
        expect(
            planningPreviewKey(
                [{ ...matching, data: { ...matching.data, drag: false } }],
                true,
                true,
            ),
        ).toBe(planningPreviewKey([], true));
    });

    it("don't change when a locked question moves", () => {
        expect(
            planningPreviewKey([radius(1, 4.3, true), radius(2, 4.7)], true),
        ).toBe(
            planningPreviewKey([radius(1, 4.3, true), radius(2, 4.8)], true),
        );
    });
});

describe("hider mode's answers", () => {
    const snapshotOf = (questions: any[]) => {
        const snapshot = structuredClone(questions);
        const before = snapshot.map(({ data }) => answerInput(data));
        return { snapshot, before };
    };

    it("are written into the questions they answer", () => {
        const sources = [radius(1, 4.3, true)];
        const { snapshot, before } = snapshotOf(sources);
        snapshot[0].data.within = false;
        expect(writeBackAnswers(sources, snapshot, before)).toBe(true);
        expect(sources[0].data.within).toBe(false);
    });

    it("keep an edit made since the snapshot", () => {
        const sources = [radius(1, 4.3, true)];
        const { snapshot, before } = snapshotOf(sources);
        snapshot[0].data.within = false;
        // A marker drag with auto-save off.
        sources[0].data.lng = 4.5;
        expect(writeBackAnswers(sources, snapshot, before)).toBe(false);
        expect(sources[0].data).toMatchObject({ lng: 4.5, within: true });
    });

    it("write nothing when no answer changed", () => {
        const sources = [radius(1, 4.3, true)];
        const data = sources[0].data;
        const { snapshot, before } = snapshotOf(sources);
        expect(writeBackAnswers(sources, snapshot, before)).toBe(false);
        expect(sources[0].data).toBe(data);
    });

    it("reach a card folded or renamed since the snapshot", () => {
        const sources = [radius(1, 4.3, true)];
        const { snapshot, before } = snapshotOf(sources);
        snapshot[0].data.within = false;
        // Folded and renamed with auto-save off.
        sources[0].data.collapsed = true;
        sources[0].data.name = "Lake";
        expect(writeBackAnswers(sources, snapshot, before)).toBe(true);
        expect(sources[0].data).toMatchObject({
            within: false,
            collapsed: true,
            name: "Lake",
        });
    });

    it("only go to the question they were worked out for", () => {
        // Defensive: deletes replace the list, which makes the refresh
        // obsolete before it writes anything.
        const sources = [radius(1, 4.3, true), radius(2, 4.3, true)];
        const { snapshot, before } = snapshotOf(sources);
        snapshot[0].data.within = false;
        sources.splice(0, 1);
        expect(writeBackAnswers(sources, snapshot, before)).toBe(false);
        expect(sources[0].data.within).toBe(true);
    });
});
