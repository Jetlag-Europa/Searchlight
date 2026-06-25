import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-auth-login-user";

// ENABLE_TEST_AUTH must be set before env.ts (imported transitively by auth.ts)
// evaluates process.env, so auth.ts and me.ts are imported dynamically below.
process.env["ENABLE_TEST_AUTH"] = "1";
process.env["TEST_AUTH_USER_ID"] = USER_ID;

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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("POST /auth/test-login (ENABLE_TEST_AUTH=1)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    app = await buildTestApp();
  });

  afterAll(async () => {
    await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await app.close();
  });

  test("mints a session for the default test user and upserts it", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/test-login" });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.discordId).toBe(USER_ID);

    // A session cookie was set…
    const cookie = res.cookies.find((c) => c.name === "session");
    expect(cookie?.value).toBeTruthy();

    // …the user was created…
    const user = await prisma.user.findUnique({ where: { discordId: USER_ID } });
    expect(user).not.toBeNull();

    // …and an auth session row exists.
    const sessions = await prisma.authSession.findMany({
      where: { userId: USER_ID },
    });
    expect(sessions.length).toBeGreaterThan(0);
  });

  test("the minted cookie authenticates GET /me", async () => {
    const login = await app.inject({ method: "POST", url: "/auth/test-login" });
    const cookie = login.cookies.find((c) => c.name === "session")!;

    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: `session=${cookie.value}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().user.discordId).toBe(USER_ID);
  });

  test("accepts an explicit discordId in the body", async () => {
    const other = `${USER_ID}-explicit`;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/auth/test-login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ discordId: other }),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.discordId).toBe(other);
    } finally {
      await prisma.authSession.deleteMany({ where: { userId: other } });
      await prisma.user.deleteMany({ where: { discordId: other } });
    }
  });
});
