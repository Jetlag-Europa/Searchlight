import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { broadcast, closeUserStreams, connectedUserIds } from "../lib/broadcaster.js";
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

    const game = await prisma.game.create({
      data: {
        id: GAME_ID,
        serverId: SERVER_ID,
        name: "Test Game",
        gameKey: "test-game-evroutes",
        size: "medium",
      },
    });

    const rev = await prisma.gameRevision.create({
      data: {
        gameId: game.id,
        revision: 1,
        checksum: "test-evroutes-checksum",
        definition: {
          id: "test-game-evroutes",
          name: "Test Game",
          serverId: SERVER_ID,
        },
      },
    });

    await prisma.game.update({
      where: { id: game.id },
      data: { currentRevisionId: rev.id },
    });

    await prisma.gameSession.createMany({
      data: [
        {
          id: SESSION1_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER1_ID,
          name: "Session 1",
          gameRevisionId: rev.id,
        },
        {
          id: SESSION2_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER2_ID,
          name: "Session 2",
          gameRevisionId: rev.id,
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
          sequence: 1,
          type: "stroke.create",
          payloadJson: { test: 1 },
          clientUuid: "test-ev-1",
          clientCreatedAt: t1,
          serverReceivedAt: t1,
        },
        {
          sessionId: SESSION1_ID,
          userId: USER1_ID,
          sequence: 2,
          type: "stroke.delete",
          payloadJson: { clientUuid: "abc" },
          clientUuid: "test-ev-2",
          clientCreatedAt: t2,
          serverReceivedAt: t2,
        },
      ],
    });

    await prisma.gameSession.update({
      where: { id: SESSION1_ID },
      data: { eventSequence: 2 },
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
    await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
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

  test("events are ordered by sequence ascending", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
      headers: { cookie },
    });
    const { events } = res.json<{ events: Array<{ sequence: number; type: string }> }>();
    expect(events[0].sequence).toBe(1);
    expect(events[0].type).toBe("stroke.create");
    expect(events[1].sequence).toBe(2);
    expect(events[1].type).toBe("stroke.delete");
  });

  test("response shape includes all required fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events`,
      headers: { cookie },
    });
    const { events, nextAfter } = res.json<{ events: Array<Record<string, unknown>>; nextAfter: number | null }>();
    const ev = events[0];
    expect(typeof ev.id).toBe("string");
    expect(ev.sessionId).toBe(SESSION1_ID);
    expect(ev.userId).toBe(USER1_ID);
    expect(ev.sequence).toBe(1);
    expect(typeof ev.clientCreatedAt).toBe("string");
    expect(typeof ev.serverReceivedAt).toBe("string");
    expect(nextAfter).toBeNull();
  });

  test("?after filters to events with sequence > after", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?after=1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events, nextAfter } = res.json<{ events: Array<{ sequence: number; type: string }>; nextAfter: number | null }>();
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(2);
    expect(events[0].type).toBe("stroke.delete");
    expect(nextAfter).toBeNull();
  });

  test("pagination with limit returns nextAfter when more pages exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?after=0&limit=1`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events, nextAfter } = res.json<{ events: Array<{ sequence: number }>; nextAfter: number | null }>();
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(1);
    expect(nextAfter).toBe(1);

    const res2 = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?after=${nextAfter}&limit=1`,
      headers: { cookie },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = res2.json<{ events: Array<{ sequence: number }>; nextAfter: number | null }>();
    expect(body2.events).toHaveLength(1);
    expect(body2.events[0].sequence).toBe(2);
    expect(body2.nextAfter).toBeNull();
  });

  test("?after beyond latest sequence returns empty list and nextAfter null", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?after=999`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { events, nextAfter } = res.json<{ events: unknown[]; nextAfter: number | null }>();
    expect(events).toHaveLength(0);
    expect(nextAfter).toBeNull();
  });

  test("400 for ?after too large for the sequence column", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events?after=2147483648`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
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
  // ── GET /sessions/:sessionId/events/cursor ──────────────────────────────────
  test("cursor: 401 without auth cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events/cursor`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("cursor: 404 for a session that does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/nonexistent-session-id/events/cursor`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  test("cursor: 403 when user is not a participant of the session", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION2_ID}/events/cursor`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  test("cursor: returns latest event sequence when events exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/events/cursor`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sequence: number }>();
    expect(body.sequence).toBe(2);
  });

  test("cursor: returns 0 when no events exist in session", async () => {
    const EMPTY_SESSION_ID = "test-evroutes-empty";
    const game = await prisma.game.findUniqueOrThrow({ where: { id: GAME_ID } });
    await prisma.gameSession.create({
      data: {
        id: EMPTY_SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: USER1_ID,
        name: "Empty Session",
        eventSequence: 0,
        gameRevisionId: game.currentRevisionId!,
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sessions/${EMPTY_SESSION_ID}/events/cursor`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ sequence: number }>();
      expect(body.sequence).toBe(0);
    } finally {
      await prisma.gameSession.delete({ where: { id: EMPTY_SESSION_ID } });
    }
  });

  // ── GET /sessions/:sessionId/stream (SSE) ──────────────────────────────────
  // Auth and access-control only — failure paths complete before reply.hijack().
  test("stream: 401 without auth cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION1_ID}/stream`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("stream: 403 when user is not a participant", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION2_ID}/stream`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  test("stream: 404 for a session that does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/nonexistent-stream-id/stream`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  test("stream: revoked participant is forbidden from connecting", async () => {
    const REVOKED_USER_ID = "test-evroutes-revoked-user";
    await prisma.user.create({
      data: {
        discordId: REVOKED_USER_ID,
        username: "revokeduser",
        displayName: "Revoked User",
        avatarUrl: "",
        discordAccessToken: "tok-rev",
        discordRefreshToken: "ref-rev",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const REVOKED_AUTH_ID = "test-evroutes-revoked-auth";
    await prisma.authSession.create({
      data: {
        id: REVOKED_AUTH_ID,
        userId: REVOKED_USER_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.sessionParticipant.create({
      data: {
        sessionId: SESSION1_ID,
        userId: REVOKED_USER_ID,
        role: "member",
        acceptedAt: new Date(),
        revokedAt: new Date(), // Already revoked!
      },
    });

    const revokedCookie = `session=${app.signCookie(REVOKED_AUTH_ID)}`;
    try {
      const res = await app.inject({
        method: "GET",
        url: `/sessions/${SESSION1_ID}/stream`,
        headers: { cookie: revokedCookie },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION1_ID, userId: REVOKED_USER_ID } });
      await prisma.authSession.deleteMany({ where: { id: REVOKED_AUTH_ID } });
      await prisma.user.deleteMany({ where: { discordId: REVOKED_USER_ID } });
    }
  });

  test("stream: a participant kicked while the stream connects is disconnected", async () => {
    const MEMBER_ID = "test-evroutes-member";
    const MEMBER_AUTH_ID = "test-evroutes-member-auth";
    await prisma.user.create({
      data: {
        discordId: MEMBER_ID,
        username: "memberuser",
        displayName: "Member User",
        avatarUrl: "",
        discordAccessToken: "tok-mem",
        discordRefreshToken: "ref-mem",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.authSession.create({
      data: { id: MEMBER_AUTH_ID, userId: MEMBER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION1_ID, userId: MEMBER_ID, role: "member", acceptedAt: new Date() },
    });

    // Kick the member during the stream's user lookup, after its access check
    // passed, the way DELETE /participants/:userId does. Its closeUserStreams
    // runs before the stream is registered, so it can't close it.
    const findUser = prisma.user.findUnique.bind(prisma.user);
    const spy = vi.spyOn(prisma.user, "findUnique").mockImplementationOnce((async (
      args: Parameters<typeof findUser>[0],
    ) => {
      await prisma.sessionParticipant.updateMany({
        where: { sessionId: SESSION1_ID, userId: MEMBER_ID },
        data: { revokedAt: new Date() },
      });
      closeUserStreams(SESSION1_ID, MEMBER_ID);
      return findUser(args);
    }) as never);

    try {
      // inject() resolves only once the stream ends.
      const res = await Promise.race([
        app.inject({
          method: "GET",
          url: `/sessions/${SESSION1_ID}/stream`,
          headers: { cookie: `session=${app.signCookie(MEMBER_AUTH_ID)}` },
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      expect(spy).toHaveBeenCalled();
      expect(res, "stream still open").not.toBeNull();
      expect(connectedUserIds().get(SESSION1_ID) ?? []).not.toContain(MEMBER_ID);
    } finally {
      // No mockRestore: it breaks Prisma's delegate, and later calls already
      // go to the real findUnique.
      closeUserStreams(SESSION1_ID, MEMBER_ID);
      await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION1_ID, userId: MEMBER_ID } });
      await prisma.authSession.deleteMany({ where: { id: MEMBER_AUTH_ID } });
      await prisma.user.deleteMany({ where: { discordId: MEMBER_ID } });
    }
  });

  test("stream: a client that stops reading is disconnected", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: `/sessions/${SESSION1_ID}/stream`, headers: { cookie } }, resolve).on(
        "error",
        reject,
      );
    });
    try {
      expect(res.statusCode).toBe(200);
      res.pause();
      const isConnected = () => (connectedUserIds().get(SESSION1_ID) ?? []).includes(USER1_ID);
      expect(isConnected()).toBe(true);

      // Push far more than the socket buffers hold, to a client that reads none of it.
      const blob = "x".repeat(256 * 1024);
      for (let i = 0; i < 200 && isConnected(); i++) {
        broadcast(SESSION1_ID, {
          id: `ev-stall-${i}`,
          sessionId: SESSION1_ID,
          userId: USER1_ID,
          sequence: 100 + i,
          type: "stroke.create",
          payloadJson: { blob },
          clientUuid: `stall-${i}`,
          clientCreatedAt: new Date().toISOString(),
          serverReceivedAt: new Date().toISOString(),
        });
      }
      expect(isConnected()).toBe(false);
    } finally {
      res.destroy();
    }
  });
});
