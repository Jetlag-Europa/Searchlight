import { describe, expect, it } from "vitest";

import { isQuestionSupported } from "@/game-definition/store";
import {
    defaultQuestionLabel,
    normalizeQuestionName,
    QUESTION_NAME_MAX_LENGTH,
    questionName,
    setQuestionName,
} from "@/lib/questionNames";
import { questionSchema } from "@/maps/schema";

const radar = (data: object = {}) =>
    questionSchema.parse({ id: "radius", data: { lat: 50, lng: 6, ...data } });

describe("question names", () => {
    it("numbers questions within their type", () => {
        const list = [
            { id: "radius", key: 1 },
            { id: "thermometer", key: 2 },
            { id: "radius", key: 3 },
        ] as const;
        expect(defaultQuestionLabel(list, 1)).toBe("Radius 1");
        expect(defaultQuestionLabel(list, 2)).toBe("Thermometer 1");
        expect(defaultQuestionLabel(list, 3)).toBe("Radius 2");
        expect(defaultQuestionLabel(list, 4)).toBe("");
    });

    it("tidies typed names and treats blank as no name", () => {
        expect(normalizeQuestionName("  Airport   radar ")).toBe(
            "Airport radar",
        );
        expect(normalizeQuestionName("   ")).toBeUndefined();
        expect(normalizeQuestionName("x".repeat(100))).toHaveLength(
            QUESTION_NAME_MAX_LENGTH,
        );
        // An emoji at the limit is kept whole or dropped, never split.
        const atLimit = normalizeQuestionName(
            "x".repeat(QUESTION_NAME_MAX_LENGTH - 1) + "🚉🚉",
        )!;
        expect(Array.from(atLimit)).toHaveLength(QUESTION_NAME_MAX_LENGTH);
        expect(atLimit.endsWith("🚉")).toBe(true);
        expect(atLimit.isWellFormed()).toBe(true);
    });

    it("reads only string names", () => {
        expect(questionName({ name: " Bridge " })).toBe("Bridge");
        expect(questionName({ name: 42 })).toBeUndefined();
        expect(questionName({})).toBeUndefined();
    });

    it("drops the key when a name is cleared", () => {
        const data: { name?: string } = {};
        setQuestionName(data, "Station");
        expect(data).toEqual({ name: "Station" });
        setQuestionName(data, undefined);
        expect("name" in data).toBe(false);
    });

    it("keeps a name through the schema, so a pasted question keeps it", () => {
        expect(radar({ name: "  North radar " }).data.name).toBe("North radar");
        expect(
            questionSchema.parse({
                id: "thermometer",
                data: { latA: 50, lngA: 6, latB: 51, lngB: 6, name: "Train" },
            }).data.name,
        ).toBe("Train");
    });

    it("doesn't reject a question over a malformed name", () => {
        expect(radar({ name: { evil: true } }).data.name).toBeUndefined();
        expect(radar().data.name).toBeUndefined();
        expect(
            isQuestionSupported(
                {
                    id: "matching",
                    key: 1,
                    data: {
                        lat: 50,
                        lng: 6,
                        type: "custom-points",
                        geo: [],
                        name: 7,
                    },
                },
                null,
            ),
        ).toBe(true);
    });
});
