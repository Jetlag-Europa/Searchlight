import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { eventRoutes } from "./events.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const USER1_ID = "test-evroutes-user1";
const USER2_ID = "test-evroutes-user2";
const SERVER_ID = "test-evroutes-server";
const GAME_ID = "test-evroutes-game";
const SESSION1_ID = "test-evroutes-session1";   // owned by USER1
const SESSION2_ID = "test-evroutes-session2";   // owned by USER2, USER1 not participant
const AUTH_SESSION_ID = "test-evroutes-auth";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(eventRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

describe("GET /sessions/:sessionId/events", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;
  let t1: Date;
  let t2: Date;

  beforeAll(async () => {
    // Remove any leftover data from a previous interrupted run.
    await prisma.event.deleteMany({
      where: { sessionId: { in: [SESSION1_ID, SESSION2_ID] } },
    });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.gameSession.deleteMany({
      where: { id: { in: [SESSION1_ID, SESSION2_ID] } },
    });
    await prisma.game.deleteMany({ where: { id: GAME_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    await prisma.user.deleteMany({
      where: { discordId: { in: [USER1_ID, USER2_ID] } },
    });

    // Create fresh fixtures.
    await prisma.user.createMany({
      data: [
        {
          discordId: USER1_ID,
          username: "testuser1",
          displayName: "Test User 1",
          avatarUrl: "https://example.com/a1.png",
          discordAccessToken: "tok1",
          discordRefreshToken: "ref1",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          discordId: USER2_ID,
          username: "testuser2",
          displayName: "Test User 2",
          avatarUrl: "https://example.com/a2.png",
          discordAccessToken: "tok2",
          discordRefreshToken: "ref2",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    await prisma.server.create({ data: { id: SERVER_ID, name: "Test Server" } });

    await prisma.game.create({
      data: {
        id: GAME_ID,
        serverId: SERVER_ID,
        name: "Test Game",
        sentinelValue: "test-sentinel-evroutes",
        kmlPath: "/fake.kml",
        mapLocationJson: {},
        hidingRadius: 1.0,
        hidingRadiusUnits: "miles",
      },
    });

    await prisma.gameSession.createMany({
      data: [
        {
          id: SESSION1_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER1_ID,
          name: "Session 1",
        },
        {
          id: SESSION2_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER2_ID,
          name: "Session 2",
        },
      ],
    });

    await prisma.authSession.create({
      data: {
        id: AUTH_SESSION_ID,
        userId: USER1_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    // Two events at distinct, controlled timestamps.
    t1 = new Date(Date.now() - 2000);
    t2 = new Date(Date.now() - 1000);

    await prisma.event.createMany({
      data: [
        {
          sessionId: SESSION1_ID,
          userId: USER1_ID,
          type: "stroke.create",
          payloadJson: { test: 1 },
          clientUuid: "test-ev-1",
          clientCreatedAt: t1,
          serverReceivedAt: t1,
        },
        {
          sessionId: SESSION1_ID,
          userId: USER1_ID,
          type: "stroke.delete",
          payloadJson: { clientUuid: "abc" },
          clientUuid: "test-ev-2",
          clientCreatedAt: t2,
          serverReceivedAt: t2,
        },
      ],
    });

    app = await buildTestApp();
    cookie = `session=${app.signCookie(AUTH_SESSION_ID)}`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.event.deleteMany({
      where: { sessionId: { in: [SESSION1_ID, SESSION2_ID] } },
    });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.gameSession.deleteMany({
      where: { id: { in: [SESSION1_ID, SESSION2_ID] } },
    });
    await prisma.game.deleteMany({ where: { id: GAME_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    await prisma.user.deleteMany({
      where: { discordId: { in: [USER1_ID, USER2_ID] } },
    });
    await prisma.$disconnect();
  });

  test("401 without auth cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("returns all events for session creator", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: unknown[] }>();
    expect(body.events).toHaveLength(2);
  });

  test("events are ordered by serverReceivedAt ascending", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
      headers: { cookie },
    });
    const { events } = res.json<{ events: Array<{ type: string }> }>();
    expect(events[0].type).toBe("stroke.create");
    expect(events[1].type).toBe("stroke.delete");
  });

  test("response shape includes all required fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
      headers: { cookie },
    });
    const { events } = res.json<{ events: Array<Record<string, unknown>> }>();
    const ev = events[0];
    expect(typeof ev.id).toBe("string");
    expect(ev.sessionId).toBe(SESSION1_ID);
    expect(ev.userId).toBe(USER1_ID);
    expect(typeof ev.clientCreatedAt).toBe("string");
    expect(typeof ev.serverReceivedAt).toBe("string");
  });

  test("?since filters to events strictly after the timestamp", async () => {
    // t1 is excluded (gt, not gte) — only t2's event should appear
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?since=${encodeURIComponent(t1.toISOString())}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ type: string }> }>();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("stroke.delete");
  });

  test("?since with a future timestamp returns empty list", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?since=${encodeURIComponent(future)}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: unknown[] }>();
    expect(events).toHaveLength(0);
  });

  test("404 for a session that does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/nonexistent-session-id/events`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  test("403 when user is not a participant of the session", async () => {
    // SESSION2 is owned by USER2; USER1 has no relation to it.
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION2_ID}/events`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
