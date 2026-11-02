import { afterEach, expect, it, vi } from "vitest";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import type { StrokeFeature } from "@/annotations/types";
import { getCachedSession } from "@/lib/eventQueue";
import { loadSessionContent } from "@/lib/sessionState";

const activeStroke: StrokeFeature = {
    type: "Feature",
    geometry: {
        type: "LineString",
        coordinates: [
            [0, 0],
            [1, 1],
        ],
    },
    properties: {
        tool: "pen",
        color: "#000000",
        widthMeters: 3,
        createdAt: 0,
        clientUuid: "active",
    },
};

afterEach(() => {
    strokes.set([]);
    vi.unstubAllGlobals();
});

it("loading another session cannot replace the active annotations before the caller accepts it", async () => {
    vi.stubGlobal("localStorage", {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
    });
    const oldStroke = {
        ...activeStroke,
        properties: { ...activeStroke.properties, clientUuid: "old-session" },
    };
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (url: string) =>
                new Response(
                    JSON.stringify(
                        url.endsWith("/strokes")
                            ? {
                                  strokes: [
                                      {
                                          clientUuid: "old-session",
                                          payloadJson: oldStroke,
                                      },
                                  ],
                              }
                            : { questions: [] },
                    ),
                    { status: 200 },
                ),
        ),
    );
    strokes.set([activeStroke]);
    const loaded = await loadSessionContent("old-session", "verified-user");
    expect(loaded.strokes).toEqual([oldStroke]);
    expect(strokes.get()).toEqual([activeStroke]);
});

it("caches the session's name, to say which one was deleted on the next load", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
            store.set(k, v);
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (url: string) =>
                new Response(
                    JSON.stringify(
                        url.endsWith("/events/cursor")
                            ? { sequence: 0 }
                            : url.endsWith("/strokes")
                              ? { strokes: [] }
                              : url.endsWith("/questions")
                                ? { questions: [] }
                                : { id: "team-b", name: "Team B" },
                    ),
                    { status: 200 },
                ),
        ),
    );
    await loadSessionContent("team-b", "verified-user");
    expect(getCachedSession("team-b")?.name).toBe("Team B");
});
