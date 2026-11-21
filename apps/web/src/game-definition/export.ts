import { formatGameDefinitionJson } from "@searchlight/shared";

/** Include the permanent `id` so renaming an exported game doesn't fork it on re-import. */
export const formatGameExportJson = (def: { id?: string }, id: string) =>
    formatGameDefinitionJson(def.id ? def : { id, ...def });
