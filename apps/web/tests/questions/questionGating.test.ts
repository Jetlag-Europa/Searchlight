import { describe, expect, it } from "vitest";

import { isQuestionTypeHidden } from "@/lib/games";
import {
    determineUnionizedStrings,
    gateAllows,
    measuringQuestionSchema,
    NO_GROUP,
} from "@/maps/schema";

// Mirrors the filter in components/cards/measuring.tsx: a type is offered only
// if it is ungated or gated to the active game, and not hidden by the manifest.
function measuringPickerTypes(sentinel: string) {
    return measuringQuestionSchema.options
        .filter((x: any) => x.description === NO_GROUP)
        .flatMap((x: any) => determineUnionizedStrings(x.shape.type))
        .map((x: any) => x._def.value as string)
        .filter((value: string) => {
            return (
                gateAllows(value, sentinel) &&
                !isQuestionTypeHidden(value, sentinel, "measuring")
            );
        });
}

const SOUTH_LIMBURG = "__bundled-south-limburg-2026__";
const OTHER_GAMES = [
    "__bundled-belgium-2026__",
    "__bundled-budapest-2025__",
    "__bundled-zurich-2026__",
    "__bundled-luxembourg-2026__",
    "__bundled-paris-2026__",
];

// international-border-og shipped ungated and was therefore live in every
// game's measuring picker, where it fell through to an unverified Overpass
// query. Only South Limburg has a bundled border file (BUNDLED_BORDER_FILES in
// questions/measuring.ts), so it is scoped to that game. A future game opts in
// by adding a BUNDLED_BORDER_FILES entry and widening this gate — at which
// point this test should be updated deliberately, not deleted.
describe("international-border-og gating", () => {
    it("is offered for South Limburg", () => {
        expect(measuringPickerTypes(SOUTH_LIMBURG)).toContain(
            "international-border-og",
        );
    });

    it.each(OTHER_GAMES)("is NOT offered for %s", (sentinel) => {
        expect(measuringPickerTypes(sentinel)).not.toContain(
            "international-border-og",
        );
    });

    it("every game with a bundled border file is allowed by the gate", async () => {
        // Guards the inverse mistake: adding a bundled file but forgetting to
        // widen the gate, which would make the file unreachable.
        const src = await import("node:fs").then((fs) =>
            fs.readFileSync(
                new URL("../../src/maps/questions/measuring.ts", import.meta.url),
                "utf8",
            ),
        );
        const block = src.match(
            /BUNDLED_BORDER_FILES[^=]*=\s*\{([\s\S]*?)\}/,
        )?.[1];
        expect(block).toBeTruthy();

        const sentinels = [...block!.matchAll(/"(__bundled-[^"]+__)"/g)].map(
            (m) => m[1],
        );
        expect(sentinels.length).toBeGreaterThan(0);
        for (const sentinel of sentinels) {
            expect(measuringPickerTypes(sentinel)).toContain(
                "international-border-og",
            );
        }
    });
});
