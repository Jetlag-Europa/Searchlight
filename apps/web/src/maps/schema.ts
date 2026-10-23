import { z } from "zod";

import { defaultUnit } from "@/lib/context";
import { normalizeQuestionName } from "@/lib/questionNames";

import { ICON_COLORS } from "./api/constants";

const unitsSchema = z.union([
    z.literal("miles"),
    z.literal("kilometers"),
    z.literal("meters"),
]);

const iconColorSchema = z.union([
    z.literal("green"),
    z.literal("black"),
    z.literal("blue"),
    z.literal("gold"),
    z.literal("grey"),
    z.literal("orange"),
    z.literal("red"),
    z.literal("violet"),
]);

type IconColor = z.infer<typeof iconColorSchema>;

const randomColor = () =>
    (Object.keys(ICON_COLORS) as IconColor[])[
        Math.floor(Math.random() * Object.keys(ICON_COLORS).length)
    ];

const randomColorExcluding = (excluded: IconColor[] = []) => {
    const options = (Object.keys(ICON_COLORS) as IconColor[]).filter(
        (color) => !excluded.includes(color),
    );

    return options[Math.floor(Math.random() * options.length)];
};

// A player's label for the question, shown on its card. A malformed one is
// dropped rather than rejecting the question.
const questionNameSchema = z
    .string()
    .transform(normalizeQuestionName)
    .optional()
    .catch(undefined);

const thermometerQuestionSchema = z
    .object({
        latA: z
            .number()
            .min(-90, "Latitude must not overlap with the poles")
            .max(90, "Latitude must not overlap with the poles"),
        lngA: z
            .number()
            .min(-180, "Longitude must not overlap with the antemeridian")
            .max(180, "Longitude must not overlap with the antemeridian"),
        latB: z
            .number()
            .min(-90, "Latitude must not overlap with the poles")
            .max(90, "Latitude must not overlap with the poles"),
        lngB: z
            .number()
            .min(-180, "Longitude must not overlap with the antemeridian")
            .max(180, "Longitude must not overlap with the antemeridian"),
        warmer: z.boolean().default(true),
        colorA: iconColorSchema.default(() => randomColorExcluding(["green"])),
        colorB: iconColorSchema.default(() => randomColorExcluding(["green"])),
        /** Note that drag is now synonymous with unlocked */
        drag: z.boolean().default(true),
        collapsed: z.boolean().default(false),
        enabled: z.boolean().default(true),
        name: questionNameSchema,
    })
    .transform((question) => {
        if (question.colorA === question.colorB) {
            question.colorB = "green";
        }

        return question;
    });

const baseQuestionSchema = z.object({
    lat: z
        .number()
        .min(-90, "Latitude must not overlap with the poles")
        .max(90, "Latitude must not overlap with the poles"),
    lng: z
        .number()
        .min(-180, "Longitude must not overlap with the antemeridian")
        .max(180, "Longitude must not overlap with the antemeridian"),
    /** Note that drag is now synonymous with unlocked */
    drag: z.boolean().default(true),
    color: iconColorSchema.default(randomColor),
    collapsed: z.boolean().default(false),
    enabled: z.boolean().default(true),
    name: questionNameSchema,
});

const getDefaultUnit = () => {
    try {
        return defaultUnit.get();
    } catch {
        return "kilometers";
    }
};

const radiusQuestionSchema = baseQuestionSchema.extend({
    radius: z.number().min(0, "You cannot have a negative radius").default(50),
    unit: unitsSchema.default(getDefaultUnit),
    within: z.boolean().default(true),
});

const baseTentacleQuestionSchema = baseQuestionSchema.extend({
    radius: z.number().min(0, "You cannot have a negative radius").default(15),
    unit: unitsSchema.default(getDefaultUnit),
    location: z
        .union([
            z.object({
                type: z.literal("Feature"),
                geometry: z.object({
                    type: z.literal("Point"),
                    coordinates: z.array(z.number()),
                }),
                id: z.union([z.string(), z.number(), z.undefined()]).optional(),
                properties: z.object({
                    name: z.any(),
                }),
            }),
            z.literal(false),
        ])
        .default(false),
});
const customTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: z.literal("custom"),
    places: z.array(
        z.object({
            type: z.literal("Feature"),
            geometry: z.object({
                type: z.literal("Point"),
                coordinates: z.array(z.number()),
            }),
            id: z.union([z.string(), z.number(), z.undefined()]).optional(),
            properties: z.object({
                name: z.any(),
            }),
        }),
    ),
});
const genericFeatureTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: z.string().startsWith("tentacle-"),
    places: z.array(z.any()).optional(),
});

export const tentacleQuestionSchema = z.union([
    customTentacleQuestionSchema,
    genericFeatureTentacleQuestionSchema,
]);

const baseMatchingQuestionSchema = baseQuestionSchema.extend({
    same: z.boolean().default(true),
});

const customMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z.union([z.literal("custom-zone"), z.literal("custom-points")]),
    geo: z.any(),
});

const genericFeatureMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z.string().startsWith("matching-"),
    featureName: z.string().optional(),
    geo: z.any().optional(),
});

export const matchingQuestionSchema = z.union([
    customMatchingQuestionSchema,
    genericFeatureMatchingQuestionSchema,
]);

const baseMeasuringQuestionSchema = baseQuestionSchema.extend({
    hiderCloser: z.boolean().default(true),
});

const customMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("custom-measure"),
    geo: z.any(),
});
const genericFeatureMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z.string().startsWith("measuring-"),
    featureName: z.string().optional(),
    geo: z.any().optional(),
});

export const measuringQuestionSchema = z.union([
    customMeasuringQuestionSchema,
    genericFeatureMeasuringQuestionSchema,
]);

// A curse (or anything else) that resizes every circular hiding zone. It
// applies to the questions below it in the list, which is the order they were
// asked in; changes multiply, so two ×1.5 curses make the zones 2.25 times
// the game's size.
const zoneSizeChangeSchema = z.object({
    multiplier: z
        .number()
        .positive("The multiplier must be greater than zero")
        .default(1.5),
    collapsed: z.boolean().default(false),
    enabled: z.boolean().default(true),
    name: questionNameSchema,
});

/**
 * A new question's key: random, with at most 15 significant digits, so any
 * JSON parser reads it back as exactly the same number (a full 17-digit
 * Math.random() value didn't always survive the API).
 */
export function newQuestionKey(): number {
    return Math.floor(Math.random() * 1e15) / 1e15;
}

export const questionSchema = z.union([
    z.object({
        id: z.literal("radius"),
        key: z.number().default(newQuestionKey),
        data: radiusQuestionSchema,
    }),
    z.object({
        id: z.literal("thermometer"),
        key: z.number().default(newQuestionKey),
        data: thermometerQuestionSchema,
    }),
    z.object({
        id: z.literal("tentacles"),
        key: z.number().default(newQuestionKey),
        data: tentacleQuestionSchema,
    }),
    z.object({
        id: z.literal("measuring"),
        key: z.number().default(newQuestionKey),
        data: measuringQuestionSchema,
    }),
    z.object({
        id: z.literal("matching"),
        key: z.number().default(newQuestionKey),
        data: matchingQuestionSchema,
    }),
    z.object({
        id: z.literal("zone-size"),
        key: z.number().default(newQuestionKey),
        data: zoneSizeChangeSchema,
    }),
]);

export const questionsSchema = z.array(questionSchema);

export type Units = z.infer<typeof unitsSchema>;
export type RadiusQuestion = z.infer<typeof radiusQuestionSchema>;
export type ThermometerQuestion = z.infer<typeof thermometerQuestionSchema>;
export type TentacleQuestion = z.infer<typeof tentacleQuestionSchema>;
export type MatchingQuestion = z.infer<typeof matchingQuestionSchema>;
export type CustomMatchingQuestion = z.infer<
    typeof customMatchingQuestionSchema
>;
export type CustomMeasuringQuestion = z.infer<
    typeof customMeasuringQuestionSchema
>;
export type MeasuringQuestion = z.infer<typeof measuringQuestionSchema>;
export type ZoneSizeChange = z.infer<typeof zoneSizeChangeSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Questions = z.infer<typeof questionsSchema>;
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
export type CustomTentacleQuestion = z.infer<
    typeof customTentacleQuestionSchema
>;
