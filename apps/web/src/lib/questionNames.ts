import type { Question } from "@/maps/schema";

export const QUESTION_NAME_MAX_LENGTH = 60;

const TYPE_LABELS: Record<Question["id"], string> = {
    radius: "Radius",
    thermometer: "Thermometer",
    tentacles: "Tentacles",
    matching: "Matching",
    measuring: "Measuring",
};

// "Radius 2": the type and the question's position among those of its type.
export const defaultQuestionLabel = (
    questions: readonly Pick<Question, "id" | "key">[],
    questionKey: number,
): string => {
    const question = questions.find((q) => q.key === questionKey);
    if (!question) return "";
    const position =
        questions
            .filter((q) => q.id === question.id)
            .findIndex((q) => q.key === questionKey) + 1;
    return `${TYPE_LABELS[question.id]} ${position}`;
};

// What the player typed, tidied: blank means no name. Cut by code point, so
// an emoji at the limit isn't split in half.
export const normalizeQuestionName = (name: string): string | undefined =>
    Array.from(name.replace(/\s+/g, " ").trim())
        .slice(0, QUESTION_NAME_MAX_LENGTH)
        .join("")
        .trim() || undefined;

// Session questions are stored unparsed, so a name from another client may be
// anything.
export const questionName = (data: { name?: unknown }): string | undefined =>
    typeof data.name === "string"
        ? normalizeQuestionName(data.name)
        : undefined;

// Keeps an unnamed question's JSON free of a `name` key.
export const setQuestionName = (
    data: { name?: string },
    name: string | undefined,
) => {
    if (name) data.name = name;
    else delete data.name;
};
