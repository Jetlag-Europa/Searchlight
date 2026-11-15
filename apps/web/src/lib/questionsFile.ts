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
// Buffering drawn lines takes most of a minute at 500 corners, and never
// ends at a few thousand; places are cheaper.
const MAX_LINE_POSITIONS = 500;
const MAX_PLACES = 1_000;
// Names from the file are shown in the confirm.
const MAX_NAME_LENGTH = 80;

// How deep each geometry's coordinates nest.
const DEPTH: Record<string, number> = {
    Point: 0,
    MultiPoint: 1,
    LineString: 1,
    MultiLineString: 2,
    Polygon: 2,
    MultiPolygon: 3,
};
const coordinatesOk = (coordinates: unknown, depth: number): boolean =>
    Array.isArray(coordinates) &&
    (depth === 0
        ? coordinates.length >= 2 &&
          coordinates.every((n) => typeof n === "number")
        : coordinates.length > 0 &&
          coordinates.every((c) => coordinatesOk(c, depth - 1)));
const featureOk = (feature: unknown, types = Object.keys(DEPTH)): boolean =>
    isRecord(feature) &&
    feature.type === "Feature" &&
    isRecord(feature.geometry) &&
    types.includes(feature.geometry.type as string) &&
    coordinatesOk(
        feature.geometry.coordinates,
        DEPTH[feature.geometry.type as string],
    ) &&
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

/**
 * Whether a question's radius, places and drawn shapes are what the map and
 * cards expect. The schema takes anything for the shapes (z.any) and any
 * radius from 0 up, and a wrong one saved to the session would break the
 * board for every player.
 */
function shapesOk({ id, data }: Question): boolean {
    const { type, geo, location, places, radius, unit } = data as Record<
        string,
        unknown
    >;
    if (typeof radius === "number") {
        const km = turf.convertLength(radius, unit as turf.Units, "kilometers");
        if (!(km >= MIN_RADIUS_KM && km <= MAX_RADIUS_KM)) return false;
    }
    if (id === "tentacles") {
        const list = (places as unknown[] | undefined) ?? [];
        return (
            (!location || featureOk(location, ["Point"])) &&
            list.length <= MAX_PLACES &&
            list.every((place) => featureOk(place, ["Point"]))
        );
    }
    if (geo == null) return true;
    // Custom points are a list of features, drawn lines a collection, and a
    // zone a feature or a collection.
    if (type === "custom-points") {
        return (
            Array.isArray(geo) &&
            geo.length <= MAX_PLACES &&
            geo.every((p) => featureOk(p, ["Point"]))
        );
    }
    const collection = isRecord(geo) && geo.type === "FeatureCollection";
    if (type === "custom-measure" && !collection) return false;
    if (type === "custom-zone" && Array.isArray(geo)) return false;
    const features = Array.isArray(geo)
        ? geo
        : collection
          ? (geo as { features: unknown }).features
          : [geo];
    return (
        Array.isArray(features) &&
        features.every((feature) =>
            featureOk(
                feature,
                type === "custom-zone"
                    ? ["Polygon", "MultiPolygon"]
                    : undefined,
            ),
        ) &&
        (type !== "custom-measure" ||
            (features.length <= MAX_PLACES &&
                lineLength(features) <= MAX_LINE_POSITIONS))
    );
}

const name = (value: unknown): string =>
    typeof value === "string" ? value.slice(0, MAX_NAME_LENGTH) : "";

export interface ImportedQuestions {
    questions: Questions;
    /** Questions in the file that are broken or not part of this game. */
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
    const questions = file.questions.flatMap((question) => {
        const parsed = questionSchema.safeParse(question);
        if (
            !parsed.success ||
            !isQuestionSupported(parsed.data, compiled) ||
            !shapesOk(parsed.data)
        ) {
            return [];
        }
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
