import * as turf from "@turf/turf";
import type { Polygon } from "geojson";
import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { applyGameDefinition, switchToGame } from "@/lib/games";
import {
  cacheRevisionDefinition,
  clearDefinitionCache,
  compiledGameAtom,
} from "@/game-definition/store";
import { trainStations } from "@/lib/context";
import { clearActiveSession } from "@/lib/activeSession";
import { hidingZoneCircles } from "@/maps/geo-utils";
import type { GameDefinition } from "@searchlight/shared";

/** The game-wide hiding radius of the applied definition. */
const appliedRadius = () => compiledGameAtom.get()?.hidingZones.baseRadius.value;
/** The applied game's zones, as the zone sidebar draws them. */
const zones = () => hidingZoneCircles(compiledGameAtom.get()!);
/** A circular zone's radius in metres: its centre to its first vertex. */
const radiusOf = (zone: ReturnType<typeof zones>[number]) =>
  turf.distance(zone.properties, (zone.geometry as Polygon).coordinates[0][0], {
    units: "meters",
  });

describe("Review 5, 9, 10: Revision Pinning, Cache, and Zone Station Precedence", () => {
  const sessionStore = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => { sessionStore.set(k, v); },
    removeItem: (k: string) => { sessionStore.delete(k); },
    clear: () => { sessionStore.clear(); },
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    sessionStore.clear();
    clearDefinitionCache();
    clearActiveSession();
    trainStations.set([]);
    vi.restoreAllMocks();
  });

  describe("Review 9: Station normalization and radius precedence", () => {
    it("preserves explicit per-station radius, unit, and tier through applyGameDefinition", () => {
      const def: GameDefinition = {
        name: "Test Game",
        serverId: "srv-1",
        map: {
          center: [0, 0],
          playArea: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                },
                properties: {},
              },
            ],
          },
        },
        hidingZones: {
          radius: 400,
          unit: "meters",
          tierOverrides: {
            major: 600,
            minor: 250,
          },
          features: {
            type: "FeatureCollection",
            features: [
              {
                id: "stn-1",
                type: "Feature",
                geometry: { type: "Point", coordinates: [0.1, 0.1] },
                properties: { name: "Station Explicit", radius: 800, tier: "major" },
              },
              {
                id: "stn-2",
                type: "Feature",
                geometry: { type: "Point", coordinates: [0.2, 0.2] },
                properties: { name: "Station Tier Only", tier: "minor" },
              },
              {
                id: "stn-3",
                type: "Feature",
                geometry: { type: "Point", coordinates: [0.3, 0.3] },
                properties: { name: "Station Default Only" },
              },
            ],
          },
        },
      };

      applyGameDefinition(def);

      const [explicit, tierOnly, defaultOnly] = zones();
      expect(zones()).toHaveLength(3);
      expect(explicit.properties.properties).toEqual({
        id: "stn-1",
        name: "Station Explicit",
        tier: "major",
      });
      expect(tierOnly.properties.properties).toEqual({
        id: "stn-2",
        name: "Station Tier Only",
        tier: "minor",
      });
      expect(defaultOnly.properties.properties).toEqual({
        id: "stn-3",
        name: "Station Default Only",
      });

      // Station 1: explicit radius 800 overrides tier 'major' (600)
      expect(radiusOf(explicit)).toBeCloseTo(800, 0);
      // Station 2: tier 'minor', no explicit radius
      expect(radiusOf(tierOnly)).toBeCloseTo(250, 0);
      // Station 3: no tier and no explicit radius
      expect(radiusOf(defaultOnly)).toBeCloseTo(400, 0);
    });

    it("draws a zone with its own radius and unit", () => {
      applyGameDefinition({
        name: "Unit Game",
        serverId: "srv-1",
        unit: "meters",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: {
          radius: 400,
          features: {
            type: "FeatureCollection",
            features: [
              {
                id: "km",
                type: "Feature",
                geometry: { type: "Point", coordinates: [0.1, 0.1] },
                properties: { name: "Kilometres", radius: { value: 1.5, unit: "kilometers" } },
              },
            ],
          },
        },
      });
      expect(radiusOf(zones()[0])).toBeCloseTo(1500, 0);
    });
  });

  describe("Review 10: Zones of polygon and empty collections", () => {
    it("draws a polygon-only game's zones as their polygons", () => {
      // First, set up a game with point stations
      const pointGame: GameDefinition = {
        name: "Point Game",
        serverId: "srv-1",
        map: {
          center: [0, 0],
          playArea: {
            type: "FeatureCollection",
            features: [],
          },
        },
        hidingZones: {
          radius: 300,
          unit: "meters",
          features: {
            type: "FeatureCollection",
            features: [
              {
                id: "p1",
                type: "Feature",
                geometry: { type: "Point", coordinates: [10, 20] },
                properties: { name: "Point Station" },
              },
            ],
          },
        },
      };
      applyGameDefinition(pointGame);
      expect(zones()).toHaveLength(1);

      // Now apply a polygon-only game
      const polygonGame: GameDefinition = {
        name: "Polygon Game",
        serverId: "srv-1",
        map: {
          center: [0, 0],
          playArea: {
            type: "FeatureCollection",
            features: [],
          },
        },
        hidingZones: {
          radius: 500,
          unit: "meters",
          features: {
            type: "FeatureCollection",
            features: [
              {
                id: "poly1",
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                },
                properties: { name: "Polygon Zone" },
              },
            ],
          },
        },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      applyGameDefinition(polygonGame);
      expect(trainStations.get()).toEqual([]);
      const [zone] = zones();
      expect(zones()).toHaveLength(1);
      expect(zone.geometry).toEqual(polygonGame.hidingZones.features.features[0].geometry);
      expect(zone.properties.properties).toEqual({ id: "poly1", name: "Polygon Zone" });
      // Its station is a point inside the polygon.
      expect(turf.booleanPointInPolygon(zone.properties, zone as never)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("clears stations when switching to an empty station collection", () => {
      applyGameDefinition({
        name: "Stale Game",
        serverId: "srv-1",
        map: { center: [1, 1], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: {
          features: {
            type: "FeatureCollection",
            features: [
              { type: "Feature", geometry: { type: "Point", coordinates: [1, 1] }, properties: { name: "Stale" } },
            ],
          },
        },
      });
      trainStations.set(zones());

      const emptyGame: GameDefinition = {
        name: "Empty Game",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: {
          radius: 400,
          unit: "meters",
          features: { type: "FeatureCollection", features: [] },
        },
      };

      applyGameDefinition(emptyGame);
      expect(zones()).toEqual([]);
      expect(trainStations.get()).toEqual([]);
    });
  });

  describe("Review 5: Revision pinning in loading, caching, and upgrading", () => {
    it("R1 restore after R2 import loads R1 instead of R2", async () => {
      const gameDef = {
        id: "game-abc",
        gameKey: "game-abc",
        label: "Game ABC",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const defR1: GameDefinition = {
        id: "game-abc",
        revision: 1,
        name: "Game ABC Revision 1",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 300, features: { type: "FeatureCollection", features: [] } },
      };

      const defR2: GameDefinition = {
        id: "game-abc",
        revision: 2,
        name: "Game ABC Revision 2",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 600, features: { type: "FeatureCollection", features: [] } },
      };

      // R1 is cached under revision "rev-1-uuid"
      cacheRevisionDefinition("game-abc", "rev-1-uuid", defR1, "sess-1");
      // R2 is imported and cached under its own revision
      cacheRevisionDefinition("game-abc", "rev-2-uuid", defR2);

      // Now restore an R1 session pinned to "rev-1-uuid"
      const loaded = await switchToGame(gameDef, {
        revisionId: "rev-1-uuid",
        sessionId: "sess-1",
      });

      expect(loaded).toBe(true);
      // Verify R1 (radius 300) was applied, NOT R2 (radius 600)
      expect(appliedRadius()).toBe(300);
    });

    it("live upgrade loads R2 even when R1 was previously cached", async () => {
      const gameDef = {
        id: "game-xyz",
        gameKey: "game-xyz",
        label: "Game XYZ",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const defR1: GameDefinition = {
        id: "game-xyz",
        revision: 1,
        name: "Game XYZ Rev 1",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 250, features: { type: "FeatureCollection", features: [] } },
      };

      const defR2: GameDefinition = {
        id: "game-xyz",
        revision: 2,
        name: "Game XYZ Rev 2",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 550, features: { type: "FeatureCollection", features: [] } },
      };

      // Tab initially has R1 loaded and cached
      cacheRevisionDefinition("game-xyz", "rev-1-uuid", defR1, "sess-upgrade");

      // Mock API returning R2 when queried for revision 2 / "rev-2-uuid"
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("revisions/rev-2-uuid") || urlStr.includes("revisions/2")) {
          return new Response(JSON.stringify(defR2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(defR1), { status: 200 });
      });

      // Execute live upgrade
      const upgraded = await switchToGame(gameDef, {
        revisionId: "rev-2-uuid",
        sessionId: "sess-upgrade",
      });

      expect(upgraded).toBe(true);
      expect(appliedRadius()).toBe(550);
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("sessionId=sess-upgrade");
    });

    it("pinned fetch failure does not fall back to mutable export or load current", async () => {
      const gameDef = {
        id: "game-pinned-fail",
        gameKey: "game-pinned-fail",
        label: "Game Fail",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const mutableCurrent: GameDefinition = {
        name: "Mutable Current R2",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 999, features: { type: "FeatureCollection", features: [] } },
      };

      // API spy: revisions endpoint fails with 404, export endpoint returns mutableCurrent
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/revisions/")) {
          return new Response(JSON.stringify({ error: "Revision not found" }), { status: 404 });
        }
        if (urlStr.includes("/export")) {
          return new Response(JSON.stringify(mutableCurrent), { status: 200 });
        }
        return new Response(null, { status: 500 });
      });

      // Attempt to load pinned revision
      const result = await switchToGame(gameDef, {
        revisionId: "missing-rev-uuid",
        sessionId: "sess-fail",
      });

      // Must return false and NOT load mutableCurrent (radius 999)
      expect(result).toBe(false);
      expect(appliedRadius()).not.toBe(999);
      // Verify export was never queried
      const exportCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/export"));
      expect(exportCalls).toHaveLength(0);
    });

    it("isolates two games sharing the same revision ID in cache", async () => {
      const gameDef1 = {
        id: "game-one",
        gameKey: "game-one",
        label: "Game One",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const gameDef2 = {
        id: "game-two",
        gameKey: "game-two",
        label: "Game Two",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const defGame1R1: GameDefinition = {
        name: "Game One Rev 1",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 350, features: { type: "FeatureCollection", features: [] } },
      };

      const defGame2R1: GameDefinition = {
        name: "Game Two Rev 1",
        serverId: "srv-1",
        map: { center: [0, 0], playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: { radius: 700, features: { type: "FeatureCollection", features: [] } },
      };

      // Cache revision 1 for game-one and game-two separately
      cacheRevisionDefinition("game-one", "rev-1-uuid", defGame1R1, "sess-1");
      cacheRevisionDefinition("game-two", "rev-1-uuid", defGame2R1, "sess-2");

      // Retrieve revision 1 for game-one
      const loaded1 = await switchToGame(gameDef1, { revisionId: "rev-1-uuid", sessionId: "sess-1" });
      expect(loaded1).toBe(true);
      expect(appliedRadius()).toBe(350);

      // Retrieve revision 1 for game-two
      const loaded2 = await switchToGame(gameDef2, { revisionId: "rev-1-uuid", sessionId: "sess-2" });
      expect(loaded2).toBe(true);
      expect(appliedRadius()).toBe(700);

      // Switch back to game-one revision 1 and verify it was not corrupted by game-two
      const reloaded1 = await switchToGame(gameDef1, { revisionId: "rev-1-uuid", sessionId: "sess-1" });
      expect(reloaded1).toBe(true);
      expect(appliedRadius()).toBe(350);
    });
  });
});
