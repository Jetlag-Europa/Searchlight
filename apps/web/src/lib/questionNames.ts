import type { Question } from "@/maps/schema";

export const QUESTION_NAME_MAX_LENGTH = 60;

const TYPE_LABELS: Record<Question["id"], string> = {
    radius: "Radius",
    thermometer: "Thermometer",
    tentacles: "Tentacles",
    matching: "Matching",
    measuring: "Measuring",
    "zone-size": "Zone Size",
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

// What the board calls a question: its name, or "Radius 2" (empty when the
// board doesn't hold it). Positions shift as questions come and go, so this
// is the label as of `questions`.
export const boardLabel = (
    questions: readonly (Pick<Question, "id" | "key"> & {
        data?: { name?: unknown };
    })[],
    questionKey: number,
): string => {
    const question = questions.find((q) => q.key === questionKey);
    if (!question) return "";
    const name = questionName(question.data ?? {});
    if (name) return name;
    // One from another build may be of a type this one doesn't know.
    return TYPE_LABELS[question.id]
        ? defaultQuestionLabel(questions, questionKey)
        : "";
};
