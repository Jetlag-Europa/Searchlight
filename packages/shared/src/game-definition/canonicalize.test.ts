import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  canonicalizePrettyJson,
  computeGameDefinitionChecksum,
  materializeCanonicalDefaults,
} from "./canonicalize.js";
import type { GameDefinition } from "./schema.js";

function getSampleDefinition(): GameDefinition {
  return {
    id: "paris-2026",
    name: "Paris 15-08",
    serverId: "1190673594649415730",
    map: {
      center: [2.35, 48.85],
      playArea: { type: "FeatureCollection", features: [] },
    },
    hidingZones: {
      radius: 400,
      features: { type: "FeatureCollection", features: [] },
    },
    radars: [400, 600],
    thermometer: true,
    features: [
      {
        name: "Museums",
        enabledFor: ["matching", "measuring", "tentacle"],
        data: { type: "FeatureCollection", features: [] },
      },
    ],
  };
}

describe("canonicalize", () => {
  it("sorts object keys recursively and normalizes -0 to 0", () => {
    const objA = { b: 2, a: 1, nested: { y: -0, x: 10 } };
    const objB = { a: 1, nested: { x: 10, y: 0 }, b: 2 };

    const jsonA = canonicalizeJson(objA);
    const jsonB = canonicalizeJson(objB);

    expect(jsonA).toBe(jsonB);
    expect(jsonA).toBe('{"a":1,"b":2,"nested":{"x":10,"y":0}}');
  });

  it("materializes canonical defaults for clean game definition", () => {
    const def = getSampleDefinition();
    expect(def.revision).toBeUndefined();
    expect(def.size).toBeUndefined();

    const materialized = materializeCanonicalDefaults(def);
    expect(materialized.revision).toBe(1);
    expect(materialized.size).toBe("medium");
    expect(materialized.visibility).toEqual({ kind: "server-members" });
    expect(materialized.id).toBe("paris-2026");
    expect("gameId" in materialized).toBe(false);

    const defNoId = getSampleDefinition();
    delete defNoId.id;
    const materializedNoId = materializeCanonicalDefaults(defNoId);
    expect(materializedNoId.id).toBe("paris-15-08");
    expect("gameId" in materializedNoId).toBe(false);
  });

  it("computes identical checksums regardless of initial key ordering", () => {
    const defA = getSampleDefinition();
    const defB = {} as Record<string, unknown>;
    for (const key of Object.keys(defA).reverse()) {
      defB[key] = (defA as unknown as Record<string, unknown>)[key];
    }

    const hashA = computeGameDefinitionChecksum(defA);
    const hashB = computeGameDefinitionChecksum(defB as unknown as GameDefinition);

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it("pretty format has the same logical canonical representation", () => {
    const def = getSampleDefinition();
    const pretty = canonicalizePrettyJson(def);
    const compact = canonicalizeJson(def);

    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact));
  });
});
