import type { GameSessionSummary } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PROBE_TIMEOUT_MS, probeSession } from "@/lib/sessionProbe";

import {
    forbidden,
    notTheSession,
    routeNotFound,
    sessionNotFound,
} from "./apiResponses";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const SID = "probe-session";
const BASE = `http://localhost:3001/sessions/${SID}`;
const session = {
    id: SID,
    name: "Team B",
    gameId: "game-1",
    gameRevisionId: "revision-1",
    role: "member",
} as GameSessionSummary;

// Each read answered as given, else as the API does when all is well.
function answer(overrides: Record<string, () => Response | Promise<never>>) {
    mockFetch.mockImplementation(async (url: string) => {
        const path = url.slice(BASE.length);
        if (overrides[path]) return overrides[path]();
        if (path === "") return Response.json(session);
        if (path === "/strokes") return Response.json({ strokes: [] });
        if (path === "/questions")
            return Response.json({ questions: [], sequence: 3 });
        return routeNotFound("GET", url);
    });
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("probeSession", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    test("is ready when the session and its content answer", async () => {
        answer({});
        expect(await probeSession(SID)).toEqual({ kind: "ready", session });
        expect(mockFetch.mock.calls.map(([url]) => url).sort()).toEqual([
            BASE,
            `${BASE}/questions`,
            `${BASE}/strokes`,
        ]);
        // Only reads.
        for (const [, init] of mockFetch.mock.calls) {
            expect(init).toEqual({
                credentials: "include",
                signal: expect.any(AbortSignal),
            });
        }
    });

    test.each([
        [404, sessionNotFound],
        [403, forbidden],
    ] as const)(
        "says the session is unavailable on its %i",
        async (status, res) => {
            answer({ "": res });
            expect(await probeSession(SID)).toEqual({
                kind: "unavailable",
                status,
            });
            expect(mockFetch).toHaveBeenCalledTimes(1);
        },
    );

    test.each(["strokes", "questions"])(
        "says the user is signed out when its %s answer 401",
        async (part) => {
            answer({ [`/${part}`]: () => new Response(null, { status: 401 }) });
            expect(await probeSession(SID)).toEqual({ kind: "signedOut" });
        },
    );

    test.each([
        ["strokes", "questions"],
        ["questions", "strokes"],
    ])(
        "says the user is signed out when its %s answer 401 and its %s can't be reached",
        async (signedOut, unreachable) => {
            answer({
                [`/${signedOut}`]: () => new Response(null, { status: 401 }),
                [`/${unreachable}`]: offline,
            });
            expect(await probeSession(SID)).toEqual({ kind: "signedOut" });
        },
    );

    test("says the user is signed out on a 401", async () => {
        answer({ "": () => new Response(null, { status: 401 }) });
        expect(await probeSession(SID)).toEqual({ kind: "signedOut" });
    });

    test.each([
        ...notTheSession,
        ["a 503", () => new Response(null, { status: 503 })],
        ["unreadable details", () => new Response("<html>", { status: 200 })],
        ["no details", () => Response.json(null)],
        [
            "another session's details",
            () => Response.json({ ...session, id: "other" }),
        ],
        [
            "details without a game",
            () => Response.json({ ...session, gameId: undefined }),
        ],
    ])("retries when the session answers with %s", async (_, res) => {
        answer({ "": res });
        expect(await probeSession(SID)).toEqual({ kind: "retry" });
    });

    test("retries without a network", async () => {
        answer({ "": offline });
        expect(await probeSession(SID)).toEqual({ kind: "retry" });
    });

    // The session answers but a load would still fail.
    test.each([
        ["strokes", "a 503", () => new Response(null, { status: 503 })],
        ["questions", "a route-not-found 404", () => routeNotFound()],
        ["strokes", "the session's 404", sessionNotFound],
        ["questions", "no network", offline],
        [
            "strokes",
            "a page that isn't JSON",
            () =>
                new Response("<html>", {
                    status: 200,
                    headers: { "content-type": "text/html" },
                }),
        ],
        [
            "strokes",
            "JSON cut short",
            () =>
                new Response('{"strokes":[{"clientUuid"', {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        ],
        ["questions", "no list", () => Response.json({ questions: null })],
        ["strokes", "no list", () => Response.json({ strokes: {} })],
        [
            "questions",
            "a list with a gap",
            () => Response.json({ questions: [null] }),
        ],
    ])("retries when its %s answer with %s", async (part, _, res) => {
        answer({ [`/${part}`]: res });
        expect(await probeSession(SID)).toEqual({ kind: "retry" });
    });

    // The load skips them (see loadStrokesFromServer): retrying wouldn't help.
    test("is ready when some strokes are malformed", async () => {
        answer({
            "/strokes": () =>
                Response.json({
                    strokes: [null, { payloadJson: "x" }, { payloadJson: {} }],
                }),
        });
        expect(await probeSession(SID)).toEqual({ kind: "ready", session });
    });

    describe("on a request that hangs", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        test("gives up after the timeout and retries", async () => {
            answer({});
            mockFetch.mockImplementation(
                (_url: string, init: RequestInit) =>
                    new Promise((_, reject) => {
                        init.signal?.addEventListener("abort", () =>
                            reject(new DOMException("Aborted", "AbortError")),
                        );
                    }),
            );
            let result: unknown;
            void probeSession(SID).then((probe) => (result = probe));
            await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
            expect(result).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);
            expect(result).toEqual({ kind: "retry" });
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
