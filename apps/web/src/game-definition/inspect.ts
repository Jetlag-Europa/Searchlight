import type { QuestionFamily } from "@searchlight/shared";

import {
    type CompiledGame,
    detectFeatureGeometry,
} from "@/game-definition/compile";

/** An issue check-game.mjs found in a file that the validator accepts. */
export interface QualityIssue {
    level: "error" | "warning" | "note";
    path: string;
    message: string;
    code?: string;
    /** A warning the preloaded-games check (`--strict`) fails on. */
    strict: boolean;
}

/**
 * Runs the game creation skill's checker (check-game.mjs) on a parsed file:
 * the play-quality checks the validator doesn't do. The checker loads on
 * first use, so pages only download it once they check a file. Its errors
 * mirror the validator's, so a valid file shouldn't have any. The file's own
 * size doesn't matter here: the import page sends it as compact JSON, which
 * is what the checker sizes.
 */
export async function checkGameQuality(
    definition: unknown,
): Promise<QualityIssue[]> {
    const { checkGame, STRICT_CODES } = await import(
        "../../public/skills/create-game/check-game.mjs"
    );
    const { errors, warnings, notes } = checkGame(definition);
    const issue =
        (level: QualityIssue["level"]) =>
        (i: { path: string; message: string; code?: string }) => ({
            level,
            path: i.path,
            message: i.message,
            code: i.code,
            strict:
                level === "warning" &&
                i.code !== undefined &&
                STRICT_CODES.has(i.code),
        });
    return [
        ...errors.map(issue("error")),
        ...warnings.map(issue("warning")),
        ...notes.map(issue("note")),
    ];
}

export interface LayerSummary {
    index: number;
    name: string;
    /** "points", "lines" or "polygons"; "empty" without features. */
    geometry: "points" | "lines" | "polygons" | "empty";
    featureCount: number;
    /** The kinds of question the app builds on this layer (no tentacles on lines or polygons). */
    questions: QuestionFamily[];
}

/** One entry per feature layer of a compiled game, in file order. */
export function summarizeLayers(
    compiled: Pick<CompiledGame, "definition" | "questions">,
): LayerSummary[] {
    return (compiled.definition.features ?? []).map((layer, index) => {
        const features = layer.data?.features ?? [];
        // compile.ts keys each layer's dataset by its position.
        const datasetId = `layer-${index}`;
        return {
            index,
            name: layer.name,
            // As the app reads it, so the summary matches the questions.
            geometry: features.length ? detectFeatureGeometry(layer) : "empty",
            featureCount: features.length,
            questions: compiled.questions
                .filter((q) => q.evaluator.source?.datasetId === datasetId)
                .map((q) => q.family),
        };
    });
}

/** A file size for people: "740 KB", "6.3 MB". */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
