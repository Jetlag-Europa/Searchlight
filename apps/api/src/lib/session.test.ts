import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import { brotliDecompressSync } from "node:zlib";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import prisma from "./prisma.js";
import { registerCompression } from "./compression.js";
import { registerSessionRenewal, resolveSession, SESSION_TTL_MS } from "./session.js";
import { meRoute } from "../routes/me.js";

const USER_ID = "test-session-renewal-user";
const AUTH_ID = "test-session-renewal-auth";
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = process.env["FRONTEND_ORIGIN"]!;

// Built like index.ts: CORS, compression, cookies, then the renewal hook.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: ORIGIN, credentials: true });
  await registerCompression(app);
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  registerSessionRenewal(app);
  await app.register(meRoute);
  // A logout that lands while this request is still running.
  app.get("/logged-out-meanwhile", async (req) => {
    await resolveSession(req);
    await prisma.authSession.deleteMany({ where: { id: AUTH_ID } });
    return { ok: true };
  });
  // Waits for the test to drop the connection before it answers.
  app.get("/held", async (req) => {
    await resolveSession(req);
    held.started();
    await held.released;
    return { ok: true };
  });
  await app.ready();
  return app;
}

const held = { started: () => {}, released: Promise.resolve() };

describe("login renewal", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;

  const setExpiry = (expiresAt: Date) =>
    prisma.authSession.upsert({
      where: { id: AUTH_ID },
      update: { expiresAt },
      create: { id: AUTH_ID, userId: USER_ID, expiresAt },
    });
  const storedExpiry = async () =>
    (await prisma.authSession.findUnique({ where: { id: AUTH_ID } }))?.expiresAt;
  const me = (headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: "/me", headers: { cookie, ...headers } });
  const sessionCookie = (res: Awaited<ReturnType<typeof me>>) => res.cookies.find((c) => c.name === "session");

  beforeAll(async () => {
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "renewal",
        displayName: "Renewal User",
        avatarUrl: "",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + DAY),
        // Over the 1 KB compression threshold, so /me is compressed.
        preferences: { filler: "x".repeat(4000) },
      },
    });
    app = await buildTestApp();
    cookie = `session=${app.signCookie(AUTH_ID)}`;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
  });

  test("a login started 20 days ago is extended to 30 days, row and cookie", async () => {
    await setExpiry(new Date(Date.now() + 10 * DAY));
    const before = Date.now();
    const res = await me({ origin: ORIGIN, "accept-encoding": "br" });
    expect(res.statusCode).toBe(200);

    const stored = (await storedExpiry())!.getTime();
    expect(stored).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(stored).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);

    const setCookie = res.cookies.find((c) => c.name === "session");
    expect(setCookie).toBeDefined();
    expect(app.unsignCookie(setCookie!.value)).toEqual({ valid: true, renew: false, value: AUTH_ID });
    // Cookie dates have second precision.
    expect(Math.abs((setCookie!.expires as Date).getTime() - stored)).toBeLessThan(1000);
    expect(setCookie!.httpOnly).toBe(true);
    expect(setCookie!.path).toBe("/");

    // It reaches a cross-origin fetch with credentials, compressed or not.
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["content-encoding"]).toBe("br");
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString()).user.discordId).toBe(USER_ID);
  });

  test("a login renewed less than a day ago is not written, but its cookie is re-sent as is", async () => {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS - DAY + 60_000);
    await setExpiry(expiresAt);
    const update = vi.spyOn(prisma.authSession, "updateMany");
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect(update).not.toHaveBeenCalled();
    expect(await storedExpiry()).toEqual(expiresAt);
    const setCookie = sessionCookie(res);
    expect(app.unsignCookie(setCookie!.value).value).toBe(AUTH_ID);
    expect(Math.abs((setCookie!.expires as Date).getTime() - expiresAt.getTime())).toBeLessThan(1000);
    expect(res.headers["cache-control"]).toBe("private");
  });

  test("a login renewed more than a day ago is renewed", async () => {
    await setExpiry(new Date(Date.now() + SESSION_TTL_MS - DAY - 60_000));
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect((await storedExpiry())!.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(sessionCookie(res)).toBeDefined();
  });

  test("a login ends after 30 days without use, not while it is used", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    await setExpiry(new Date(start + SESSION_TTL_MS));
    // Used on day 14 and day 40: each gap is under 30 days.
    now.mockReturnValue(start + 14 * DAY);
    expect((await me()).statusCode).toBe(200);
    now.mockReturnValue(start + 40 * DAY);
    expect((await me()).statusCode).toBe(200);
    // Then 31 days without use.
    now.mockReturnValue(start + 71 * DAY);
    expect((await me()).statusCode).toBe(401);
  });

  test("an expired login is still refused and not renewed", async () => {
    const expiresAt = new Date(Date.now() - 1000);
    await setExpiry(expiresAt);
    const res = await me();
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await storedExpiry()).toEqual(expiresAt);
  });

  test("several requests at once all succeed and all carry the cookie", async () => {
    await setExpiry(new Date(Date.now() + 5 * DAY));
    const results = await Promise.all(Array.from({ length: 6 }, () => me()));
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.cookies.find((c) => c.name === "session")).toBeDefined();
    }
    expect((await storedExpiry())!.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
  });

  test("a failed renewal leaves the request alone", async () => {
    const expiresAt = new Date(Date.now() + 5 * DAY);
    await setExpiry(expiresAt);
    vi.spyOn(prisma.authSession, "updateMany").mockRejectedValueOnce(new Error("db down"));
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.discordId).toBe(USER_ID);
    expect(await storedExpiry()).toEqual(expiresAt);
    // The cookie goes out with the unchanged expiry.
    expect(Math.abs((sessionCookie(res)!.expires as Date).getTime() - expiresAt.getTime())).toBeLessThan(1000);
  });

  // The renewal is written before the response goes out, so a phone that
  // loses the connection then keeps a cookie on its old expiry while the row
  // is no longer due. The next response it does get must carry the cookie.
  test("a renewed cookie lost with a dropped connection is re-sent by the next response", async () => {
    const browserExpiry = new Date(Date.now() + DAY);
    await setExpiry(browserExpiry);
    const started = new Promise<void>((resolve) => (held.started = resolve));
    let release!: () => void;
    held.released = new Promise<void>((resolve) => (release = resolve));
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const client = http.get(`${baseUrl}/held`, { headers: { cookie } });
      client.on("error", () => {});
      await started;
      client.destroy();
      await new Promise<void>((resolve) => client.once("close", resolve));
      release();
      await vi.waitFor(async () =>
        expect((await storedExpiry())!.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000),
      );
    } finally {
      release();
    }
    const update = vi.spyOn(prisma.authSession, "updateMany");
    const retry = await me();
    expect(retry.statusCode).toBe(200);
    expect(update).not.toHaveBeenCalled();
    const stored = (await storedExpiry())!.getTime();
    expect(Math.abs((sessionCookie(retry)!.expires as Date).getTime() - stored)).toBeLessThan(1000);
  });

  test("a login deleted by a logout meanwhile is not brought back", async () => {
    await setExpiry(new Date(Date.now() + 5 * DAY));
    const res = await app.inject({ method: "GET", url: "/logged-out-meanwhile", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await storedExpiry()).toBeUndefined();
  });
});
