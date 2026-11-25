import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compiledGameAtom, setActiveGameDefinition } from "@/game-definition/store";
import { hiderMode, questions } from "@/lib/context";
import { nameLength, ruledOutZones, STATION_NAME_LENGTH } from "@/lib/stationNameLength";
import { hiderifyMatching } from "@/maps/questions/matching";

afterEach(() => {
  questions.set([]);
  hiderMode.set(false);
  setActiveGameDefinition(null);
});

const game = () => {
  setActiveGameDefinition(
    JSON.parse(readFileSync(resolve("tests/fixtures/games/south-limburg-2026.game.json"), "utf8")),
  );
  return compiledGameAtom.get()!.hidingZones.stations!;
};

describe("station name length", () => {
  it("rules out the zones whose names don't fit the answer, once answered", () => {
    const zones = game();
    const [lng, lat] = zones[0].coordinates;
    const length = nameLength(zones[0].name);
    const data: any = { type: STATION_NAME_LENGTH, lat, lng, drag: true };
    questions.set([{ id: "matching", key: 1, data }]);
    expect(ruledOutZones.get()).toEqual([]);

    questions.set([{ id: "matching", key: 1, data: { ...data, same: true } }]);
    const sameLength = zones.filter((zone) => nameLength(zone.name) === length);
    expect(sameLength.length).toBeGreaterThan(0);
    expect(ruledOutZones.get()).toHaveLength(zones.length - sameLength.length);
    expect(ruledOutZones.get()).not.toContain(String(zones[0].id));
  });

  it("is answered in hider mode from the zone nearest the hider", async () => {
    const zones = game();
    const [lng, lat] = zones[0].coordinates;
    const other = zones.find((zone) => nameLength(zone.name) !== nameLength(zones[0].name))!;
    const question: any = { type: STATION_NAME_LENGTH, lat, lng, drag: true };
    hiderMode.set({ latitude: other.coordinates[1], longitude: other.coordinates[0] });
    expect((await hiderifyMatching(question)).same).toBe(false);
    hiderMode.set({ latitude: lat, longitude: lng });
    expect((await hiderifyMatching(question)).same).toBe(true);
  });
});
