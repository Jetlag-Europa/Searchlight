import { readFileSync } from "node:fs";

import type { GameDefinition } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addStroke,
  clearAllStrokes,
  removeStrokes,
  strokes,
} from "@/annotations/hooks/useAnnotationStore";
import type { StrokeFeature } from "@/annotations/types";
import { activeSessionId, activeSessionRole } from "@/lib/activeSession";
import { activeLocalSession, boardMode } from "@/lib/boardMode";
import { applyLocalGameDefinition, clearLocalGame, currentGameId } from "@/lib/games";

const parisFixture: GameDefinition = JSON.parse(
  readFileSync(new URL("./fixtures/games/paris-2026.game.json", import.meta.url), "utf8"),
);

const sampleStroke: StrokeFeature = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [2.35, 48.85],
      [2.36, 48.86],
    ],
  },
  properties: {
    clientUuid: "stroke-local-1",
    color: "#ef4444",
    widthMeters: 15,
    tool: "pen",
    createdAt: 1,
  },
};

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeMemoryStorage());
  vi.stubGlobal("sessionStorage", makeMemoryStorage());
  boardMode.set("local");
  activeSessionRole.set("creator");
  activeSessionId.set("local:session-1");
  strokes.set([]);
});

afterEach(() => {
  boardMode.set("online");
  activeLocalSession.set(null);
  activeSessionId.set("");
  activeSessionRole.set(null);
  strokes.set([]);
  clearLocalGame();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local board isolation", () => {
  it("annotation mutations never touch the server or offline queue in local mode", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    addStroke(sampleStroke);
    expect(strokes.get()).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    removeStrokes((s) => s.properties.clientUuid === "stroke-local-1");
    expect(strokes.get()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    addStroke(sampleStroke);
    clearAllStrokes();
    expect(strokes.get()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // No pending event queue keys written for the local session.
    expect(localStorage.length).toBe(0);
  });

  it("applyLocalGameDefinition and clearLocalGame never touch online game storage keys", () => {
    sessionStorage.setItem("taibled-current-game-id", "online-game-1");
    localStorage.setItem("boardGameId", "online-game-1");

    applyLocalGameDefinition("local:paris", parisFixture);
    expect(currentGameId.get()).toBe("local:paris");

    clearLocalGame();
    expect(currentGameId.get()).toBe("");

    expect(sessionStorage.getItem("taibled-current-game-id")).toBe("online-game-1");
    expect(localStorage.getItem("boardGameId")).toBe("online-game-1");
  });

  it("opening /local uses isolated keys for permanentOverlay and zone display settings", async () => {
    localStorage.setItem(
      "permanentOverlay",
      JSON.stringify({ type: "FeatureCollection", features: [] }),
    );
    localStorage.setItem("displayHidingZones", "false");
    localStorage.setItem("displayHidingZonesStyle", "clusters");

    vi.stubGlobal("window", { location: { pathname: "/local" } });
    vi.resetModules();

    const gamesMod = await import("@/lib/games");
    gamesMod.applyLocalGameDefinition("local:paris", parisFixture);
    gamesMod.clearLocalGame();

    // Online map's saved overlay & zone display settings are untouched.
    expect(localStorage.getItem("permanentOverlay")).toBe(
      JSON.stringify({ type: "FeatureCollection", features: [] }),
    );
    expect(localStorage.getItem("displayHidingZones")).toBe("false");
    expect(localStorage.getItem("displayHidingZonesStyle")).toBe("clusters");
  });
});
