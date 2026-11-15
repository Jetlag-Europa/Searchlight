import { type GameSessionSummary, isRecord } from "@searchlight/shared";

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
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "session"
    }.questions.json`;

// The API takes a question list of up to 1 MiB.
const MAX_SAVED_LENGTH = 1_000_000;

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

/**
 * Whether a question's places and drawn shapes are what the map and cards
 * expect. The schema takes anything there (z.any), and a wrong shape saved
 * to the session would break the board for every player.
 */
function shapesOk({ id, data }: Question): boolean {
    const { type, geo, location, places } = data as Record<string, unknown>;
    if (id === "tentacles") {
        return (
            (!location || featureOk(location, ["Point"])) &&
            ((places as unknown[] | undefined) ?? []).every((place) =>
                featureOk(place, ["Point"]),
            )
        );
    }
    if (geo == null) return true;
    // Custom points are a list of features; a zone or lines are a feature
    // or a collection.
    if (type === "custom-points") {
        return Array.isArray(geo) && geo.every((p) => featureOk(p, ["Point"]));
    }
    const custom = type === "custom-zone" || type === "custom-measure";
    if (custom && Array.isArray(geo)) return false;
    const features = Array.isArray(geo)
        ? geo
        : isRecord(geo) && geo.type === "FeatureCollection"
          ? geo.features
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
        )
    );
}

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
    if (text.length > MAX_SAVED_LENGTH) {
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
    // Each is saved with an id and a position, about 100 characters.
    if (
        JSON.stringify(questions).length + questions.length * 100 >
        MAX_SAVED_LENGTH
    ) {
        return { error: "That file is too big to import" };
    }
    return {
        questions,
        skipped: file.questions.length - questions.length,
        sessionName:
            typeof file.sessionName === "string" ? file.sessionName : "",
        otherGame:
            typeof file.gameId === "string" && file.gameId !== gameId
                ? typeof file.gameName === "string"
                    ? file.gameName
                    : ""
                : null,
    };
}
