import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { discord } from "../lib/discord-client.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

// DEV_LOGIN_TOKEN must be set before env.ts evaluates process.env; vi.hoisted runs
// before the imports above (discord-client.ts imports env.ts).
const TOKEN = vi.hoisted(() => {
  const token = "dev-login-test-token-0123456789abcdef";
  process.env["DEV_LOGIN_TOKEN"] = token;
  return token;
});
const KNOWN_ID = "900000000000000001";
const UNKNOWN_ID = "900000000000000002";
const EXISTING_ID = "900000000000000003";
const IDS = [KNOWN_ID, UNKNOWN_ID, EXISTING_ID];

async function buildTestApp() {
  const { authRoutes } = await import("./auth.js");
  const { meRoute } = await import("./me.js");
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(meRoute);
  await app.ready();
  return app;
}

async function cleanup() {
  await prisma.authSession.deleteMany({ where: { userId: { in: IDS } } });
  await prisma.user.deleteMany({ where: { discordId: { in: IDS } } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("/auth/dev-login (DEV_LOGIN_TOKEN set)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    await cleanup();
    app = await buildTestApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  afterAll(async () => {
    await app.close();
  });

  const postJson = (body: object, token?: string) =>
    app.inject({
      method: "POST",
      url: "/auth/dev-login",
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  const postForm = (fields: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/auth/dev-login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });

  test("GET serves the login form", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/dev-login?discordId=123" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain('<form method="post" action="/auth/dev-login">');
    expect(res.body).toContain('value="123"');
  });

  test("rejects a missing or wrong token without creating a session", async () => {
    const getUser = vi.spyOn(discord, "getUser");

    const none = await postJson({ discordId: KNOWN_ID });
    expect(none.statusCode).toBe(403);

    const wrong = await postJson({ discordId: KNOWN_ID }, "nope");
    expect(wrong.statusCode).toBe(403);
    expect(wrong.cookies.find((c) => c.name === "session")).toBeUndefined();

    const wrongInBody = await postJson({ discordId: KNOWN_ID, token: `${TOKEN}x` });
    expect(wrongInBody.statusCode).toBe(403);

    expect(getUser).not.toHaveBeenCalled();
    expect(await prisma.user.findUnique({ where: { discordId: KNOWN_ID } })).toBeNull();
  });

  test("rejects an ID that is not a Discord snowflake", async () => {
    const res = await postJson({ discordId: "alice" }, TOKEN);
    expect(res.statusCode).toBe(400);
  });

  test("logs in as a real Discord user with their profile", async () => {
    vi.spyOn(discord, "getUser").mockResolvedValue({
      id: KNOWN_ID,
      username: "realuser",
      global_name: "Real User",
      avatar: "abc123",
    });

    const res = await postJson({ discordId: KNOWN_ID }, TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ discordId: KNOWN_ID, displayName: "Real User" });

    const cookie = res.cookies.find((c) => c.name === "session")!;
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: `session=${cookie.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.discordId).toBe(KNOWN_ID);

    const user = await prisma.user.findUnique({ where: { discordId: KNOWN_ID } });
    expect(user?.username).toBe("realuser");
    expect(user?.avatarUrl).toBe(`https://cdn.discordapp.com/avatars/${KNOWN_ID}/abc123.png`);
  });

  test("an unknown ID becomes a placeholder user; the token may be in the body", async () => {
    vi.spyOn(discord, "getUser").mockResolvedValue(null);

    const res = await postJson({ discordId: UNKNOWN_ID, token: TOKEN });
    expect(res.statusCode).toBe(200);

    const user = await prisma.user.findUnique({ where: { discordId: UNKNOWN_ID } });
    expect(user?.displayName).toBe("Dev User 0002");
  });

  test("still logs in when the Discord lookup fails", async () => {
    vi.spyOn(discord, "getUser").mockRejectedValue(new Error("Discord down"));

    const res = await postJson({ discordId: UNKNOWN_ID }, TOKEN);
    expect(res.statusCode).toBe(200);
  });

  test("keeps an existing user's OAuth tokens", async () => {
    await prisma.user.create({
      data: {
        discordId: EXISTING_ID,
        username: "old",
        displayName: "Old Name",
        avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png",
        discordAccessToken: "real-access",
        discordRefreshToken: "real-refresh",
        discordTokenExpiresAt: new Date(),
      },
    });
    vi.spyOn(discord, "getUser").mockResolvedValue({
      id: EXISTING_ID,
      username: "new",
      global_name: null,
      avatar: null,
    });

    const res = await postJson({ discordId: EXISTING_ID }, TOKEN);
    expect(res.statusCode).toBe(200);

    const user = await prisma.user.findUnique({ where: { discordId: EXISTING_ID } });
    expect(user?.displayName).toBe("new");
    expect(user?.discordAccessToken).toBe("real-access");
    expect(user?.discordRefreshToken).toBe("real-refresh");
  });

  test("the form logs in and redirects to the app", async () => {
    vi.spyOn(discord, "getUser").mockResolvedValue(null);

    const res = await postForm({ discordId: UNKNOWN_ID, token: TOKEN });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${process.env["FRONTEND_ORIGIN"]}/map`);
    expect(res.cookies.find((c) => c.name === "session")?.value).toBeTruthy();
  });

  test("the form shows the error on a wrong token", async () => {
    const res = await postForm({ discordId: UNKNOWN_ID, token: "nope" });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Wrong dev login token.");
    expect(res.body).toContain(`value="${UNKNOWN_ID}"`);
  });
});
