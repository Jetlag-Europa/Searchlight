import type { GameDefinition } from "@searchlight/shared";
import { describe, expect, it } from "vitest";

import { compileGameDefinition } from "@/game-definition/compile";

const zone = (id: string, properties: Record<string, unknown>) => ({
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [10, 50] },
    properties: { name: id, ...properties },
});

describe("hiding zone tiers", () => {
    it("reads numeric tiers as the string keys of tierOverrides", () => {
        const compiled = compileGameDefinition({
            id: "tiers",
            name: "Tiers",
            serverId: "home-games",
            map: {
                center: [10, 50],
                playArea: { type: "FeatureCollection", features: [] },
            },
            hidingZones: {
                radius: 400,
                unit: "meters",
                tierOverrides: { "1": 700 },
                features: {
                    type: "FeatureCollection",
                    features: [
                        zone("numeric", { tier: 1 }),
                        zone("text", { tier: "1" }),
                        zone("untiered", {}),
                    ],
                },
            },
        } as unknown as GameDefinition);

        expect(
            compiled.hidingZones.stations?.map((s) => [
                s.tier,
                s.radius.value,
            ]),
        ).toEqual([
            ["1", 700],
            ["1", 700],
            [undefined, 400],
        ]);
    });
});
