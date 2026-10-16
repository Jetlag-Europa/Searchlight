import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { overpassFetch } from "../lib/overpass.js";
import { boundQuerySettings, overpassRoutes } from "./overpass.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-overpass-route-user";
const AUTH_SESSION_ID = "test-overpass-route-auth";
const MiB = 1024 * 1024;

async function buildTestApp() {
    const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(overpassRoutes);
    await app.ready();
    return app;
}

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

function postQuery(app: TestApp, query: string, cookie = true) {
    return app.inject({
        method: "POST",
        url: "/overpass",
        headers: cookie ? { cookie: `session=${app.signCookie(AUTH_SESSION_ID)}` } : {},
        payload: { query },
    });
}

// The query the proxy sent upstream (form-encoded `data=`).
function upstreamQuery(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
    const body = fetchMock.mock.calls[call][1].body as string;
    return new URLSearchParams(body).get("data")!;
}

const okJson = () =>
    new Response(JSON.stringify({ elements: [{ type: "node", id: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
    });

// An endless body of 1 MiB chunks; records how much was read and whether the
// reader gave up on it.
function endlessBody() {
    const state = { pulled: 0, cancelled: false };
    const chunk = new Uint8Array(MiB).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            state.pulled += 1;
            controller.enqueue(chunk);
        },
        cancel() {
            state.cancelled = true;
        },
    });
    return { state, response: new Response(stream, { status: 200 }) };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("POST /overpass", () => {
    let app: TestApp;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "overpass-user",
                displayName: "Overpass User",
                avatarUrl: "https://example.com/a.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.authSession.create({
            data: { id: AUTH_SESSION_ID, userId: USER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        });
    });

    afterAll(async () => {
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    });

    // A fresh app per test resets the rate limiter.
    beforeEach(async () => {
        fetchMock = vi.fn(async () => okJson());
        vi.stubGlobal("fetch", fetchMock);
        app = await buildTestApp();
    });

    afterEach(async () => {
        await app.close();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    test("returns 401 without a session and never calls Overpass", async () => {
        const res = await postQuery(app, "[out:json];node(1);out;", false);
        expect(res.statusCode).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test("proxies the query and returns the Overpass JSON", async () => {
        const res = await postQuery(app, "[out:json][timeout:25];node(1);out;");
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ elements: [{ type: "node", id: 1 }] });
        expect(upstreamQuery(fetchMock)).toBe(
            "[out:json][timeout:25][maxsize:536870912];node(1);out;",
        );
    });

    test("clamps a timeout and maxsize above the server's limits", async () => {
        const res = await postQuery(app, "[out:json][timeout:9999][maxsize:4294967296];node;out;");
        expect(res.statusCode).toBe(200);
        expect(upstreamQuery(fetchMock)).toBe(
            "[out:json][timeout:80][maxsize:536870912];node;out;",
        );
    });

    test("adds the limits to a query without settings", async () => {
        await postQuery(app, "node;out;");
        expect(upstreamQuery(fetchMock)).toBe("[timeout:80][maxsize:536870912];\nnode;out;");
    });

    test("aborts an oversized upstream response with a 502", async () => {
        const { state, response } = endlessBody();
        fetchMock.mockResolvedValueOnce(response);

        const res = await postQuery(app, "[out:json];node;out;");

        expect(res.statusCode).toBe(502);
        expect(res.json().message).toBe("Overpass response too large");
        expect(state.cancelled).toBe(true);
        // Stopped at the 50 MiB default, give or take the stream's read-ahead.
        expect(state.pulled).toBeLessThan(55);
    });

    test("rate limits a user after a burst of 120, then refills at 60 per minute", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        for (let i = 0; i < 120; i++) {
            expect((await postQuery(app, `node(${i});out;`)).statusCode).toBe(200);
        }

        const limited = await postQuery(app, "node(0);out;");
        expect(limited.statusCode).toBe(429);
        expect(limited.headers["retry-after"]).toBe("1");
        expect(fetchMock).toHaveBeenCalledTimes(120);

        vi.setSystemTime(Date.now() + 2_000);
        expect((await postQuery(app, "node(0);out;")).statusCode).toBe(200);
        expect((await postQuery(app, "node(0);out;")).statusCode).toBe(200);
        expect((await postQuery(app, "node(0);out;")).statusCode).toBe(429);
    });

    test("caps a user's concurrent requests at 6", async () => {
        const releases: (() => void)[] = [];
        fetchMock.mockImplementation(
            () => new Promise<Response>((resolve) => releases.push(() => resolve(okJson()))),
        );

        const pending = Array.from({ length: 6 }, (_, i) => postQuery(app, `node(${i});out;`));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

        expect((await postQuery(app, "node(6);out;")).statusCode).toBe(429);

        releases.forEach((release) => release());
        for (const res of await Promise.all(pending)) expect(res.statusCode).toBe(200);

        fetchMock.mockImplementation(async () => okJson());
        expect((await postQuery(app, "node(7);out;")).statusCode).toBe(200);
    });
});

describe("boundQuerySettings", () => {
    test("keeps the frontend's settings and leading whitespace", () => {
        expect(boundQuerySettings("\n[out:json][timeout:60];\nnwr(1);\nout center;\n")).toBe(
            "\n[out:json][timeout:60][maxsize:536870912];\nnwr(1);\nout center;\n",
        );
        expect(boundQuerySettings("\n[out:json];\nis_in(1,2)->.a;")).toBe(
            "\n[out:json][timeout:80][maxsize:536870912];\nis_in(1,2)->.a;",
        );
    });

    test("tolerates whitespace and case in the settings", () => {
        expect(boundQuerySettings("[out:json] [ TimeOut : 500 ] ;node;out;")).toBe(
            "[out:json] [timeout:80][maxsize:536870912];node;out;",
        );
    });

    test("replaces invalid values with the limit", () => {
        expect(boundQuerySettings("[timeout:-1][maxsize:big];node;out;")).toBe(
            "[timeout:80][maxsize:536870912];node;out;",
        );
    });

    test("prepends its own settings when the query's are hidden from the parse", () => {
        // Overpass rejects the resulting second settings statement.
        expect(boundQuerySettings("/* x */[timeout:9999];node;out;")).toBe(
            "[timeout:80][maxsize:536870912];\n/* x */[timeout:9999];node;out;",
        );
    });
});

describe("overpassFetch", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The /boundaries routes read overpassFetch's response themselves.
    test("caps the body it returns, rejecting reads past the limit with a 502", async () => {
        const { state, response } = endlessBody();
        vi.stubGlobal("fetch", vi.fn(async () => response));

        const res = await overpassFetch("[out:json];node;out;");
        expect(res?.ok).toBe(true);
        await expect(res!.json()).rejects.toMatchObject({
            message: "Overpass response too large",
            statusCode: 502,
        });
        expect(state.cancelled).toBe(true);
    });
});
