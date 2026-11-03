import type { QuestionHistoryEntry } from "@searchlight/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryList, QuestionHistory } from "@/components/QuestionHistory";
import { activeSessionId } from "@/lib/activeSession";
import { historyLines } from "@/lib/historyLines";
import { setQuestionDecisionsPossible } from "@/lib/questionConflicts";
import { loadedHistory } from "@/lib/questionHistory";
import { questionSchema } from "@/maps/schema";

const radar = (key: number, name?: string) =>
    questionSchema.parse({
        id: "radius",
        key,
        data: { lat: 50, lng: 6, name },
    });

const entries: QuestionHistoryEntry[] = [
    {
        sequence: 1,
        userId: "u1",
        displayName: "Sam",
        at: "2026-11-02T14:00:00.000Z",
        changes: [
            { kind: "added", key: 0.25, id: "radius", index: 0, typeIndex: 1 },
            { kind: "added", key: 0.5, id: "radius", index: 1, typeIndex: 2 },
        ],
    },
    {
        sequence: 2,
        userId: "u2",
        displayName: "Alex",
        at: "2026-11-02T14:05:00.000Z",
        changes: [
            {
                kind: "removed",
                key: 0.5,
                id: "radius",
                index: 1,
                typeIndex: 2,
                question: radar(0.5, "Airport"),
            },
            {
                kind: "removed",
                key: 0.25,
                id: "radius",
                index: 0,
                typeIndex: 1,
                question: { id: "radius", key: 0.25, data: {} },
            },
        ],
        order: [0.25, 0.5],
    },
];

const render = (
    current: { id: "radius"; key: number; data: object }[],
    readOnly = false,
) => {
    const lines = historyLines(entries, { selfId: "u1" });
    const onRestore = vi.fn();
    const html = renderToStaticMarkup(
        <HistoryList
            lines={lines}
            current={current}
            compiled={null}
            disabled={false}
            readOnly={readOnly}
            onRestore={onRestore}
        />,
    );
    return { html, lines };
};

describe("the question history list", () => {
    beforeEach(() => setQuestionDecisionsPossible(true));
    afterEach(() => setQuestionDecisionsPossible(false));

    it("shows who did what, newest first, with Restore", () => {
        const { html } = render([]);
        const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        expect(text).toContain("Alex deleted Airport");
        expect(text).toContain("You added Radius 1");
        expect(text.indexOf("Alex deleted Airport")).toBeLessThan(
            text.indexOf("You added Radius 1"),
        );
        expect(html).toContain(">Restore</button>");
        // A question that won't parse says so instead of a button.
        expect(text).toMatch(/Can(&#x27;|')t be restored/);
        expect(html.match(/>Restore<\/button>/g)).toHaveLength(1);
    });

    it("offers a spectator no Restore, nor reasons why not", () => {
        const { html } = render([], true);
        expect(html).toContain("deleted Airport");
        expect(html).not.toContain(">Restore</button>");
        expect(html).not.toMatch(/restored|On the board/);
    });

    it("says On the board for a question that's back", () => {
        const { html } = render([{ id: "radius", key: 0.5, data: {} }]);
        expect(html).toContain("On the board");
        expect(html).not.toContain(">Restore</button>");
    });

    it("says On the board for the question it was restored as, edited since", () => {
        const deleted = entries[1].changes[0].question as {
            id: "radius";
            data: Record<string, unknown>;
        };
        // Restored under a new key, then moved there.
        const restored: QuestionHistoryEntry = {
            sequence: 3,
            userId: "u2",
            displayName: "Alex",
            at: "2026-11-02T14:06:00.000Z",
            changes: [
                {
                    kind: "added",
                    key: 0.875,
                    id: "radius",
                    index: 0,
                    typeIndex: 1,
                    after: deleted.data,
                },
            ],
        };
        const lines = historyLines([...entries, restored], { selfId: "u1" });
        expect(lines[0].text).toBe("restored Airport");
        // Moved there since.
        const moved = {
            ...deleted,
            key: 0.875,
            data: { ...deleted.data, lat: 51 },
        };
        const html = renderToStaticMarkup(
            <HistoryList
                lines={lines}
                current={[moved]}
                compiled={null}
                disabled={false}
                onRestore={vi.fn()}
            />,
        );
        expect(html).toContain("On the board");
        expect(html).not.toContain(">Restore</button>");
    });

    it("says why Restore waits while no decision can be taken", () => {
        setQuestionDecisionsPossible(false);
        const { html } = render([]);
        expect(html).toMatch(/>(Loading…|Offline)</);
        expect(html).not.toContain(">Restore</button>");
    });
});

describe("the History opened again", () => {
    const text = () =>
        renderToStaticMarkup(<QuestionHistory />)
            .replace(/<[^>]+>/g, " ")
            .replace(/&#x27;/g, "'")
            .replace(/\s+/g, " ");
    const kept = (refreshFailed: boolean) =>
        loadedHistory.set({
            sessionId: "s1",
            history: { entries, nextBefore: null, newest: 2 },
            refreshFailed,
        });

    beforeEach(() => {
        activeSessionId.set("s1");
        setQuestionDecisionsPossible(true);
    });
    afterEach(() => {
        activeSessionId.set("");
        setQuestionDecisionsPossible(false);
    });

    it("shows what was loaded at once", () => {
        kept(false);
        expect(text()).toContain("Alex deleted Airport");
        expect(text()).toContain("Restore");
        expect(text()).not.toMatch(/Loading…|Couldn't refresh/);
    });

    it("says when it couldn't be brought up to date, keeping what it has", () => {
        kept(true);
        expect(text()).toContain("Couldn't refresh");
        expect(text()).toContain("Alex deleted Airport");
    });

    it("loads afresh for another session", () => {
        kept(false);
        activeSessionId.set("s2");
        expect(text()).toContain("Loading…");
        expect(text()).not.toContain("Airport");
    });
});
