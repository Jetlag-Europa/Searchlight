import * as turf from "@turf/turf";

import { PLAYER_CUSTOM_TYPES } from "@/game-definition/store";
import type { Question, Questions, Units } from "@/maps/schema";

// Each question can usually be asked once per game. Home rules vary, so the
// pickers only point out what was asked; they never block it.

// A radar is identified by its size, in whole meters: 500 m and 2 km are
// different questions, 2 km and 2000 m the same one.
export const radarVariant = (radius: number, unit: Units) =>
    String(Math.round(turf.convertLength(radius, unit, "meters")));

// What a question asks within its family: its layer (for matching, measuring
// and tentacles) or its radar size. Thermometers and zone size changes have
// no variants.
const askedVariant = (question: Question): string | undefined => {
    switch (question.id) {
        case "matching":
        case "measuring":
        case "tentacles": {
            const [family, variant] =
                question.id === "tentacles"
                    ? ["tentacle", question.data.locationType]
                    : [question.id, question.data.type];
            // Drawing a player-drawn question doesn't use anything up.
            return PLAYER_CUSTOM_TYPES[family].includes(variant)
                ? undefined
                : variant;
        }
        case "radius":
            return radarVariant(question.data.radius, question.data.unit);
        default:
            return undefined;
    }
};

/**
 * The variants of `family` already asked, by every question but `exceptKey`
 * (the card asking). Disabled questions were still asked.
 */
export const askedVariants = (
    questions: Questions,
    family: Question["id"],
    exceptKey?: number,
): Set<string> => {
    const asked = new Set<string>();
    for (const question of questions) {
        if (question.id !== family || question.key === exceptKey) continue;
        const variant = askedVariant(question);
        if (variant !== undefined) asked.add(variant);
    }
    return asked;
};

/** A "✓ asked" note on each variant another question asks, for a picker. */
export const askedHints = (
    questions: Questions,
    family: Question["id"],
    exceptKey: number,
): Record<string, string> =>
    Object.fromEntries(
        [...askedVariants(questions, family, exceptKey)].map((variant) => [
            variant,
            "✓ asked",
        ]),
    );

/** The first candidate not asked yet, or the first one if all were. */
export const firstUnasked = <T>(
    candidates: T[],
    asked: Set<string>,
    variant: (candidate: T) => string,
): T | undefined =>
    candidates.find((candidate) => !asked.has(variant(candidate))) ??
    candidates[0];
