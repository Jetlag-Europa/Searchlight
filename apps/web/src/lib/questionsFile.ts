import { type GameSessionSummary, isRecord } from "@searchlight/shared";
import * as turf from "@turf/turf";

import type { CompiledGame } from "@/game-definition/compile";
import { isQuestionSupported } from "@/game-definition/store";
import {
    newQuestionKey,
    type Question,
    type Questions,
    questionSchema,
} from "@/maps/schema";

type FileSession = Pick<
    GameSessionSummary,
    "name" | "gameId" | "gameName" | "gameRevisionId"
>;

/** A session's questions as a file: what Export Questions downloads. */
export const buildQuestionsFile = (
    session: FileSession,
    questions: Questions,
    now = new Date(),
) => ({
    searchlightQuestions: 1,
    sessionName: session.name,
    // The session's game as the server knows it, not the definition's id,
    // which two servers may share.
    gameId: session.gameId,
    gameName: session.gameName,
    gameRevisionId: session.gameRevisionId,
    exportedAt: now.toISOString(),
    questions,
});

export const questionsFileName = (sessionName: string): string =>
    `${
        sessionName
            .toLowerCase()
            // Letters and digits of any script: "東京" and "zürich" stay.
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .slice(0, 80)
            .replace(/^-|-$/g, "") || "session"
    }.questions.json`;

/** The API takes a question list of up to 1 MiB, counted in bytes. */
export const MAX_QUESTIONS_FILE_BYTES = 1_000_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;

// A radius outside 1 m to 20,000 km (half way round the Earth) makes the
// buffer throw or never finish, which stops the map for every player.
const MIN_RADIUS_KM = 0.001;
const MAX_RADIUS_KM = 20_000;
// What one file may hold across all its questions, as the map works them
// out one after another. Buffering drawn lines that span a continent takes
// 4 s at 200 corners, half a minute at 500 and doesn't end at a few
// thousand. 1,000 places spread over the world take 20 s to outline or to
// measure to; 300 take a few.
const MAX_LINE_POSITIONS = 200;
const MAX_PLACES = 300;
// Names from the file are shown in the confirm.
const MAX_NAME_LENGTH = 80;

const GEOMETRY_TYPES = [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
] as const;

const positionOk = (pos: unknown): pos is number[] =>
    Array.isArray(pos) &&
    pos.length >= 2 &&
    pos.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    pos[0] >= -180 &&
    pos[0] <= 180 &&
    pos[1] >= -90 &&
    pos[1] <= 90;

const lineOk = (line: unknown): boolean =>
    Array.isArray(line) && line.length >= 2 && line.every(positionOk);

const ringOk = (ring: unknown): boolean => {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(positionOk)) {
        return false;
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    return (
        first[0] === last[0] &&
        first[1] === last[1] &&
        new Set(ring.slice(0, -1).map(([x, y]) => `${x},${y}`)).size >= 3
    );
};

const polygonOk = (rings: unknown): boolean =>
    Array.isArray(rings) && rings.length > 0 && rings.every(ringOk);

const geometryOk = (type: unknown, coordinates: unknown): boolean => {
    switch (type) {
        case "Point":
            return positionOk(coordinates);
        case "MultiPoint":
            return (
                Array.isArray(coordinates) &&
                coordinates.length > 0 &&
                coordinates.every(positionOk)
            );
        case "LineString":
            return lineOk(coordinates);
        case "MultiLineString":
            return (
                Array.isArray(coordinates) &&
                coordinates.length > 0 &&
                coordinates.every(lineOk)
            );
        case "Polygon":
            return polygonOk(coordinates);
        case "MultiPolygon":
            return (
                Array.isArray(coordinates) &&
                coordinates.length > 0 &&
                coordinates.every(polygonOk)
            );
        default:
            return false;
    }
};

const featureOk = (
    feature: unknown,
    types: readonly string[] = GEOMETRY_TYPES,
): boolean =>
    isRecord(feature) &&
    feature.type === "Feature" &&
    isRecord(feature.geometry) &&
    types.includes(feature.geometry.type as string) &&
    geometryOk(feature.geometry.type, feature.geometry.coordinates) &&
    // A place's name is shown as text.
    ["string", "number", "undefined"].includes(
        typeof (feature.properties as { name?: unknown } | null)?.name,
    );

/** How many positions a checked feature's geometry has. */
const positionCount = (coordinates: unknown): number =>
    !Array.isArray(coordinates)
        ? 0
        : typeof coordinates[0] === "number"
          ? 1
          : coordinates.reduce((n, c) => n + positionCount(c), 0);
const lineLength = (features: unknown[]): number =>
    features.reduce<number>((n, feature) => {
        const { type, coordinates } = (
            feature as { geometry: { type: string; coordinates: unknown } }
        ).geometry;
        return type.endsWith("Point") ? n : n + positionCount(coordinates);
    }, 0);

interface Cost {
    /** Corners of drawn lines and outlines to measure to. */
    corners: number;
    /** Custom places and points. */
    places: number;
}

/**
 * What a question's places and drawn shapes cost the map, or null if its
 * radius or shapes aren't what the map and cards expect. The schema takes
 * anything for the shapes (z.any) and any radius from 0 up, and a wrong one
 * saved to the session would break the board for every player.
 */
function shapeCost({ id, data }: Question): Cost | null {
    const { type, geo, location, places, radius, unit } = data as Record<
        string,
        unknown
    >;
    if (typeof radius === "number") {
        const km = turf.convertLength(radius, unit as turf.Units, "kilometers");
        if (!(km >= MIN_RADIUS_KM && km <= MAX_RADIUS_KM)) return null;
    }
    const points = (list: unknown[]): Cost | null =>
        list.every((place) => featureOk(place, ["Point"]))
            ? { corners: 0, places: list.length }
            : null;
    if (id === "tentacles") {
        return !location || featureOk(location, ["Point"])
            ? points((places as unknown[] | undefined) ?? [])
            : null;
    }
    if (geo == null) return { corners: 0, places: 0 };
    // Custom points are a list of features, drawn lines a collection, and a
    // zone a feature or a collection.
    if (type === "custom-points")
        return Array.isArray(geo) ? points(geo) : null;
    const collection = isRecord(geo) && geo.type === "FeatureCollection";
    if (type === "custom-measure" && !collection) return null;
    if (type === "custom-zone" && Array.isArray(geo)) return null;
    const features = Array.isArray(geo)
        ? geo
        : collection
          ? (geo as { features: unknown }).features
          : [geo];
    if (
        !Array.isArray(features) ||
        !features.every((feature) =>
            featureOk(
                feature,
                type === "custom-zone"
                    ? ["Polygon", "MultiPolygon"]
                    : undefined,
            ),
        )
    ) {
        return null;
    }
    // Only what is measured to is buffered: a zone's outline is cheap.
    return type === "custom-measure"
        ? { corners: lineLength(features), places: features.length }
        : { corners: 0, places: 0 };
}

const name = (value: unknown): string =>
    typeof value === "string" ? value.slice(0, MAX_NAME_LENGTH) : "";

export interface ImportedQuestions {
    questions: Questions;
    /**
     * Questions in the file that are broken, not part of this game, or more
     * than the map can work out.
     */
    skipped: number;
    sessionName: string;
    /** The name of the game it was exported from, if not this session's. */
    otherGame: string | null;
}

/**
 * The questions of an exported file that `compiled`, the game of the session
 * they go into, can take. Each is re-read like one from the server, and is
 * a new question there: under a new key, as one coming back under the key
 * it was deleted with would be deleted again by a list made before (see
 * asRestored), and restoring nothing, as one pasted (see addQuestion).
 */
export function parseQuestionsFile(
    text: string,
    compiled: Pick<CompiledGame, "questionMap">,
    gameId: string,
): ImportedQuestions | { error: string } {
    if (bytes(text) > MAX_QUESTIONS_FILE_BYTES) {
        return { error: "That file is too big to import" };
    }
    let file: unknown;
    try {
        // 1e999 reads as Infinity, which is saved as null: not a number here.
        file = JSON.parse(text, (_, value) =>
            typeof value === "number" && !Number.isFinite(value) ? null : value,
        );
    } catch {
        return { error: "That file isn't JSON" };
    }
    if (
        !isRecord(file) ||
        file.searchlightQuestions !== 1 ||
        !Array.isArray(file.questions)
    ) {
        return { error: "That isn't a Searchlight questions file" };
    }
    let corners = 0;
    let places = 0;
    const questions = file.questions.flatMap((question) => {
        const parsed = questionSchema.safeParse(question);
        if (!parsed.success || !isQuestionSupported(parsed.data, compiled)) {
            return [];
        }
        const cost = shapeCost(parsed.data);
        if (
            !cost ||
            corners + cost.corners > MAX_LINE_POSITIONS ||
            places + cost.places > MAX_PLACES
        ) {
            return [];
        }
        corners += cost.corners;
        places += cost.places;
        delete parsed.data.data.restoredFrom;
        return [{ ...parsed.data, key: newQuestionKey() }];
    });
    if (questions.length === 0) {
        return { error: "That file has no questions for this game" };
    }
    // Each is saved with an id and a position, about 100 bytes.
    if (
        bytes(JSON.stringify(questions)) + questions.length * 100 >
        MAX_QUESTIONS_FILE_BYTES
    ) {
        return { error: "That file is too big to import" };
    }
    return {
        questions,
        skipped: file.questions.length - questions.length,
        sessionName: name(file.sessionName),
        otherGame:
            typeof file.gameId === "string" && file.gameId !== gameId
                ? name(file.gameName)
                : null,
    };
}
