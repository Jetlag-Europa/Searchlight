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

/**
 * Each answer a two-answer question can get, as its card names them, in the
 * order its card's toggle shows them.
 */
export const SPLIT_ANSWERS: Partial<
    Record<Question["id"], { label: string; data: Record<string, boolean> }[]>
> = {
    radius: [
        { label: "Outside", data: { within: false } },
        { label: "Inside", data: { within: true } },
    ],
    thermometer: [
        { label: "Colder", data: { warmer: false } },
        { label: "Warmer", data: { warmer: true } },
    ],
    matching: [
        { label: "Different", data: { same: false } },
        { label: "Same", data: { same: true } },
    ],
    measuring: [
        { label: "Further", data: { hiderCloser: false } },
        { label: "Closer", data: { hiderCloser: true } },
    ],
};

export interface AnswerSplit {
    label: string;
    zones: number;
}

/**
 * A question's data as far as its split depends on it: not its answer, which
 * the split tries both ways, nor its name, colours or collapsed state.
 */
export function splitInputs(question: Question): object {
    const answerFields = (SPLIT_ANSWERS[question.id] ?? []).flatMap(
        ({ data }) => Object.keys(data),
    );
    return {
        ...question.data,
        ...Object.fromEntries(answerFields.map((field) => [field, undefined])),
        name: undefined,
        collapsed: undefined,
        color: undefined,
        colorA: undefined,
        colorB: undefined,
    };
}

/**
 * How many hiding zones would survive each answer to `question`, out of
 * those the `answered` questions leave (planning mode leaves unlocked
 * questions out of them) and the player hasn't disabled. The question tests
 * the zones at the size they have where it sits in the list. A zone on the
 * line overlaps both answers' regions, so it counts for both. Undefined for a
 * question without two answers, or once `isCurrent` turns false.
 */
export async function answerSplit(
    question: Question,
    questions: Questions,
    compiled: Pick<CompiledGame, "definition" | "hidingZones">,
    answered: readonly AnsweredRegion[],
    disabledZones: readonly string[],
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
    // The map hides the zones the player disabled.
    const zones = surviving
        .map((index) => circles[index])
        .filter(
            (zone) => !disabledZones.includes(zone.properties.properties.id),
        );

    const split: AnswerSplit[] = [];
    for (const answer of answers) {
        // Without its key, its requests don't supersede the map's for the
        // question, or each other. It may still share, through the geometry
        // caches, a request of the map's that a newer one supersedes.
        const region = await standaloneRegion(
            { id: question.id, data: { ...data, ...answer.data } },
            baseMapGeoData,
        );
        if (!isCurrent()) return undefined;
        const kept = await filterZones(zones, [region]);
        if (!isCurrent()) return undefined;
        split.push({ label: answer.label, zones: kept.length });
    }
    return split;
}
