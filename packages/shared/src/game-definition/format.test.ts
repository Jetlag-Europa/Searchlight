import { describe, expect, it } from "vitest";
import { formatGameDefinitionJson } from "./format.js";
import type { GameDefinition } from "./schema.js";

/** A ring of `n` corners around a point, with full 6-decimal coordinates. */
function ring(lng: number, lat: number, n: number): [number, number][] {
  const corners = Array.from({ length: n }, (_, i): [number, number] => {
    const a = (2 * Math.PI * i) / n;
    return [+(lng + 0.01 * Math.cos(a)).toFixed(6), +(lat + 0.01 * Math.sin(a)).toFixed(6)];
  });
  return [...corners, corners[0]];
}

/** A game whose size is mostly region boundaries, like an imported one. */
function polygonGame(): GameDefinition {
  const region = (i: number) => ({
    type: "Feature" as const,
    id: `region-${i}`,
    properties: { name: `Region ${i}` },
    geometry:
      i % 2
        ? { type: "Polygon" as const, coordinates: [ring(4 + i * 0.03, 52, 200)] }
        : {
            type: "MultiPolygon" as const,
            coordinates: [[ring(4 + i * 0.03, 52, 150)], [ring(4 + i * 0.03, 52.1, 50)]],
          },
  });
  return {
    id: "polygons-2026",
    name: "Polygons 2026",
    serverId: "1190673594649415730",
    map: {
      center: [4.3, 52.05],
      bounds: [3.9, 51.9, 4.7, 52.2],
      playArea: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring(4.3, 52.05, 500)] } }],
      },
    },
    hidingZones: {
      radius: 400,
      features: {
        type: "FeatureCollection",
        features: Array.from({ length: 30 }, (_, i) => ({
          type: "Feature" as const,
          properties: { name: `Station ${i}` },
          geometry: { type: "Point" as const, coordinates: [4 + i * 0.01, 52.05] },
        })),
      },
    },
    radars: [400],
    thermometer: true,
    features: [
      { name: "Municipality", enabledFor: ["matching"], noOverlaps: true, data: { type: "FeatureCollection", features: Array.from({ length: 20 }, (_, i) => region(i)) } },
    ],
  };
}

describe("formatGameDefinitionJson", () => {
  it("round-trips a game with polygon layers at about compact JSON's size", () => {
    const game = polygonGame();
    const text = formatGameDefinitionJson(game);
    expect(JSON.parse(text)).toEqual(game);
    // Byte for byte what compact JSON would give, once parsed.
    expect(JSON.stringify(JSON.parse(text))).toBe(JSON.stringify(game));
    const compact = JSON.stringify(game).length;
    expect(text.length).toBeLessThan(compact * 1.1);
    expect(JSON.stringify(game, null, 2).length).toBeGreaterThan(compact * 3);
  });

  it("indents the structure and puts each coordinates array on one line", () => {
    const text = formatGameDefinitionJson({
      map: { center: [4.3, 52.05] },
      geometry: { type: "LineString", coordinates: [[4, 52], [4.1, 52.1]] },
    });
    expect(text).toBe(
      [
        "{",
        '  "map": {',
        '    "center": [',
        "      4.3,",
        "      52.05",
        "    ]",
        "  },",
        '  "geometry": {',
        '    "type": "LineString",',
        '    "coordinates": [[4,52],[4.1,52.1]]',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("takes the indent to use", () => {
    expect(formatGameDefinitionJson({ a: { coordinates: [1, 2] } }, "\t")).toBe(
      '{\n\t"a": {\n\t\t"coordinates": [1,2]\n\t}\n}\n',
    );
  });

  it("leaves coordinates that aren't positions as they are", () => {
    const odd = {
      properties: { coordinates: "52.1 N, 4.3 E" },
      geometry: { coordinates: [["a", 1]] },
      // An array that turns into something else when serialized.
      line: { coordinates: [Object.assign([1, 2], { toJSON: () => ({ a: 1 }) })] },
    };
    const text = formatGameDefinitionJson(odd);
    expect(text).toBe(`${JSON.stringify(odd, null, 2)}\n`);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(odd)));
    expect(formatGameDefinitionJson({ empty: { coordinates: [] } })).toBe('{\n  "empty": {\n    "coordinates": []\n  }\n}\n');
  });

  it("indents in full a game whose text holds a NUL, in a key or a value", () => {
    for (const odd of [
      { "\u0000[1]\u0000": 1, geometry: { coordinates: [1, 2] } },
      { note: "\u0000[1,2]\u0000", geometry: { coordinates: [1, 2] } },
      { note: new String("\u0000[1]\u0000"), geometry: { coordinates: [1, 2] } },
    ]) {
      const text = formatGameDefinitionJson(odd);
      expect(text).toBe(`${JSON.stringify(odd, null, 2)}\n`);
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(odd)));
    }
  });
});
