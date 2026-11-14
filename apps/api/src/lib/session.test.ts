import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import prisma from "./prisma.js";
import { registerSessionRenewal, SESSION_TTL_MS } from "./session.js";
import { meRoute } from "../routes/me.js";

const USER_ID = "test-session-renewal-user";
const AUTH_ID = "test-session-renewal-auth";
const DAY = 24 * 60 * 60 * 1000;

describe("login renewal", () => {
  const app = Fastify({ logger: false });
  const cookie = () => `session=${app.signCookie(AUTH_ID)}`;
  const me = () => app.inject({ method: "GET", url: "/me", headers: { cookie: cookie() } });
  const setExpiry = (expiresAt: Date) =>
    prisma.authSession.upsert({
      where: { id: AUTH_ID },
      update: { expiresAt },
      create: { id: AUTH_ID, userId: USER_ID, expiresAt },
    });
  const storedExpiry = async () => (await prisma.authSession.findUnique({ where: { id: AUTH_ID } }))!.expiresAt;

  const cleanUp = async () => {
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
  };

  beforeAll(async () => {
    await cleanUp();
    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "renewal",
        displayName: "Renewal User",
        avatarUrl: "",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + DAY),
      },
    });
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    registerSessionRenewal(app);
    await app.register(meRoute);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await cleanUp();
  });

  test("a login more than a day old is pushed to 30 days, row and cookie", async () => {
    await setExpiry(new Date(Date.now() + 10 * DAY));
    const before = Date.now();
    const res = await me();
    expect(res.statusCode).toBe(200);
    const stored = (await storedExpiry()).getTime();
    expect(stored).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    const setCookie = res.cookies.find((c) => c.name === "session")!;
    expect(app.unsignCookie(setCookie.value).value).toBe(AUTH_ID);
    // Cookie dates have second precision.
    expect(Math.abs((setCookie.expires as Date).getTime() - stored)).toBeLessThan(1000);
  });

  test("a login renewed less than a day ago is left alone", async () => {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS - DAY + 60_000);
    await setExpiry(expiresAt);
    const res = await me();
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
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
});
