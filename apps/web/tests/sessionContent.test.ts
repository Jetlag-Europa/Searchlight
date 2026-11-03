import { afterEach, expect, it, vi } from "vitest";
import { strokes } from "@/annotations/hooks/useAnnotationStore";
import type { StrokeFeature } from "@/annotations/types";
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
                            : url.endsWith("/sessions/old-session")
                              ? {
                                    id: "old-session",
                                    name: "Old",
                                    gameId: "game-1",
                                    gameRevisionId: "revision-1",
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

// A load still running in a tab another one took over (see tabLock) keeps
// nothing: the copy is the other tab's now, and newer (audit review of #B).
it("a load that ends after another tab took the session over keeps nothing", async () => {
    const { editingInOtherTab } = await import("@/lib/activeSession");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    const theirs = JSON.stringify({ sessionId: "s1", serverQuestions: { sequence: 7, questions: [] } });
    store.set("taibled-cache-s1", theirs);
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            await answered;
            return Response.json(
                url.endsWith("/strokes")
                    ? { strokes: [] }
                    : url.endsWith("/cursor")
                      ? { sequence: 2 }
                      : url.endsWith("/sessions/s1")
                        ? { id: "s1", name: "S", gameId: "g", gameRevisionId: "r" }
                        : { questions: [], sequence: 2 },
            );
        }),
    );
    const load = loadSessionContent("s1", "verified-user");
    editingInOtherTab.set(true);
    answer();
    await expect(load).rejects.toThrow();
    expect(store.get("taibled-cache-s1")).toBe(theirs);
    editingInOtherTab.set(false);
});
