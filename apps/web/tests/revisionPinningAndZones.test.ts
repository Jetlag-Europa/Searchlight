import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import {
  applyGameDefinition,
  switchToGame,
  type GameOption,
} from "@/lib/games";
import {
  cacheRevisionDefinition,
  clearDefinitionCache,
  getCachedRevisionDefinition,
} from "@/game-definition/store";
import {
  customStations,
  hidingRadius,
  hidingRadiusUnits,
  tierRadiusOverrides,
  trainStations,
  useCustomStations,
} from "@/lib/context";
import { activeSessionData, setActiveSession, clearActiveSession } from "@/lib/activeSession";
import { normalizeToStationFeatures, parseCustomStationsFromText } from "@/maps/api";
import type { GameDefinition } from "@searchlight/shared";

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
    customStations.set([]);
    useCustomStations.set(false);
    trainStations.set([]);
    hidingRadius.set(400);
    hidingRadiusUnits.set("meters");
    tierRadiusOverrides.set({});
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

      expect(useCustomStations.get()).toBe(true);
      const stations = customStations.get();
      expect(stations).toHaveLength(3);

      // Station 1: explicit radius 800 overrides tier 'major' (600)
      expect(stations[0]).toMatchObject({
        id: "stn-1",
        name: "Station Explicit",
        tier: "major",
        radius: 800,
        unit: "meters",
      });

      // Station 2: tier 'minor', no explicit radius
      expect(stations[1]).toMatchObject({
        id: "stn-2",
        name: "Station Tier Only",
        tier: "minor",
        unit: "meters",
      });
      expect(stations[1].radius).toBeUndefined();

      // Station 3: no tier and no explicit radius
      expect(stations[2]).toMatchObject({
        id: "stn-3",
        name: "Station Default Only",
        unit: "meters",
      });
      expect(stations[2].tier).toBeUndefined();
      expect(stations[2].radius).toBeUndefined();

      // Features normalization preserves properties into GeoJSON features
      const normalized = normalizeToStationFeatures(stations);
      expect(normalized.features[0].properties).toMatchObject({
        id: "stn-1",
        tier: "major",
        radius: 800,
      });
      expect(normalized.features[1].properties).toMatchObject({
        id: "stn-2",
        tier: "minor",
      });
    });

    it("parses CSV with tier and radius columns", () => {
      const csv = `id,name,lat,lng,tier,radius,unit\ns1,Central,37.7,-122.4,major,750,meters\ns2,Local,37.8,-122.5,minor,300,meters`;
      const stations = parseCustomStationsFromText(csv, "text/csv");
      expect(stations).toHaveLength(2);
      expect(stations[0]).toMatchObject({
        id: "s1",
        name: "Central",
        tier: "major",
        radius: 750,
        unit: "meters",
      });
    });
  });

  describe("Review 10: Clearing stations and mode for nonpoint or empty collections", () => {
    it("clears custom stations and resets mode when switching to a polygon-only game", () => {
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
      expect(useCustomStations.get()).toBe(true);
      expect(customStations.get().length).toBe(1);

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

      applyGameDefinition(polygonGame);
      expect(useCustomStations.get()).toBe(false);
      expect(customStations.get()).toEqual([]);
      expect(trainStations.get()).toEqual([]);
    });

    it("clears stations when switching to an empty station collection", () => {
      // Set active custom stations first
      useCustomStations.set(true);
      customStations.set([{ id: "stale", name: "Stale", lat: 1, lng: 1 }]);
      trainStations.set([]);

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
      expect(useCustomStations.get()).toBe(false);
      expect(customStations.get()).toEqual([]);
      expect(trainStations.get()).toEqual([]);
    });
  });

  describe("Review 5: Revision pinning in loading, caching, and upgrading", () => {
    it("R1 restore after R2 import loads R1 instead of R2", async () => {
      const gameDef: GameOption = {
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
      expect(hidingRadius.get()).toBe(300);
    });

    it("live upgrade loads R2 even when R1 was previously cached", async () => {
      const gameDef: GameOption = {
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
      expect(hidingRadius.get()).toBe(550);
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain("sessionId=sess-upgrade");
    });

    it("pinned fetch failure does not fall back to mutable export or load current", async () => {
      const gameDef: GameOption = {
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
      expect(hidingRadius.get()).not.toBe(999);
      // Verify export was never queried
      const exportCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("/export"));
      expect(exportCalls).toHaveLength(0);
    });

    it("isolates two games sharing the same revision ID in cache", async () => {
      const gameDef1: GameOption = {
        id: "game-one",
        gameKey: "game-one",
        label: "Game One",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };

      const gameDef2: GameOption = {
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
      expect(hidingRadius.get()).toBe(350);

      // Retrieve revision 1 for game-two
      const loaded2 = await switchToGame(gameDef2, { revisionId: "rev-1-uuid", sessionId: "sess-2" });
      expect(loaded2).toBe(true);
      expect(hidingRadius.get()).toBe(700);

      // Switch back to game-one revision 1 and verify it was not corrupted by game-two
      const reloaded1 = await switchToGame(gameDef1, { revisionId: "rev-1-uuid", sessionId: "sess-1" });
      expect(reloaded1).toBe(true);
      expect(hidingRadius.get()).toBe(350);
    });

    it("refuses to load an unpinned session game without falling back to current export", async () => {
      const gameDef: GameOption = {
        id: "game-unpinned",
        gameKey: "game-unpinned",
        label: "Game Unpinned",
        serverId: "srv-1",
        serverName: "Server 1",
        size: "medium",
      };
      const loaded = await switchToGame(gameDef, { sessionId: "sess-unpinned" });
      expect(loaded).toBe(false);
    });
  });
});
