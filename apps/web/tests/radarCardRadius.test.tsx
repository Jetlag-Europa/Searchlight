import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the radius field's change handler.
const field = vi.hoisted(() => ({ onChange: (_: unknown) => {} }));
vi.mock("@/components/ui/input", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/components/ui/input")>()),
    Input: (props: { onChange: (e: unknown) => void }) => {
        field.onChange = props.onChange;
        return null;
    },
}));
// Only the radius field matters here; the rest reads `document`.
vi.mock("@/components/cards/base", () => ({
    QuestionCard: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/LatLngPicker", () => ({ LatitudeLongitude: () => null }));

import { RadiusQuestionComponent } from "@/components/cards/radius";
import { setActiveGameDefinition } from "@/game-definition/store";
import { questions } from "@/lib/context";

const radar = (key: number, radius: unknown): any => ({
    id: "radius",
    key,
    data: { lat: 59.33, lng: 18.06, radius, unit: "kilometers", drag: true },
});

afterEach(() => {
    questions.set([]);
    setActiveGameDefinition(null);
});

describe("radar card radius", () => {
    it("renders a stored radius of 0 or less, and ignores one typed", () => {
        // A game that declares radar radii, compared with this card's.
        setActiveGameDefinition(
            JSON.parse(
                readFileSync(
                    resolve("../../games/preloaded/stockholm-2026.game.json"),
                    "utf8",
                ),
            ),
        );
        const bad = radar(2, -3);
        questions.set([radar(1, 2), bad, radar(3, null)]);
        renderToStaticMarkup(
            <RadiusQuestionComponent data={bad.data} questionKey={2} />,
        );
        for (const value of ["0", "-1", ""]) {
            field.onChange({ target: { value } });
            expect(bad.data.radius).toBe(-3);
        }
        field.onChange({ target: { value: "0.5" } });
        expect(bad.data.radius).toBe(0.5);
    });
});
