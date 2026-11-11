import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
  await app.ready();
  return app;
}

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

  test("a fresh login is neither written nor re-sent", async () => {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS - DAY);
    await setExpiry(expiresAt);
    const update = vi.spyOn(prisma.authSession, "updateMany");
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(await storedExpiry()).toEqual(expiresAt);
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
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await storedExpiry()).toEqual(expiresAt);
  });

  test("a login deleted by a logout meanwhile is not brought back", async () => {
    await setExpiry(new Date(Date.now() + 5 * DAY));
    const res = await app.inject({ method: "GET", url: "/logged-out-meanwhile", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await storedExpiry()).toBeUndefined();
  });
});
