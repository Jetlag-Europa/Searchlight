import type { GameDefinition } from "@searchlight/shared";
import { atom, computed } from "nanostores";

import { questionSchema } from "@/maps/schema";

import { exportGameDefinitionAPI, fetchGameRevisionAPI } from "./api.js";
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

/** Whether the question asks about a game layer, such as `matching-museum`. */
export function hasCompiledQuestionId(question: any): boolean {
    const { family, id } = canonicalQuestionId(question);
    return (
        (family === "matching" ||
            family === "measuring" ||
            family === "tentacle") &&
        typeof id === "string" &&
        id.startsWith(`${family}-`)
    );
}

/**
 * Whether a persisted question is supported by the current handlers.
 *
 * While a definition is loading, canonical feature IDs are retained. Once a
 * definition is ready, a game offers only what it declares: radar and
 * thermometer when its definition enables them, its compiled feature
 * questions, and player-drawn custom questions. Generic question types (which
 * would query OSM/Overpass) are not supported in a game, so neither a stale or
 * wrong-game definition nor a pasted question falls through to OSM evaluation.
 *
 * `inGame` says whether the tab has a game selected, even one whose definition
 * is still loading. Outside any game (free play) canonical feature IDs are not
 * supported: there is no layer to answer them from.
 */
export function isQuestionSupported(
    question: any,
    compiled: Pick<CompiledGame, "questionMap"> | null | undefined,
    { inGame = true }: { inGame?: boolean } = {},
): boolean {
    const { family, id } = canonicalQuestionId(question);
    if (!family) return false;
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
        if (!compiled) return inGame;
        return compiled.questionMap.get(id)?.family === family;
    }

    if (compiled && !PLAYER_CUSTOM_TYPES[family].includes(id)) return false;

    // The schema's explicit branches are the source of truth for the remaining
    // question shapes. Its generic feature branch is intentionally bypassed
    // above unless the ID is compiled.
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

// Only pinned revisions are cached: they never change. A game's latest
// definition can be replaced by a new revision at any time, and nothing tells
// the client which revision is latest without asking the server.
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
 * Share only requests made with the same revision and session access scope.
 * Without a revision, the latest definition is fetched afresh each time.
 */
export function loadGameDefinition(
    gameId: string,
    revisionId: string | undefined,
    sessionId: string | undefined,
): Promise<GameDefinition> {
    const key = JSON.stringify([gameId, revisionId ?? null, sessionId ?? null]);
    const pending = pendingDefinitions.get(key);
    if (pending) return pending;

    if (revisionId) {
        const cached = getCachedRevisionDefinition(
            gameId,
            revisionId,
            sessionId,
        );
        if (cached) return Promise.resolve(cached);
    }

    const request = (
        revisionId
            ? fetchGameRevisionAPI(gameId, revisionId, sessionId)
            : exportGameDefinitionAPI(gameId)
    )
        .then((definition) => {
            // A cache clear also invalidates requests that started before it.
            if (revisionId && pendingDefinitions.get(key) === request) {
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
