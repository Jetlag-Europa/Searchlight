import { z } from "zod";

import { defaultUnit } from "@/lib/context";

import { ICON_COLORS } from "./api/constants";

export const NO_GROUP = "NO_GROUP";

export const determineUnionizedStrings = (
    obj: z.ZodUnion<any> | z.ZodLiteral<any> | z.ZodDefault<any>,
): z.ZodLiteral<any>[] => {
    if (obj instanceof z.ZodUnion) {
        return obj.options.flatMap((option: any) =>
            determineUnionizedStrings(option),
        );
    } else if (obj instanceof z.ZodLiteral) {
        return [obj];
    } else if (obj instanceof z.ZodDefault) {
        return determineUnionizedStrings(obj._def.innerType);
    }
    return [];
};

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
    })
    .transform((question) => {
        if (question.colorA === question.colorB) {
            question.colorB = "green";
        }

        return question;
    });

const ordinaryBaseQuestionSchema = z.object({
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
});

const getDefaultUnit = () => {
    try {
        return defaultUnit.get();
    } catch {
        return "miles";
    }
};

const radiusQuestionSchema = ordinaryBaseQuestionSchema.extend({
    radius: z.number().min(0, "You cannot have a negative radius").default(50),
    unit: unitsSchema.default(getDefaultUnit),
    within: z.boolean().default(true),
});

const tentacleLocationsFifteen = z.union([
    z.literal("theme_park").describe("Theme Parks"),
    z.literal("zoo").describe("Zoos"),
    z.literal("aquarium").describe("Aquariums"),
]);

const tentacleLocationsOne = z.union([
    z.literal("museum").describe("Museums"),
    z.literal("hospital").describe("Hospitals"),
    z.literal("cinema").describe("Movie Theaters"),
    z.literal("library").describe("Libraries"),
    z.literal("covrigarie").describe("Covrigarie (Bucharest)"),
    z.literal("train_station").describe("Railway Stations (Bucharest)"),
    z.literal("park").describe("Parks (Bucharest)"),
    z.literal("camping").describe("Campings (South Limburg)"),
    z.literal("mill").describe("Mills (South Limburg)"),
    z.literal("mountain").describe("Mountains (South Limburg)"),
    z.literal("golf_course").describe("Golf Courses (South Limburg)"),
    z.literal("bern-mountain").describe("Mountains (Bern)"),
    z.literal("bern-park").describe("Parks (Bern)"),
]);

const apiLocationSchema = z.union([
    z.literal("golf_course"),
    z.literal("consulate"),
    z.literal("park"),
    z.literal("peak"),
    tentacleLocationsFifteen,
    tentacleLocationsOne,
]);

const baseTentacleQuestionSchema = ordinaryBaseQuestionSchema.extend({
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
const tentacleQuestionSpecificSchemaFifteen = baseTentacleQuestionSchema.extend(
    {
        locationType: tentacleLocationsFifteen.default("theme_park"),
        places: z.array(z.any()).optional(),
    },
);

const tentacleQuestionSpecificSchemaOne = baseTentacleQuestionSchema.extend({
    locationType: tentacleLocationsOne,
    places: z.array(z.any()).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const encompassingTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: apiLocationSchema,
    places: z.array(z.any()).optional(),
});

const customTentacleQuestionSchema = baseTentacleQuestionSchema.extend({
    locationType: z.literal("custom").describe("Custom Locations"),
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

export const tentacleQuestionSchema = z.union([
    customTentacleQuestionSchema.describe(NO_GROUP),
    tentacleQuestionSpecificSchemaFifteen.describe("15 Miles (Typically)"),
    tentacleQuestionSpecificSchemaOne.describe("1 Mile (Typically)"),
]);

const baseMatchingQuestionSchema = ordinaryBaseQuestionSchema.extend({
    same: z.boolean().default(true),
    lengthComparison: z.enum(["shorter", "longer", "same"]).optional(),
});

const ordinaryMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z
        .union([
            z
                .literal("airport")
                .describe("Commercial Airport In Zone Question"),
            z
                .literal("major-city")
                .describe("Major City (1,000,000+ people) In Zone Question"),
            z
                .literal("aquarium-full")
                .describe("Aquarium Question (Small+Medium Games)"),
            z.literal("zoo-full").describe("Zoo Question (Small+Medium Games)"),
            z
                .literal("theme_park-full")
                .describe("Theme Park Question (Small+Medium Games)"),
            z
                .literal("peak-full")
                .describe("Mountain Question (Small+Medium Games)"),
            z
                .literal("museum-full")
                .describe("Museum Question (Small+Medium Games)"),
            z
                .literal("hospital-full")
                .describe("Hospital Question (Small+Medium Games)"),
            z
                .literal("cinema-full")
                .describe("Cinema Question (Small+Medium Games)"),
            z
                .literal("library-full")
                .describe("Library Question (Small+Medium Games)"),
            z
                .literal("golf_course-full")
                .describe("Golf Course Question (Small+Medium Games)"),
            z
                .literal("consulate-full")
                .describe("Foreign Consulate Question (Small+Medium Games)"),
            z
                .literal("park-full")
                .describe("Park Question (Small+Medium Games)"),
        ])
        .default("airport"),
});

const zoneMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("zone").describe("Zone Question"),
        z
            .literal("letter-zone")
            .describe("Zone Starts With Same Letter Question"),
    ]),
    cat: z
        .object({
            adminLevel: z.union([
                z.literal(2),
                z.literal(3),
                z.literal(4),
                z.literal(5),
                z.literal(6),
                z.literal(7),
                z.literal(8),
                z.literal(9),
                z.literal(10),
            ]),
        })
        .default(() => ({ adminLevel: 3 }) as { adminLevel: 3 }),
});

const homeGameMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("aquarium").describe("Aquarium Question"),
        z.literal("zoo").describe("Zoo Question"),
        z.literal("theme_park").describe("Theme Park Question"),
        z.literal("peak").describe("Mountain Question"),
        z.literal("museum").describe("Museum Question"),
        z.literal("hospital").describe("Hospital Question"),
        z.literal("cinema").describe("Cinema Question"),
        z.literal("library").describe("Library Question"),
        z.literal("golf_course").describe("Golf Course Question"),
        z.literal("consulate").describe("Foreign Consulate Question"),
        z.literal("park").describe("Park Question"),
    ]),
});

const hidingZoneMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z
            .literal("same-first-letter-station")
            .describe("Station Starts With Same Letter Question"),
        z
            .literal("same-length-station")
            .describe("Station Has Same Length Question"),
        z
            .literal("same-train-line")
            .describe("Station On Same Train Line Question"),
    ]),
});

const customMatchingQuestionSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("custom-zone").describe("Custom Zone Question"),
        z.literal("custom-points").describe("Custom Points Question"),
    ]),
    geo: z.any(),
});

const luxAdminMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("lux-canton").describe("Same Canton (Luxembourg)"),
        z.literal("lux-district").describe("Same District (Luxembourg)"),
    ]),
});

const luxPointMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("lux-mountains").describe("Lux Mountains"),
        z.literal("lux-hospitals").describe("Lux Hospitals"),
    ]),
});

const southLimburgMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("south-limburg-postcode").describe("1st Admin Division (South Limburg)"),
        z.literal("south-limburg-municipality").describe("2nd Admin Division (South Limburg)"),
        z.literal("sl-camping").describe("Nearest Camping (South Limburg)"),
        z.literal("sl-mill").describe("Nearest Mill (South Limburg)"),
        z.literal("sl-mountain").describe("Nearest Mountain (South Limburg)"),
        z.literal("sl-library").describe("Nearest Library (South Limburg)"),
        z.literal("sl-museum").describe("Nearest Museum (South Limburg)"),
        z.literal("sl-golf_course").describe("Nearest Golf Course (South Limburg)"),
        z.literal("sl-cinema").describe("Nearest Cinema (South Limburg)"),
        z.literal("sl-zoo").describe("Nearest Zoo (South Limburg)"),
        z.literal("sl-theme_park").describe("Nearest Amusement Park (South Limburg)"),
        z.literal("sl-hospital").describe("Nearest Hospital (South Limburg)"),
        z.literal("sl-airport").describe("Nearest Airport (South Limburg)"),
        z.literal("sl-consulate").describe("Nearest Foreign Consulate (South Limburg)"),
    ]),
});

const brnoMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("brno-district").describe("Same District (Brno)"),
    ]),
});

const bernMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("bern-canton").describe("Same Swiss Canton"),
        z.literal("bern-bezirk").describe("Same Bezirk"),
        z.literal("bern-cinema").describe("Nearest Cinema (Bern)"),
        z.literal("bern-library").describe("Nearest Library (Bern)"),
        z.literal("bern-museum").describe("Nearest Museum (Bern)"),
        z.literal("bern-mountain").describe("Nearest Mountain (Bern)"),
        z.literal("bern-park").describe("Nearest Park (Bern)"),
        z.literal("bern-zoo").describe("Nearest Zoo (Bern)"),
        z.literal("bern-hospital").describe("Nearest Hospital (Bern)"),
        z.literal("bern-consulate").describe("Nearest Foreign Consulate (Bern)"),
        z.literal("bern-theme_park").describe("Nearest Amusement Park (Bern)"),
        z.literal("bern-airport").describe("Nearest Airport (Bern)"),
    ]),
});

const bucharestMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("bucharest-sector").describe("1st Admin Division (Bucharest)"),
        z.literal("covrigarie").describe("Nearest Covrigarie (Bucharest)"),
        z.literal("buch-museum").describe("Nearest Museum (Bucharest)"),
        z.literal("buch-park").describe("Nearest Park (Bucharest)"),
        z.literal("buch-library").describe("Nearest Library (Bucharest)"),
        z.literal("buch-hospital").describe("Nearest Hospital (Bucharest)"),
        z.literal("buch-cinema").describe("Nearest Cinema (Bucharest)"),
        z.literal("buch-train_station").describe("Nearest Railway Station (Bucharest)"),
        z.literal("buch-zoo").describe("Nearest Zoo (Bucharest)"),
        z.literal("buch-golf_course").describe("Nearest Golf Course (Bucharest)"),
        z.literal("buch-airport").describe("Nearest Airport (Bucharest)"),
        z.literal("buch-consulate").describe("Nearest Foreign Consulate (Bucharest)"),
    ]),
});

const exterRotterdamMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("rotterdam-municipality").describe("Same Municipality (Rotterdam)"),
        z.literal("rotterdam-library").describe("Nearest Library (Rotterdam)"),
        z.literal("rotterdam-museum").describe("Nearest Museum (Rotterdam)"),
        z.literal("rotterdam-hospital").describe("Nearest Hospital (Rotterdam)"),
        z.literal("rotterdam-zoo").describe("Nearest Zoo (Rotterdam)"),
        z.literal("rotterdam-cinema").describe("Nearest Cinema (Rotterdam)"),
        z.literal("rotterdam-golf_course").describe("Nearest Golf Course (Rotterdam)"),
        z.literal("rotterdam-consulate").describe("Nearest Foreign Consulate (Rotterdam)"),
        z.literal("rotterdam-theme_park").describe("Nearest Amusement Park (Rotterdam)"),
        z.literal("rotterdam-airport").describe("Nearest Airport (Rotterdam)"),
    ]),
});

export const matchingQuestionSchema = z.union([
    zoneMatchingQuestionsSchema.describe(NO_GROUP),
    ordinaryMatchingQuestionSchema.describe(NO_GROUP),
    luxAdminMatchingQuestionsSchema.describe(NO_GROUP),
    luxPointMatchingQuestionsSchema.describe(NO_GROUP),
    southLimburgMatchingQuestionsSchema.describe(NO_GROUP),
    brnoMatchingQuestionsSchema.describe(NO_GROUP),
    bucharestMatchingQuestionsSchema.describe(NO_GROUP),
    bernMatchingQuestionsSchema.describe(NO_GROUP),
    exterRotterdamMatchingQuestionsSchema.describe(NO_GROUP),
    customMatchingQuestionSchema.describe(NO_GROUP),
    hidingZoneMatchingQuestionsSchema.describe("Hiding Zone Mode"),
    homeGameMatchingQuestionsSchema.describe("Hiding Zone Mode"),
]);

// Maps a question type value to the game sentinel it requires.
// Types listed here are hidden in the selector unless that game is active.
// Add new game-specific types here as they are introduced.
export const GAME_GATED_TYPES: Record<string, string> = {
    "lux-canton":                "__bundled-luxembourg-2026__",
    "lux-district":              "__bundled-luxembourg-2026__",
    "lux-mountains":             "__bundled-luxembourg-2026__",
    "lux-hospitals":             "__bundled-luxembourg-2026__",
    "south-limburg-postcode":    "__bundled-south-limburg-2026__",
    "south-limburg-municipality":"__bundled-south-limburg-2026__",
    "sl-camping":                "__bundled-south-limburg-2026__",
    "sl-mill":                   "__bundled-south-limburg-2026__",
    "sl-mountain":               "__bundled-south-limburg-2026__",
    "sl-library":                "__bundled-south-limburg-2026__",
    "sl-museum":                 "__bundled-south-limburg-2026__",
    "sl-golf_course":            "__bundled-south-limburg-2026__",
    "sl-cinema":                 "__bundled-south-limburg-2026__",
    "sl-zoo":                    "__bundled-south-limburg-2026__",
    "sl-theme_park":             "__bundled-south-limburg-2026__",
    "sl-hospital":               "__bundled-south-limburg-2026__",
    "sl-airport":                "__bundled-south-limburg-2026__",
    "sl-consulate":              "__bundled-south-limburg-2026__",
    "camping":                   "__bundled-south-limburg-2026__",
    "mill":                      "__bundled-south-limburg-2026__",
    "mountain":                  "__bundled-south-limburg-2026__",
    "golf_course":               "__bundled-south-limburg-2026__",
    "brno-district":             "__bundled-brno-2026-v2__",
    "brno-water":                "__bundled-brno-2026-v2__",
    "bucharest-sector":          "__bundled-bucharest-2026__",
    "covrigarie":                "__bundled-bucharest-2026__",
    "buch-museum":               "__bundled-bucharest-2026__",
    "buch-park":                 "__bundled-bucharest-2026__",
    "buch-library":              "__bundled-bucharest-2026__",
    "buch-hospital":             "__bundled-bucharest-2026__",
    "buch-cinema":               "__bundled-bucharest-2026__",
    "buch-train_station":        "__bundled-bucharest-2026__",
    "buch-zoo":                  "__bundled-bucharest-2026__",
    "buch-golf_course":          "__bundled-bucharest-2026__",
    "buch-airport":              "__bundled-bucharest-2026__",
    "buch-consulate":            "__bundled-bucharest-2026__",
    "train_station":             "__bundled-bucharest-2026__",
    "park":                      "__bundled-bucharest-2026__",
    "bern-canton":               "__bundled-bern-2026__",
    "bern-bezirk":               "__bundled-bern-2026__",
    "bern-cinema":               "__bundled-bern-2026__",
    "bern-library":              "__bundled-bern-2026__",
    "bern-museum":               "__bundled-bern-2026__",
    "bern-mountain":             "__bundled-bern-2026__",
    "bern-park":                 "__bundled-bern-2026__",
    "bern-zoo":                  "__bundled-bern-2026__",
    "bern-hospital":             "__bundled-bern-2026__",
    "bern-consulate":            "__bundled-bern-2026__",
    "bern-theme_park":           "__bundled-bern-2026__",
    "bern-airport":              "__bundled-bern-2026__",
    "rotterdam-municipality":    "__bundled-exter-rotterdam-2026__",
    "rotterdam-rail":            "__bundled-exter-rotterdam-2026__",
    "rotterdam-coastline":       "__bundled-exter-rotterdam-2026__",
    "rotterdam-library":         "__bundled-exter-rotterdam-2026__",
    "rotterdam-museum":          "__bundled-exter-rotterdam-2026__",
    "rotterdam-hospital":        "__bundled-exter-rotterdam-2026__",
    "rotterdam-zoo":             "__bundled-exter-rotterdam-2026__",
    "rotterdam-cinema":          "__bundled-exter-rotterdam-2026__",
    "rotterdam-golf_course":     "__bundled-exter-rotterdam-2026__",
    "rotterdam-consulate":       "__bundled-exter-rotterdam-2026__",
    "rotterdam-theme_park":      "__bundled-exter-rotterdam-2026__",
    "rotterdam-airport":         "__bundled-exter-rotterdam-2026__",
};

const baseMeasuringQuestionSchema = ordinaryBaseQuestionSchema.extend({
    hiderCloser: z.boolean().default(true),
});

const ordinaryMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z
        .union([
            z.literal("coastline").describe("Coastline Question"),
            z
                .literal("airport")
                .describe("Commercial Airport In Zone Question"),
            z
                .literal("city")
                .describe("Major City (1,000,000+ people) Question"),
            z
                .literal("highspeed-measure-shinkansen")
                .describe("High-Speed Rail Question"),
            z
                .literal("international-border")
                .describe("International [broken]"),
            z
                .literal("aquarium-full")
                .describe("Aquarium Question (Small+Medium Games)"),
            z.literal("zoo-full").describe("Zoo Question (Small+Medium Games)"),
            z
                .literal("theme_park-full")
                .describe("Theme Park Question (Small+Medium Games)"),
            z
                .literal("peak-full")
                .describe("Mountain Question (Small+Medium Games)"),
            z
                .literal("museum-full")
                .describe("Museum Question (Small+Medium Games)"),
            z
                .literal("hospital-full")
                .describe("Hospital Question (Small+Medium Games)"),
            z
                .literal("cinema-full")
                .describe("Cinema Question (Small+Medium Games)"),
            z
                .literal("library-full")
                .describe("Library Question (Small+Medium Games)"),
            z
                .literal("golf_course-full")
                .describe("Golf Course Question (Small+Medium Games)"),
            z
                .literal("consulate-full")
                .describe("Foreign Consulate Question (Small+Medium Games)"),
            z
                .literal("park-full")
                .describe("Park Question (Small+Medium Games)"),
        ])
        .default("coastline"),
});

const hidingZoneMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("mcdonalds").describe("McDonald's Question"),
        z.literal("seven11").describe("7-Eleven Question"),
        z.literal("rail-measure").describe("Train Station Question"),
    ]),
});

const homeGameMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("aquarium").describe("Aquarium Question"),
        z.literal("zoo").describe("Zoo Question"),
        z.literal("theme_park").describe("Theme Park Question"),
        z.literal("peak").describe("Mountain Question"),
        z.literal("museum").describe("Museum Question"),
        z.literal("hospital").describe("Hospital Question"),
        z.literal("cinema").describe("Cinema Question"),
        z.literal("library").describe("Library Question"),
        z.literal("golf_course").describe("Golf Course Question"),
        z.literal("consulate").describe("Foreign Consulate Question"),
        z.literal("park").describe("Park Question"),
    ]),
});

const customMeasuringQuestionSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("custom-measure").describe("Custom Measuring Question"),
    geo: z.any(),
});

const southLimburgMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("sl-camping").describe("Nearest Camping (South Limburg)"),
        z.literal("sl-mill").describe("Nearest Mill (South Limburg)"),
        z.literal("sl-mountain").describe("Nearest Mountain (South Limburg)"),
        z.literal("sl-library").describe("Nearest Library (South Limburg)"),
        z.literal("sl-museum").describe("Nearest Museum (South Limburg)"),
        z.literal("sl-golf_course").describe("Nearest Golf Course (South Limburg)"),
        z.literal("sl-cinema").describe("Nearest Cinema (South Limburg)"),
        z.literal("sl-zoo").describe("Nearest Zoo (South Limburg)"),
        z.literal("sl-theme_park").describe("Nearest Amusement Park (South Limburg)"),
        z.literal("sl-hospital").describe("Nearest Hospital (South Limburg)"),
        z.literal("sl-airport").describe("Nearest Airport (South Limburg)"),
        z.literal("sl-consulate").describe("Nearest Foreign Consulate (South Limburg)"),
    ]),
});

const brnoMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("brno-water").describe("Body of Water (Brno)"),
});

const bernMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("bern-canton").describe("Canton Border Question (Bern)"),
        z.literal("bern-cinema").describe("Nearest Cinema (Bern)"),
        z.literal("bern-library").describe("Nearest Library (Bern)"),
        z.literal("bern-museum").describe("Nearest Museum (Bern)"),
        z.literal("bern-mountain").describe("Nearest Mountain (Bern)"),
        z.literal("bern-park").describe("Nearest Park (Bern)"),
        z.literal("bern-zoo").describe("Nearest Zoo (Bern)"),
        z.literal("bern-hospital").describe("Nearest Hospital (Bern)"),
        z.literal("bern-consulate").describe("Nearest Foreign Consulate (Bern)"),
        z.literal("bern-theme_park").describe("Nearest Amusement Park (Bern)"),
        z.literal("bern-airport").describe("Nearest Airport (Bern)"),
    ]),
});

const bucharestMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("covrigarie").describe("Nearest Covrigarie (Bucharest)"),
        z.literal("buch-museum").describe("Nearest Museum (Bucharest)"),
        z.literal("buch-park").describe("Nearest Park (Bucharest)"),
        z.literal("buch-library").describe("Nearest Library (Bucharest)"),
        z.literal("buch-hospital").describe("Nearest Hospital (Bucharest)"),
        z.literal("buch-cinema").describe("Nearest Cinema (Bucharest)"),
        z.literal("buch-train_station").describe("Nearest Railway Station (Bucharest)"),
        z.literal("buch-zoo").describe("Nearest Zoo (Bucharest)"),
        z.literal("buch-golf_course").describe("Nearest Golf Course (Bucharest)"),
        z.literal("buch-airport").describe("Nearest Airport (Bucharest)"),
        z.literal("buch-consulate").describe("Nearest Foreign Consulate (Bucharest)"),
    ]),
});

const exterRotterdamMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("rotterdam-rail").describe("Distance to High-Speed Rail (Rotterdam)"),
        z.literal("rotterdam-coastline").describe("Distance to Coast (Rotterdam)"),
        z.literal("rotterdam-library").describe("Nearest Library (Rotterdam)"),
        z.literal("rotterdam-museum").describe("Nearest Museum (Rotterdam)"),
        z.literal("rotterdam-hospital").describe("Nearest Hospital (Rotterdam)"),
        z.literal("rotterdam-zoo").describe("Nearest Zoo (Rotterdam)"),
        z.literal("rotterdam-cinema").describe("Nearest Cinema (Rotterdam)"),
        z.literal("rotterdam-golf_course").describe("Nearest Golf Course (Rotterdam)"),
        z.literal("rotterdam-consulate").describe("Nearest Foreign Consulate (Rotterdam)"),
        z.literal("rotterdam-theme_park").describe("Nearest Amusement Park (Rotterdam)"),
        z.literal("rotterdam-airport").describe("Nearest Airport (Rotterdam)"),
    ]),
});

export const measuringQuestionSchema = z.union([
    ordinaryMeasuringQuestionSchema.describe(NO_GROUP),
    southLimburgMeasuringQuestionsSchema.describe(NO_GROUP),
    brnoMeasuringQuestionsSchema.describe(NO_GROUP),
    bucharestMeasuringQuestionsSchema.describe(NO_GROUP),
    bernMeasuringQuestionsSchema.describe(NO_GROUP),
    exterRotterdamMeasuringQuestionsSchema.describe(NO_GROUP),
    customMeasuringQuestionSchema.describe(NO_GROUP),
    hidingZoneMeasuringQuestionsSchema.describe("Hiding Zone Mode"),
    homeGameMeasuringQuestionsSchema.describe("Hiding Zone Mode"),
]);

export const questionSchema = z.union([
    z.object({
        id: z.literal("radius"),
        key: z.number().default(Math.random),
        data: radiusQuestionSchema,
    }),
    z.object({
        id: z.literal("thermometer"),
        key: z.number().default(Math.random),
        data: thermometerQuestionSchema,
    }),
    z.object({
        id: z.literal("tentacles"),
        key: z.number().default(Math.random),
        data: tentacleQuestionSchema,
    }),
    z.object({
        id: z.literal("measuring"),
        key: z.number().default(Math.random),
        data: measuringQuestionSchema,
    }),
    z.object({
        id: z.literal("matching"),
        key: z.number().default(Math.random),
        data: matchingQuestionSchema,
    }),
]);

export const questionsSchema = z.array(questionSchema);

export type Units = z.infer<typeof unitsSchema>;
export type RadiusQuestion = z.infer<typeof radiusQuestionSchema>;
export type ThermometerQuestion = z.infer<typeof thermometerQuestionSchema>;
export type TentacleQuestion = z.infer<typeof tentacleQuestionSchema>;
export type APILocations = z.infer<typeof apiLocationSchema>;
export type MatchingQuestion = z.infer<typeof matchingQuestionSchema>;
export type HomeGameMatchingQuestions = z.infer<
    typeof homeGameMatchingQuestionsSchema
>;
export type ZoneMatchingQuestions = z.infer<typeof zoneMatchingQuestionsSchema>;
export type CustomMatchingQuestion = z.infer<
    typeof customMatchingQuestionSchema
>;
export type CustomMeasuringQuestion = z.infer<
    typeof customMeasuringQuestionSchema
>;
export type MeasuringQuestion = z.infer<typeof measuringQuestionSchema>;
export type HomeGameMeasuringQuestions = z.infer<
    typeof homeGameMeasuringQuestionsSchema
>;
export type Question = z.infer<typeof questionSchema>;
export type Questions = z.infer<typeof questionsSchema>;
export type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
export type TraditionalTentacleQuestion =
    | z.infer<typeof tentacleQuestionSpecificSchemaFifteen>
    | z.infer<typeof tentacleQuestionSpecificSchemaOne>;
export type EncompassingTentacleQuestionSchema = z.infer<
    typeof encompassingTentacleQuestionSchema
>;
export type CustomTentacleQuestion = z.infer<
    typeof customTentacleQuestionSchema
>;
