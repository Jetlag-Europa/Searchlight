import type { GameDefinition } from "@searchlight/shared";
import { atom, computed } from "nanostores";

import { questionSchema } from "@/maps/schema";

import { fetchGameRevisionAPI } from "./api.js";
import { type CompiledGame,compileGameDefinition } from "./compile.js";

function canonicalQuestionId(question: any): {
    family: string;
    id: string | undefined;
} {
    if (!question || typeof question !== "object")
        return { family: "", id: undefined };
    if (question.id === "tentacles") {
        return { family: "tentacle", id: question.data?.locationType };
    }
    if (question.id === "matching" || question.id === "measuring") {
        return { family: question.id, id: question.data?.type };
    }
    return { family: question.id, id: undefined };
}

// Player-drawn questions carry their own geometry and never query OSM.
const PLAYER_CUSTOM_TYPES: Record<string, readonly string[]> = {
    matching: ["custom-zone", "custom-points"],
    measuring: ["custom-measure"],
    tentacle: ["custom"],
};

/**
 * Whether a persisted question is supported by the current handlers.
 *
 * Every question belongs to a game. Once its definition is ready, a game
 * offers only what it declares: radar and thermometer when its definition
 * enables them, its compiled feature questions, and player-drawn custom
 * questions. Anything else, such as a question from the retired built-in
 * catalogue still stored in an older session, is never supported.
 *
 * While the definition is loading (`compiled` is null), the questions a game
 * could support are retained: radar, thermometer, canonical feature IDs and
 * player-drawn custom questions.
 */
export function isQuestionSupported(
    question: any,
    compiled: Pick<CompiledGame, "questionMap"> | null | undefined,
): boolean {
    const { family, id } = canonicalQuestionId(question);
    if (!family) return false;
    // A hiding zone size change belongs to no game: it fits every one.
    if (family === "zone-size")
        return questionSchema.safeParse(question).success;
    if (family === "radius" || family === "thermometer") {
        if (!compiled) return true;
        for (const definition of compiled.questionMap.values()) {
            if (definition.family === family) return true;
        }
        return false;
    }
    if (
        family !== "matching" &&
        family !== "measuring" &&
        family !== "tentacle"
    )
        return false;
    if (typeof id !== "string") return false;

    const prefix = family === "tentacle" ? "tentacle-" : `${family}-`;
    if (id.startsWith(prefix)) {
        if (
            id.length === prefix.length ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id.slice(prefix.length))
        ) {
            return false;
        }
        if (!compiled) return true;
        return compiled.questionMap.get(id)?.family === family;
    }

    if (!PLAYER_CUSTOM_TYPES[family].includes(id)) return false;

    // A player-drawn question must match its schema branch.
    return questionSchema.safeParse(question).success;
}

export function filterSupportedQuestions(
    questions: readonly any[],
    compiled: Pick<CompiledGame, "questionMap"> | null | undefined,
): any[] {
    return questions.filter((question) =>
        isQuestionSupported(question, compiled),
    );
}

export const activeGameDefinitionAtom = atom<GameDefinition | null>(null);
const compiledDefinitionCache = new WeakMap<GameDefinition, CompiledGame>();

export const compiledGameAtom = computed(
    activeGameDefinitionAtom,
    (definition): CompiledGame | null => {
        if (!definition) return null;
        let compiled = compiledDefinitionCache.get(definition);
        if (!compiled) {
            compiled = compileGameDefinition(definition);
            compiledDefinitionCache.set(definition, compiled);
        }
        return compiled;
    },
);

// Sessions load pinned revisions, which never change, so they can be cached.
const revisionDefinitionCache = new Map<string, GameDefinition>();
const pendingDefinitions = new Map<string, Promise<GameDefinition>>();
// Keep only a few full definitions: each can contain thousands of GeoJSON
// vertices, and the compiled WeakMap follows their lifetime.
const MAX_REVISION_DEFINITIONS = 4;

function rememberDefinition(
    cache: Map<string, GameDefinition>,
    key: string,
    definition: GameDefinition,
    limit: number,
): void {
    cache.delete(key);
    cache.set(key, definition);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
}

export function getRevisionCacheKey(
    gameId: string,
    revision: string | number,
    sessionId?: string,
): string {
    return JSON.stringify([gameId, String(revision), sessionId ?? null]);
}

export function getCachedRevisionDefinition(
    gameId: string,
    revision: string | number,
    sessionId?: string,
): GameDefinition | undefined {
    const key = getRevisionCacheKey(gameId, revision, sessionId);
    const definition = revisionDefinitionCache.get(key);
    if (definition)
        rememberDefinition(
            revisionDefinitionCache,
            key,
            definition,
            MAX_REVISION_DEFINITIONS,
        );
    return definition;
}

export function cacheRevisionDefinition(
    gameId: string,
    revision: string | number,
    definition: GameDefinition,
    sessionId?: string,
): void {
    rememberDefinition(
        revisionDefinitionCache,
        getRevisionCacheKey(gameId, revision, sessionId),
        definition,
        MAX_REVISION_DEFINITIONS,
    );
}

/**
 * Load a session's pinned revision. Share only requests made with the same
 * revision and session access scope.
 */
export function loadGameDefinition(
    gameId: string,
    revisionId: string,
    sessionId: string,
): Promise<GameDefinition> {
    const key = JSON.stringify([gameId, revisionId, sessionId]);
    const pending = pendingDefinitions.get(key);
    if (pending) return pending;

    const cached = getCachedRevisionDefinition(gameId, revisionId, sessionId);
    if (cached) return Promise.resolve(cached);

    const request = fetchGameRevisionAPI(gameId, revisionId, sessionId)
        .then((definition) => {
            // A cache clear also invalidates requests that started before it.
            if (pendingDefinitions.get(key) === request) {
                cacheRevisionDefinition(
                    gameId,
                    revisionId,
                    definition,
                    sessionId,
                );
            }
            return definition;
        })
        .finally(() => {
            if (pendingDefinitions.get(key) === request)
                pendingDefinitions.delete(key);
        });
    pendingDefinitions.set(key, request);
    return request;
}

export function clearDefinitionCache(): void {
    revisionDefinitionCache.clear();
    pendingDefinitions.clear();
}
export function setActiveGameDefinition(
    definition: GameDefinition | null,
): void {
    activeGameDefinitionAtom.set(definition);
}
