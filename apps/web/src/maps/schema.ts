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
        enabled: z.boolean().default(true),
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
    z.literal("christian_religion").describe("Christian Religion Places (South Limburg)"),
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
        z.literal("south-limburg-postcode").describe("Postcode (South Limburg)"),
        z.literal("south-limburg-municipality").describe("Municipality (South Limburg)"),
        z.literal("sl-camping").describe("Nearest Camping (South Limburg)"),
        z.literal("sl-mill").describe("Nearest Mill (South Limburg)"),
        // Mountain uses the generic "Mountain" question, which auto-uses the
        // game's custom mountain POIs — no game-prefixed duplicate needed.
    ]),
});

const brnoMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.literal("brno-district").describe("Same District (Brno)"),
});

const bernMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("bern-canton").describe("Same Swiss Canton"),
        z.literal("bern-bezirk").describe("Same Bezirk"),
        z.literal("bern-mountain").describe("Nearest Mountain (Bern)"),
    ]),
});

const bucharestMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("bucharest-sector").describe("1st Admin Division (Bucharest)"),
        z.literal("covrigarie").describe("Nearest Covrigarie (Bucharest)"),
        z.literal("buch-train_station").describe("Nearest Railway Station (Bucharest)"),
    ]),
});

const exterRotterdamMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("rotterdam-municipality").describe("Same Municipality (Rotterdam)"),
        z.literal("rotterdam-ns").describe("Nearest NS Station (Rotterdam)"),
    ]),
});

const zurichMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.literal("zurich-bezirk").describe("Same Bezirk (Zürich)"),
});

const budapestMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("budapest-district").describe("Same District (Budapest)"),
        z.literal("budapest-castle").describe("Nearest Castle (Budapest)"),
        z.literal("budapest-stadium").describe("Nearest Stadium (Budapest)"),
        z.literal("budapest-rail").describe("Nearest Railway Station (Budapest)"),
    ]),
});

const belgiumMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("belgium-province").describe("Same Province (Belgium)"),
        z.literal("belgium-arrondissement").describe("Same Arrondissement (Belgium)"),
        z.literal("belgium-castle").describe("Nearest Castle/Fort (Belgium)"),
    ]),
});

const londonMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("london-borough").describe("Same Borough (London)"),
        z.literal("london-stadium").describe("Nearest Stadium (London)"),
        z.literal("london-rail").describe("Nearest Rail Terminus (London)"),
    ]),
});

const grazMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.literal("graz-district").describe("Same District (Graz)"),
});

const parisMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.literal("paris-arrondissement").describe("Same Arrondissement (Paris)"),
});

const stockholmMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("stockholm-admin1").describe("Same 1st Admin Division (Stockholm)"),
        z.literal("stockholm-admin2").describe("Same 2nd Admin Division (Stockholm)"),
        z.literal("stockholm-admin3").describe("Same 3rd Admin Division (Stockholm)"),
        z.literal("stockholm-ikea").describe("Nearest IKEA (Stockholm)"),
    ]),
});

const brightonMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("brighton-ward").describe("Same Ward (Brighton)"),
        z.literal("brighton-postcode").describe("Same Postcode (Brighton)"),
        z.literal("brighton-rail").describe("Nearest Railway Station (Brighton)"),
    ]),
});

const milanMatchingQuestionsSchema = baseMatchingQuestionSchema.extend({
    type: z.union([
        z.literal("milan-municipio").describe("Same Municipio (Milan)"),
        z.literal("milan-castle").describe("Nearest Castle/Fort (Milan)"),
        z.literal("milan-train").describe("Nearest Train Station (Milan)"),
        z.literal("milan-water").describe("Nearest Body of Water (Milan)"),
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
    zurichMatchingQuestionsSchema.describe(NO_GROUP),
    budapestMatchingQuestionsSchema.describe(NO_GROUP),
    belgiumMatchingQuestionsSchema.describe(NO_GROUP),
    londonMatchingQuestionsSchema.describe(NO_GROUP),
    grazMatchingQuestionsSchema.describe(NO_GROUP),
    parisMatchingQuestionsSchema.describe(NO_GROUP),
    stockholmMatchingQuestionsSchema.describe(NO_GROUP),
    milanMatchingQuestionsSchema.describe(NO_GROUP),
    brightonMatchingQuestionsSchema.describe(NO_GROUP),
    customMatchingQuestionSchema.describe(NO_GROUP),
    hidingZoneMatchingQuestionsSchema.describe("Hiding Zone Mode"),
    homeGameMatchingQuestionsSchema.describe("Hiding Zone Mode"),
]);

// Maps a question type value to the game sentinel(s) it requires.
// Types listed here are hidden in the selector unless one of those games is
// active. Add new game-specific types here as they are introduced.
//
// An array is for a type shared by more than one game — the two London games
// run off the same POI and borough assets, so they offer the same custom
// questions. Prefer `gateAllows()` over reading this map directly.
const LONDON_GAMES = [
    "__bundled-london-2026__",
    "__bundled-accessible-london-2026__",
];

const ROTTERDAM_SENTINELS = [
    "__bundled-exter-rotterdam-2026__",
    "__bundled-rotterdam-2026-09__",
];

export const GAME_GATED_TYPES: Record<string, string | string[]> = {
    // Luxembourg
    "lux-canton":                "__bundled-luxembourg-2026__",
    "lux-district":              "__bundled-luxembourg-2026__",
    "lux-mountains":             "__bundled-luxembourg-2026__",
    "lux-hospitals":             "__bundled-luxembourg-2026__",
    // South Limburg — admin + POI categories with no generic equivalent.
    // international-border-og is gated here too: it is the only game with a
    // bundled border file (BUNDLED_BORDER_FILES in questions/measuring.ts).
    // Everywhere else it silently fell through to a live Overpass query that
    // was never verified, so it is scoped to the game it was built and tested
    // for. A future game opts in by adding a BUNDLED_BORDER_FILES entry —
    // and widening or removing this gate.
    "international-border-og":   "__bundled-south-limburg-2026__",
    "south-limburg-postcode":    "__bundled-south-limburg-2026__",
    "south-limburg-municipality":"__bundled-south-limburg-2026__",
    "sl-camping":                "__bundled-south-limburg-2026__",
    "sl-mill":                   "__bundled-south-limburg-2026__",
    // Tentacle-only types unique to South Limburg
    "camping":                   "__bundled-south-limburg-2026__",
    "mill":                      "__bundled-south-limburg-2026__",
    "mountain":                  "__bundled-south-limburg-2026__",
    "golf_course":               "__bundled-south-limburg-2026__",
    "christian_religion":        "__bundled-south-limburg-2026__",
    // Brno
    "brno-district":             "__bundled-brno-2026-v2__",
    "brno-water":                "__bundled-brno-2026-v2__",
    // Bucharest — admin + types with no generic equivalent
    "bucharest-sector":          "__bundled-bucharest-2026__",
    "covrigarie":                "__bundled-bucharest-2026__",
    "buch-train_station":        "__bundled-bucharest-2026__",
    // Tentacle-only types unique to Bucharest
    "train_station":             "__bundled-bucharest-2026__",
    "park":                      "__bundled-bucharest-2026__",
    // Bern — admin + types with no generic equivalent
    "bern-canton":               "__bundled-bern-2026__",
    "bern-bezirk":               "__bundled-bern-2026__",
    "bern-mountain":             "__bundled-bern-2026__",
    // Tentacle-only types unique to Bern
    "bern-park":                 "__bundled-bern-2026__",
    // Rotterdam — admin + geometry types with no generic equivalent. Shared by
    // both Rotterdam games: "Rotterdam 12-09" is "Exter Rotterdam 26" plus the
    // NS-station question, and reuses every one of its bundled asset files.
    "rotterdam-municipality":    ROTTERDAM_SENTINELS,
    "rotterdam-rail":            ROTTERDAM_SENTINELS,
    "rotterdam-coastline":       ROTTERDAM_SENTINELS,
    // NS heavy-rail stations — Rotterdam 12-09 only; the older game bundles no
    // rail_station POIs, so the question would resolve to nothing there.
    "rotterdam-ns":              "__bundled-rotterdam-2026-09__",
    // Municipality-border measuring — Rotterdam 12-09 only, Jules' call: Exter
    // Rotterdam 26's question list stays exactly as it shipped. It needs its
    // OWN literal rather than reusing "rotterdam-municipality" because
    // gateAllows() is keyed by type alone and is not family-aware — gating the
    // shared literal to one sentinel would take the MATCHING question away from
    // the older game too. It measures against EVERY municipality border (the
    // london-borough reading), not the border of the one the seeker is standing
    // in the way paris-arrondissement / belgium-province do; this play area is
    // small enough that all-borders still discriminates.
    "rotterdam-municipality-border": "__bundled-rotterdam-2026-09__",
    // Zürich — Bezirk match + canton/lake-coast measuring
    "zurich-bezirk":             "__bundled-zurich-2026__",
    "zurich-canton":             "__bundled-zurich-2026__",
    "zurich-coastline":          "__bundled-zurich-2026__",
    // Budapest — district (admin_level 9 via LocalOverpass), bodies of water,
    // and castle/stadium/rail (custom POI categories, matching + measuring)
    "budapest-district":         "__bundled-budapest-2025__",
    "budapest-water":            "__bundled-budapest-2025__",
    "budapest-castle":           "__bundled-budapest-2025__",
    "budapest-stadium":          "__bundled-budapest-2025__",
    "budapest-rail":             "__bundled-budapest-2025__",
    // Tentacle/POI categories unique to Budapest
    "castle":                    "__bundled-budapest-2025__",
    "stadium":                   "__bundled-budapest-2025__",
    // Belgium — bundled admin polygons. Region is measuring-only, province is
    // matching + measuring (both measure the border of the division you're IN,
    // zurich-canton style), arrondissement is matching-only. There is
    // deliberately no arrondissement border-distance (with 43 divisions the band
    // covers ~96% of Belgium and eliminates almost nothing) and no "same region"
    // match (3 divisions is too coarse to be worth asking). Plus castle/fort
    // (custom POI, matching + measuring) and high-speed rail + coastline
    // (bundled lines).
    "belgium-region":            "__bundled-belgium-2026__",
    "belgium-province":          "__bundled-belgium-2026__",
    "belgium-arrondissement":    "__bundled-belgium-2026__",
    "belgium-castle":            "__bundled-belgium-2026__",
    "belgium-hsl":               "__bundled-belgium-2026__",
    "belgium-coastline":         "__bundled-belgium-2026__",
    // London — stadium (12) and rail terminus (14) are custom POI categories
    // with no rulebook equivalent, both matching + measuring. The bare
    // "stadium" tentacle category stays gated to Budapest; London exposes its
    // stadiums through london-stadium only, so there is no collision.
    // London — offered by BOTH London games, which share every asset these
    // questions read (POIs, boroughs, borough lines) and differ only in their
    // hiding zones.
    //
    // london-borough measures against EVERY borough boundary (Jules' call),
    // unlike belgium-province / zurich-canton which measure the division you
    // are standing in. Checked before building: across all 271 hiding zones the
    // "hider is closer" answer keeps ~50% of them, so the dense-mesh problem
    // that killed belgium-arrondissement measuring does not arise here.
    "london-borough":            LONDON_GAMES,
    "london-stadium":            LONDON_GAMES,
    "london-rail":               LONDON_GAMES,
    // Graz — the 17 admin_level 9 Bezirke, bundled as polygons. Matching +
    // measuring, and measuring is the border of the district you are IN
    // (belgium-province / zurich-canton style), NOT every district border the
    // way london-borough works. Jules' explicit call.
    "graz-district":             "__bundled-graz-2026__",
    // Paris — the 20 arrondissements plus an "Outer" catch-all covering the rest
    // of the play-area rectangle. Matching + measuring, and measuring is the
    // border of the arrondissement you are IN (graz-district / belgium-province
    // style), NOT every border the way london-borough works. Jules' call, as is
    // keeping "Outer" as a real 21st region — 186 of the 412 hiding zones are
    // outside the city limits.
    "paris-arrondissement":      "__bundled-paris-2026__",
    // Stockholm — three levels of the map author's own groupings (3 / 9 / 25),
    // each with matching AND measuring, plus a game-specific IKEA POI doing
    // both. Measuring is the border of the division you are IN at every level.
    // admin3 measuring is lopsided by design (it keeps ~6.5% of zones); that
    // was measured and shipped deliberately — see stockholmAdmin.ts.
    "stockholm-admin1":          "__bundled-stockholm-2026__",
    "stockholm-admin2":          "__bundled-stockholm-2026__",
    "stockholm-admin3":          "__bundled-stockholm-2026__",
    "stockholm-ikea":            "__bundled-stockholm-2026__",
    // Milan — three game-specific POI categories, each matching + measuring.
    // The other 11 supplied categories are rulebook ones and need no gate; they
    // reach the POI override through their generic question types.
    //
    // milan-train is NOT wired to the "train_station" category on purpose: that
    // key overrides the generic same-train-line / same-length-station
    // questions, which must see all 269 stations, and Milan supplies only its
    // 26 heavy-rail ones. It reads "rail_station" instead — the london-rail /
    // "rail_terminus" shape.
    //
    // milan-water is points (45 quarry lakes, the Darsena, etc.), so it uses
    // the POI path like belgium-castle, NOT the bundled-geometry path that
    // budapest-water uses. Its folder is "water_body" because the importer's
    // SKIPPED_POI_CATEGORIES drops a folder literally named "water".
    // 9 Comune di Milano Municipi + 3 "Outer" catch-alls covering the rest of
    // the 12 km play circle (the Paris "Outer" shape — 65 of 269 zones are
    // outside the comune). Matching + measuring, and measuring is the border of
    // the municipio you are IN, NOT every border the way london-borough works.
    // Measuring keeps a mean 10.5% of zones — lopsided but deliberate, between
    // Stockholm's admin2 and admin3; see milanAdmin.ts.
    "milan-municipio":           "__bundled-milan-2026__",
    "milan-castle":              "__bundled-milan-2026__",
    "milan-train":               "__bundled-milan-2026__",
    "milan-water":               "__bundled-milan-2026__",
    // Brighton — two independent bundled admin layers plus a bundled coastline.
    // ward (24 ONS 2026 wards + Outer) and postcode (8 BN districts + Outer)
    // both do matching AND measuring, and measuring is the border of the region
    // you are IN, NOT every border the way london-borough works.
    //
    // Measured before shipping: postcode measuring keeps a mean 25.0% of hiding
    // zones (the best-balanced of any game), ward measuring 5.4% — lopsided,
    // marginally tighter than Stockholm's admin3, and shipped deliberately.
    // See brightonAdmin.ts.
    //
    // brighton-coastline is measuring-only: 18.6 km of real OSM coast between
    // the author's two end markers, so the generic Overpass "coastline"
    // question is hidden for this game in favour of it.
    //
    // brighton-rail is the 7 mainline stations as a custom POI category
    // ("rail_station"), NOT "train_station" — that key would hijack the generic
    // same-train-line question with 7 of the map's 132 stops.
    "brighton-ward":             "__bundled-brighton-2026__",
    "brighton-postcode":         "__bundled-brighton-2026__",
    "brighton-coastline":        "__bundled-brighton-2026__",
    "brighton-rail":             "__bundled-brighton-2026__",
};

/**
 * Is `type` allowed in the game identified by `sentinel`? True for any type not
 * in GAME_GATED_TYPES (ungated), and for a gated type whose sentinel matches
 * (or is one of several).
 */
export function gateAllows(type: string, sentinel: string): boolean {
    const required = GAME_GATED_TYPES[type];
    if (!required) return true;
    return Array.isArray(required)
        ? required.includes(sentinel)
        : required === sentinel;
}

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
                .literal("international-border-og")
                .describe("International Border [OG]"),
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
        // Mountain uses the generic "Mountain" question (auto-uses custom POIs).
    ]),
});

const brnoMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("brno-water").describe("Body of Water (Brno)"),
});

const bernMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("bern-canton").describe("Canton Border Question (Bern)"),
        z.literal("bern-mountain").describe("Nearest Mountain (Bern)"),
    ]),
});

const bucharestMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("covrigarie").describe("Nearest Covrigarie (Bucharest)"),
        z.literal("buch-train_station").describe("Nearest Railway Station (Bucharest)"),
    ]),
});

const exterRotterdamMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("rotterdam-rail").describe("Distance to High-Speed Rail (Rotterdam)"),
        z.literal("rotterdam-coastline").describe("Distance to Coast (Rotterdam)"),
        z.literal("rotterdam-ns").describe("Nearest NS Station (Rotterdam)"),
        z
            .literal("rotterdam-municipality-border")
            .describe("Distance to Municipality Border (Rotterdam)"),
    ]),
});

const zurichMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("zurich-canton").describe("Canton Border Question (Zürich)"),
        z.literal("zurich-coastline").describe("Distance to Lake Zürich Coast"),
    ]),
});

const budapestMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("budapest-water").describe("Nearest Body of Water (Budapest)"),
        z.literal("budapest-castle").describe("Nearest Castle (Budapest)"),
        z.literal("budapest-stadium").describe("Nearest Stadium (Budapest)"),
        z.literal("budapest-rail").describe("Nearest Railway Station (Budapest)"),
    ]),
});

const belgiumMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("belgium-region").describe("Distance to Region Border (Belgium)"),
        z.literal("belgium-province").describe("Distance to Province Border (Belgium)"),
        z.literal("belgium-castle").describe("Nearest Castle/Fort (Belgium)"),
        z.literal("belgium-hsl").describe("Distance to High-Speed Rail (Belgium)"),
        z.literal("belgium-coastline").describe("Distance to Coast (Belgium)"),
    ]),
});

const londonMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("london-borough").describe("Distance to Borough Boundary (London)"),
        z.literal("london-stadium").describe("Nearest Stadium (London)"),
        z.literal("london-rail").describe("Nearest Rail Terminus (London)"),
    ]),
});

const grazMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.literal("graz-district").describe("Distance to District Border (Graz)"),
});

const parisMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z
        .literal("paris-arrondissement")
        .describe("Distance to Arrondissement Border (Paris)"),
});

const stockholmMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z
            .literal("stockholm-admin1")
            .describe("Distance to 1st Admin Border (Stockholm)"),
        z
            .literal("stockholm-admin2")
            .describe("Distance to 2nd Admin Border (Stockholm)"),
        z
            .literal("stockholm-admin3")
            .describe("Distance to 3rd Admin Border (Stockholm)"),
        z.literal("stockholm-ikea").describe("Nearest IKEA (Stockholm)"),
    ]),
});

const brightonMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("brighton-ward").describe("Distance to Ward Border (Brighton)"),
        z.literal("brighton-postcode").describe("Distance to Postcode Border (Brighton)"),
        z.literal("brighton-coastline").describe("Distance to Coast (Brighton)"),
        z.literal("brighton-rail").describe("Nearest Railway Station (Brighton)"),
    ]),
});

const milanMeasuringQuestionsSchema = baseMeasuringQuestionSchema.extend({
    type: z.union([
        z.literal("milan-municipio").describe("Distance to Municipio Border (Milan)"),
        z.literal("milan-castle").describe("Nearest Castle/Fort (Milan)"),
        z.literal("milan-train").describe("Nearest Train Station (Milan)"),
        z.literal("milan-water").describe("Nearest Body of Water (Milan)"),
    ]),
});

export const measuringQuestionSchema = z.union([
    ordinaryMeasuringQuestionSchema.describe(NO_GROUP),
    southLimburgMeasuringQuestionsSchema.describe(NO_GROUP),
    brnoMeasuringQuestionsSchema.describe(NO_GROUP),
    bucharestMeasuringQuestionsSchema.describe(NO_GROUP),
    bernMeasuringQuestionsSchema.describe(NO_GROUP),
    exterRotterdamMeasuringQuestionsSchema.describe(NO_GROUP),
    zurichMeasuringQuestionsSchema.describe(NO_GROUP),
    budapestMeasuringQuestionsSchema.describe(NO_GROUP),
    belgiumMeasuringQuestionsSchema.describe(NO_GROUP),
    londonMeasuringQuestionsSchema.describe(NO_GROUP),
    grazMeasuringQuestionsSchema.describe(NO_GROUP),
    parisMeasuringQuestionsSchema.describe(NO_GROUP),
    stockholmMeasuringQuestionsSchema.describe(NO_GROUP),
    milanMeasuringQuestionsSchema.describe(NO_GROUP),
    brightonMeasuringQuestionsSchema.describe(NO_GROUP),
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
