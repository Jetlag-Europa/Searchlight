import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { meRoute } from "./me.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-me-route-user";
const AUTH_SESSION_ID = "test-me-route-auth";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(meRoute);
  await app.ready();
  return app;
}

function signedCookie(app: Awaited<ReturnType<typeof buildTestApp>>, value: string) {
  return `session=${app.signCookie(value)}`;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("GET /me and PATCH /me/preferences", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    // Clean up any leftovers from a prior interrupted run
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "testuser-me",
        displayName: "Test Me User",
        avatarUrl: "https://example.com/avatar.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await prisma.authSession.create({
      data: {
        id: AUTH_SESSION_ID,
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    app = await buildTestApp();
  });

  afterAll(async () => {
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await app.close();
  });

  test("GET /me returns user profile and empty preferences for a new user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.discordId).toBe(USER_ID);
    expect(body.user.displayName).toBe("Test Me User");
    expect(body.preferences).toBeDefined();
    expect(typeof body.preferences).toBe("object");
  });

  test("PATCH /me/preferences saves preferences", async () => {
    const prefs = {
      defaultUnit: "kilometers",
      autoZoom: false,
      warningAlarm: true,
      autoLockQuestions: true,
      baseTileLayer: "dark",
    };

    const res = await app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: {
        cookie: signedCookie(app, AUTH_SESSION_ID),
        "content-type": "application/json",
      },
      body: JSON.stringify(prefs),
    });

    expect(res.statusCode).toBe(204);
  });

  test("GET /me after PATCH returns the saved preferences", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.preferences.defaultUnit).toBe("kilometers");
    expect(body.preferences.autoZoom).toBe(false);
    expect(body.preferences.warningAlarm).toBe(true);
    expect(body.preferences.autoLockQuestions).toBe(true);
    expect(body.preferences.baseTileLayer).toBe("dark");
  });

  test("PATCH /me/preferences overwrites previous preferences", async () => {
    await app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: {
        cookie: signedCookie(app, AUTH_SESSION_ID),
        "content-type": "application/json",
      },
      body: JSON.stringify({ defaultUnit: "miles", autoZoom: true }),
    });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    const body = res.json();
    expect(body.preferences.defaultUnit).toBe("miles");
    expect(body.preferences.autoZoom).toBe(true);
  });

  test("GET /me returns 401 without a session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  test("PATCH /me/preferences returns 401 without a session cookie", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/me/preferences",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultUnit: "miles" }),
    });
    expect(res.statusCode).toBe(401);
  });
});
