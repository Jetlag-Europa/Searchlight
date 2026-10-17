import type { CompiledGame } from "@/game-definition/compile";
import { zoneScaleAfter } from "@/lib/zoneSize";

import { standaloneRegion } from ".";
import {
    type AnsweredRegion,
    type FilterZones,
    hidingZoneCircles,
    survivingZoneIndexes,
} from "./geo-utils/hidingZones";
import type { Question, Questions } from "./schema";

/** Each answer a two-answer question can get, as its card names them. */
export const SPLIT_ANSWERS: Partial<
    Record<Question["id"], { label: string; data: Record<string, boolean> }[]>
> = {
    radius: [
        { label: "Inside", data: { within: true } },
        { label: "Outside", data: { within: false } },
    ],
    thermometer: [
        { label: "Warmer", data: { warmer: true } },
        { label: "Colder", data: { warmer: false } },
    ],
    matching: [
        { label: "Same", data: { same: true } },
        { label: "Different", data: { same: false } },
    ],
    measuring: [
        { label: "Closer", data: { hiderCloser: true } },
        { label: "Further", data: { hiderCloser: false } },
    ],
};

export interface AnswerSplit {
    label: string;
    zones: number;
}

/**
 * How many hiding zones would survive each answer to `question`, out of
 * those the `answered` questions leave (planning mode leaves unlocked
 * questions out of them). The question tests the zones at the size they have
 * where it sits in the list. A zone on the line overlaps both answers'
 * regions, so it counts for both. Undefined for a question without two
 * answers, or once `isCurrent` turns false.
 */
export async function answerSplit(
    question: Question,
    questions: Questions,
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
    answered: readonly AnsweredRegion[],
    baseMapGeoData: unknown,
    filterZones: FilterZones,
    isCurrent: () => boolean = () => true,
): Promise<AnswerSplit[] | undefined> {
    const answers = SPLIT_ANSWERS[question.id];
    if (!answers) return undefined;
    // Cards edit their data in place: work from a copy taken now.
    const data = structuredClone(question.data);

    const surviving = await survivingZoneIndexes(
        compiled,
        answered,
        filterZones,
        isCurrent,
    );
    if (!surviving) return undefined;
    const position = questions.findIndex(({ key }) => key === question.key);
    const circles = hidingZoneCircles(
        compiled,
        zoneScaleAfter(questions, position < 0 ? undefined : position),
    );

    const split: AnswerSplit[] = [];
    for (const answer of answers) {
        // Without its key, this neither supersedes nor is superseded by the
        // map's own geometry requests for the question.
        const region = await standaloneRegion(
            { id: question.id, data: { ...data, ...answer.data } },
            baseMapGeoData,
        );
        if (!isCurrent()) return undefined;
        const kept = await filterZones(
            surviving.map((index) => circles[index]),
            [region],
        );
        if (!isCurrent()) return undefined;
        split.push({ label: answer.label, zones: kept.length });
    }
    return split;
}
