import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { meRoute } from "./me.js";
import { adminRoutes } from "./admin.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_ID = "test-gml-admin";
const PLAYER_ID = "test-gml-player";
const ADMIN_AUTH = "test-gml-admin-auth";
const PLAYER_AUTH = "test-gml-player-auth";
const USERS = [
  { id: ADMIN_ID, auth: ADMIN_AUTH, name: "Admin Person" },
  { id: PLAYER_ID, auth: PLAYER_AUTH, name: "Player Person" },
];

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(meRoute);
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.ready();
  return app;
}

async function cleanUp() {
  const ids = USERS.map((u) => u.id);
  await prisma.googleMapLoad.deleteMany({ where: { userId: { in: ids } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { discordId: { in: ids } } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Google map load counts", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const previousAdmins = env.ADMIN_DISCORD_IDS;
  const cookie = (auth: string) => ({ cookie: `session=${app.signCookie(auth)}` });
  const record = (auth: string, payload: object = {}) =>
    app.inject({
      method: "POST",
      url: "/me/google-map-loads",
      headers: cookie(auth),
      payload,
    });
  const stats = (auth: string, query = "") =>
    app.inject({ method: "GET", url: `/admin/google-map-loads${query}`, headers: cookie(auth) });

  beforeAll(async () => {
    await cleanUp();
    for (const u of USERS) {
      await prisma.user.create({
        data: {
          discordId: u.id,
          username: u.id,
          displayName: u.name,
          avatarUrl: "https://example.com/avatar.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.authSession.create({
        data: { id: u.auth, userId: u.id, expiresAt: new Date(Date.now() + 86_400_000) },
      });
    }
    env.ADMIN_DISCORD_IDS = `someone-else, ${ADMIN_ID}`;
    app = await buildTestApp();
  });

  afterAll(async () => {
    env.ADMIN_DISCORD_IDS = previousAdmins;
    await cleanUp();
    await app.close();
  });

  test("a load needs a login", async () => {
    const res = await app.inject({ method: "POST", url: "/me/google-map-loads", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  test("records a load for the logged-in user, with or without a session", async () => {
    expect((await record(PLAYER_AUTH, { sessionId: "session-1" })).statusCode).toBe(204);
    expect((await record(PLAYER_AUTH)).statusCode).toBe(204);
    expect((await record(ADMIN_AUTH, { sessionId: "" })).statusCode).toBe(204);
    const rows = await prisma.googleMapLoad.findMany({
      where: { userId: { in: [PLAYER_ID, ADMIN_ID] } },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.userId, r.sessionId])).toEqual([
      [PLAYER_ID, "session-1"],
      [PLAYER_ID, null],
      [ADMIN_ID, null],
    ]);
  });

  test("refuses an overlong session id", async () => {
    const res = await record(PLAYER_AUTH, { sessionId: "x".repeat(65) });
    expect(res.statusCode).toBe(400);
  });

  test("only admins see the counts", async () => {
    expect((await stats(PLAYER_AUTH)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/google-map-loads" })).statusCode).toBe(
      401,
    );
  });

  test("counts this month's loads per user and per day", async () => {
    const res = await stats(ADMIN_AUTH);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const today = new Date().toISOString().slice(0, 10);
    expect(body.month).toBe(today.slice(0, 7));
    // Other suites may share the database: look only at these users.
    const ours = body.users.filter((u: { discordId: string }) =>
      [PLAYER_ID, ADMIN_ID].includes(u.discordId),
    );
    expect(ours).toEqual([
      { discordId: PLAYER_ID, displayName: "Player Person", username: PLAYER_ID, loads: 2 },
      { discordId: ADMIN_ID, displayName: "Admin Person", username: ADMIN_ID, loads: 1 },
    ]);
    expect(body.total).toBe(
      body.users.reduce((sum: number, u: { loads: number }) => sum + u.loads, 0),
    );
    const todayRow = body.days.find((d: { day: string }) => d.day === today);
    expect(todayRow.loads).toBeGreaterThanOrEqual(3);
  });

  test("a month is its own: earlier loads stay in theirs", async () => {
    await prisma.googleMapLoad.create({
      data: { userId: PLAYER_ID, createdAt: new Date("2025-02-28T23:59:59Z") },
    });
    await prisma.googleMapLoad.create({
      data: { userId: PLAYER_ID, createdAt: new Date("2025-03-01T00:00:00Z") },
    });
    const feb = (await stats(ADMIN_AUTH, "?month=2025-02")).json();
    const febOurs = feb.users.find((u: { discordId: string }) => u.discordId === PLAYER_ID);
    expect(febOurs.loads).toBe(1);
    expect(feb.days.find((d: { day: string }) => d.day === "2025-02-28").loads).toBeGreaterThanOrEqual(1);
    const mar = (await stats(ADMIN_AUTH, "?month=2025-03")).json();
    expect(mar.users.find((u: { discordId: string }) => u.discordId === PLAYER_ID).loads).toBe(1);
    expect(mar.days.some((d: { day: string }) => d.day === "2025-02-28")).toBe(false);
  });

  test("refuses a malformed month", async () => {
    for (const month of ["2025-13", "2025-1", "25-01", "2025-01-01", "now"]) {
      expect((await stats(ADMIN_AUTH, `?month=${month}`)).statusCode).toBe(400);
    }
  });

  test("a deleted user's loads go with them", async () => {
    await prisma.authSession.deleteMany({ where: { userId: PLAYER_ID } });
    await prisma.user.delete({ where: { discordId: PLAYER_ID } });
    expect(await prisma.googleMapLoad.count({ where: { userId: PLAYER_ID } })).toBe(0);
  });
});
