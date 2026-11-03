import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionUnavailableStatus } from "@/lib/sessionUnavailable";

import {
    forbidden,
    plainTextNotFound,
    routeNotFound,
    SESSION_NOT_FOUND_BODY,
    sessionNotFound,
} from "./apiResponses";

describe("sessionUnavailableStatus", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("takes the API's 404 for the session as it being gone", async () => {
        expect(await sessionUnavailableStatus(sessionNotFound())).toBe(404);
    });

    // A build the PWA cached, or a rolled-back API, asked for a route the
    // running API doesn't have.
    it("doesn't take the API's 404 for a route it doesn't have", async () => {
        expect(
            await sessionUnavailableStatus(
                routeNotFound("GET", "/sessions/s1/events/cursor"),
            ),
        ).toBeNull();
    });

    it("doesn't take a plain-text 404", async () => {
        expect(await sessionUnavailableStatus(plainTextNotFound())).toBeNull();
    });

    it.each([
        ["an empty object", {}],
        ["an array", [SESSION_NOT_FOUND_BODY]],
        ["another message", { statusCode: 404, message: "Not Found" }],
    ])("doesn't take a JSON 404 with %s", async (_, body) => {
        expect(
            await sessionUnavailableStatus(
                Response.json(body, { status: 404 }),
            ),
        ).toBeNull();
    });

    it("takes a 403 as lost access", async () => {
        expect(await sessionUnavailableStatus(forbidden())).toBe(403);
    });

    it("needs a 403 or 404", async () => {
        expect(
            await sessionUnavailableStatus(
                Response.json(
                    {
                        statusCode: 500,
                        error: "Internal Server Error",
                        message: "Internal Server Error",
                    },
                    { status: 500 },
                ),
            ),
        ).toBeNull();
    });

    it("leaves the body for the caller to read", async () => {
        const res = sessionNotFound();
        await sessionUnavailableStatus(res);
        expect(await res.json()).toEqual(SESSION_NOT_FOUND_BODY);
    });

    // Retries wait on the answer.
    it("gives up on a 404 whose body never ends", async () => {
        vi.useFakeTimers();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode('{"message":"Session'),
                );
            },
        });
        let status: 403 | 404 | null | undefined;
        void sessionUnavailableStatus(new Response(body, { status: 404 })).then(
            (s) => (status = s),
        );
        await vi.advanceTimersByTimeAsync(4999);
        expect(status).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(status).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("clears its timer once the body is read", async () => {
        vi.useFakeTimers();
        expect(await sessionUnavailableStatus(sessionNotFound())).toBe(404);
        expect(vi.getTimerCount()).toBe(0);
    });
});
