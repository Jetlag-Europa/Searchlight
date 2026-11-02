import type { QuestionHistoryEntry } from "@searchlight/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { HistoryList } from "@/components/QuestionHistory";
import { historyLines } from "@/lib/historyLines";
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

const render = (current: { id: "radius"; key: number; data: object }[]) => {
    const lines = historyLines(entries, { selfId: "u1" });
    const onRestore = vi.fn();
    const html = renderToStaticMarkup(
        <HistoryList
            lines={lines}
            current={current}
            compiled={null}
            disabled={false}
            onRestore={onRestore}
        />,
    );
    return { html, lines };
};

describe("the question history list", () => {
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

    it("says On the board for a question that's back", () => {
        const { html } = render([{ id: "radius", key: 0.5, data: {} }]);
        expect(html).toContain("On the board");
        expect(html).not.toContain(">Restore</button>");
    });
});
