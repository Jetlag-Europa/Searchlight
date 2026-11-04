import { isZoneSizeChange } from "@/lib/zoneSize";

import { regionData } from ".";
import type { Questions } from "./schema";

/** Each question's region, as perQuestionMapData publishes them. */
type Answered = readonly {
    question?: { key?: number } | null;
    region: unknown;
    zoneScale?: number;
}[];

/** What the map last drew and published. */
export interface MapResult {
    /** What it was worked out against, compared by identity. */
    inputs: readonly unknown[];
    /** As published to perQuestionMapData. */
    answered: Answered;
    /** As published to questionFinishedMapData. */
    mask: unknown;
    previewKey: string;
}

/**
 * The questions planning mode outlines on the map, by what their outlines
 * depend on, and whether matching questions draw every cell around them.
 * Empty outside planning mode.
 */
export function planningPreviewKey(
    questions: Questions,
    planning: boolean,
    allMatchingCells = false,
): string {
    if (!planning) return "";
    const outlined = questions.filter(
        (question) =>
            !isZoneSizeChange(question) &&
            question.data.enabled !== false &&
            question.data.drag,
    );
    const key = JSON.stringify(
        outlined.map((question) => [
            question.key,
            question.id,
            regionData(question),
        ]),
    );
    return allMatchingCells &&
        outlined.some((question) => question.id === "matching")
        ? `all-cells ${key}`
        : key;
}

/**
 * The last result, if the map still shows it and it was worked out against
 * the same `inputs`. Resetting the game clears the published atoms behind
 * the map's back.
 */
export function standingResult<T extends MapResult>(
    previous: T | null | undefined,
    inputs: readonly unknown[],
    published: { answered: unknown; mask: unknown },
): T | undefined {
    if (
        !previous ||
        previous.answered !== published.answered ||
        previous.mask !== published.mask ||
        previous.inputs.length !== inputs.length ||
        previous.inputs.some((input, index) => input !== inputs[index])
    )
        return undefined;
    return previous;
}

/**
 * Whether a refresh would draw what `shown` already does: the same planning
 * outlines, and the same regions for the same questions, in order, at the
 * same zone sizes. The region cache hands back the same region for an
 * unchanged answer, so a rename or a lock toggle changes nothing.
 */
export function sameResult(
    shown: MapResult,
    answered: Answered,
    previewKey: string,
): boolean {
    return (
        shown.previewKey === previewKey &&
        shown.answered.length === answered.length &&
        answered.every(
            (entry, index) =>
                entry.region === shown.answered[index].region &&
                entry.zoneScale === shown.answered[index].zoneScale &&
                // The answer split leaves a question's own region out by key.
                entry.question?.key === shown.answered[index].question?.key,
        )
    );
}

/** What hider mode answers a question from: its name and fold change nothing. */
export const answerInput = (data: Questions[number]["data"]): string =>
    JSON.stringify({ ...data, name: undefined, collapsed: undefined });

/**
 * Writes hider mode's answers from `answered`, a snapshot of `sources` whose
 * `answerInput` was `before` before answering, into the source questions.
 * A question edited in place since the snapshot (auto-save off, a marker
 * drag) keeps the edit: it gets answered once it is saved. A card folded or
 * renamed meanwhile gets its answer and keeps its fold and name. Returns
 * whether any answer was written.
 */
export function writeBackAnswers(
    sources: Questions,
    answered: Questions,
    before: readonly string[],
): boolean {
    let wrote = false;
    answered.forEach((question, index) => {
        const source = sources[index];
        if (source?.key !== question.key) return;
        if (answerInput(source.data) !== before[index]) return;
        if (answerInput(question.data) === before[index]) return;
        const { name, collapsed } = source.data as {
            name?: string;
            collapsed?: boolean;
        };
        source.data = Object.assign(question.data, { name, collapsed });
        wrote = true;
    });
    return wrote;
}
