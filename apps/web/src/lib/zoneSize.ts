import type { Question } from "@/maps/schema";

export type ZoneSizeEntry = Extract<Question, { id: "zone-size" }>;

/** Whether a question-list entry resizes the hiding zones, not a question. */
export const isZoneSizeChange = (
    question: Pick<Question, "id">,
): question is ZoneSizeEntry => question.id === "zone-size";

const multiplierOf = (question: Question): number => {
    if (!isZoneSizeChange(question) || question.data.enabled === false)
        return 1;
    const { multiplier } = question.data;
    // Session questions are stored unparsed: ignore a malformed one.
    return typeof multiplier === "number" &&
        Number.isFinite(multiplier) &&
        multiplier > 0
        ? multiplier
        : 1;
};

/**
 * The hiding zones' size relative to the game's after the first `end`
 * entries of the list (all of them by default). The list runs in the order
 * questions were asked, so a size change applies to the questions below it.
 */
export const zoneScaleAfter = (
    questions: readonly Question[],
    end = questions.length,
): number =>
    questions.slice(0, end).reduce((scale, q) => scale * multiplierOf(q), 1);

// "×2", "×0.5", "×1.25": short enough for a card title.
export const formatMultiplier = (multiplier: number): string =>
    `×${Number(multiplier.toFixed(3))}`;
