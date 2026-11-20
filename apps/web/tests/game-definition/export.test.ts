import {
    computeGameDefinitionChecksum,
    formatGameDefinitionJson,
    GAME_DEFINITION_SCHEMA_URL,
    type GameDefinition,
    resolveGameDefinitionId,
    validateGameDefinition,
} from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { formatGameExportJson } from "@/game-definition/export";

function sampleDefinition(
    overrides: Partial<GameDefinition> = {},
): GameDefinition {
    return {
        name: "Paris 15-08",
        serverId: "server-1",
        map: {
            center: [2.3522, 48.8566],
            playArea: {
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        properties: {},
                        geometry: {
                            type: "Polygon",
                            coordinates: [
                                [
                                    [2.25, 48.8],
                                    [2.45, 48.8],
                                    [2.45, 48.9],
                                    [2.25, 48.9],
                                    [2.25, 48.8],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
        hidingZones: {
            radius: 400,
            features: {
                type: "FeatureCollection",
                features: [
                    {
                        type: "Feature",
                        properties: { name: "Châtelet" },
                        geometry: {
                            type: "Point",
                            coordinates: [2.347, 48.8584],
                        },
                    },
                ],
            },
        },
        ...overrides,
    };
}

describe("formatGameExportJson", () => {
    it("materializes the permanent id when omitted, preserving checksum and rename safety", () => {
        const original = sampleDefinition();
        const originalChecksum = computeGameDefinitionChecksum(original);
        const originalKey = resolveGameDefinitionId(original);

        const exportedText = formatGameExportJson(original, originalKey);
        const exported = JSON.parse(exportedText) as GameDefinition;

        expect(exported.id).toBe("paris-15-08");
        expect(Object.keys(exported)[0]).toBe("id");
        expect(validateGameDefinition(exported).valid).toBe(true);
        // Untouched export hashes identically to the original definition.
        expect(computeGameDefinitionChecksum(exported)).toBe(originalChecksum);

        // Editing name on the exported JSON retains the original game key.
        exported.name = "Paris Summer Finale";
        expect(resolveGameDefinitionId(exported)).toBe("paris-15-08");

        // Input object is not mutated.
        expect(original.id).toBeUndefined();
    });

    it("derives the id when permanentId is omitted and uses explicit permanentId when provided", () => {
        const original = sampleDefinition();

        const derived = JSON.parse(
            formatGameExportJson(original),
        ) as GameDefinition;
        expect(derived.id).toBe("paris-15-08");

        const explicit = JSON.parse(
            formatGameExportJson(original, "paris-legacy-key"),
        ) as GameDefinition;
        expect(explicit.id).toBe("paris-legacy-key");
    });

    it("places id directly after $schema when $schema is present", () => {
        const original = {
            $schema: GAME_DEFINITION_SCHEMA_URL,
            ...sampleDefinition(),
        };

        const exported = JSON.parse(
            formatGameExportJson(original, "paris-15-08"),
        ) as GameDefinition;

        expect(Object.keys(exported).slice(0, 3)).toEqual([
            "$schema",
            "id",
            "name",
        ]);
        expect(exported.$schema).toBe(GAME_DEFINITION_SCHEMA_URL);
        expect(exported.id).toBe("paris-15-08");
    });

    it("handles an explicit undefined id property without losing the materialized id", () => {
        const original = sampleDefinition({ id: undefined });

        const exported = JSON.parse(
            formatGameExportJson(original, "paris-15-08"),
        ) as GameDefinition;

        expect(exported.id).toBe("paris-15-08");
    });

    it("preserves a definition that already has an id unchanged", () => {
        // Keep `name` before `id` to confirm key order and value stay untouched.
        const withExplicitId: GameDefinition = {
            ...sampleDefinition(),
            id: "custom-paris-id",
        };
        expect(Object.keys(withExplicitId)[0]).toBe("name");

        expect(formatGameExportJson(withExplicitId, "other-key")).toBe(
            formatGameDefinitionJson(withExplicitId),
        );
        expect(
            JSON.parse(formatGameExportJson(withExplicitId, "other-key")).id,
        ).toBe("custom-paris-id");
    });
});
