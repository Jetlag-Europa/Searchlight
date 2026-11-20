import {
    formatGameDefinitionJson,
    type GameDefinition,
    resolveGameDefinitionId,
} from "@searchlight/shared";

/**
 * Formats a game definition as an editable JSON download, materializing the
 * game's permanent `id` when omitted so renaming `name` and re-importing
 * updates the same game instead of creating a duplicate.
 */
export function formatGameExportJson(
    definition: GameDefinition,
    permanentId?: string,
): string {
    if (definition.id) {
        return formatGameDefinitionJson(definition);
    }
    const id = permanentId || resolveGameDefinitionId(definition);
    if (!id) {
        return formatGameDefinitionJson(definition);
    }
    const withId: Record<string, unknown> = {};
    if (definition.$schema !== undefined) {
        withId.$schema = definition.$schema;
    }
    withId.id = id;
    for (const [key, value] of Object.entries(definition)) {
        if (key !== "$schema" && key !== "id") {
            withId[key] = value;
        }
    }
    return formatGameDefinitionJson(withId);
}
