import type { GameSessionSummary } from "@searchlight/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchSessionDetails } from "@/lib/sessionProbe";

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

// The details answered as given, else as the API does when all is well.
function answer(details?: () => Response | Promise<never>) {
    mockFetch.mockImplementation(async (url: string) => {
        if (url !== BASE) return routeNotFound("GET", url);
        return details ? details() : Response.json(session);
    });
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("fetchSessionDetails", () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    // A load reads the content itself.
    test("reads only the session's details", async () => {
        answer();
        expect(await fetchSessionDetails(SID)).toEqual({
            kind: "ready",
            session,
        });
        expect(mockFetch).toHaveBeenCalledExactlyOnceWith(BASE, {
            credentials: "include",
            signal: undefined,
        });
    });

    test.each([
        [404, sessionNotFound],
        [403, forbidden],
    ] as const)(
        "says the session is unavailable on its %i",
        async (status, res) => {
            answer(res);
            expect(await fetchSessionDetails(SID)).toEqual({
                kind: "unavailable",
                status,
            });
        },
    );

    test("says the user is signed out on a 401", async () => {
        answer(() => new Response(null, { status: 401 }));
        expect(await fetchSessionDetails(SID)).toEqual({ kind: "signedOut" });
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
        answer(res);
        expect(await fetchSessionDetails(SID)).toEqual({ kind: "retry" });
    });

    test("retries without a network", async () => {
        answer(offline);
        expect(await fetchSessionDetails(SID)).toEqual({ kind: "retry" });
    });

    test("retries once its signal gives up on the request", async () => {
        mockFetch.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise((_, reject) => {
                    init.signal?.addEventListener("abort", () =>
                        reject(new DOMException("Aborted", "AbortError")),
                    );
                }),
        );
        const controller = new AbortController();
        const details = fetchSessionDetails(SID, controller.signal);
        controller.abort();
        expect(await details).toEqual({ kind: "retry" });
    });
});
