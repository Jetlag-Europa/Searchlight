import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { sessionRoutes } from "./sessions.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const CREATOR_ID = "test-spatch-creator";
const MEMBER_ID = "test-spatch-member";
const SERVER_ID = "test-spatch-server";
const OTHER_SERVER_ID = "test-spatch-server2";
const GAME_ID = "test-spatch-game";
const SESSION_ID = "test-spatch-session";
const CREATOR_AUTH_ID = "test-spatch-auth-creator";
const MEMBER_AUTH_ID = "test-spatch-auth-member";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

async function cleanup() {
  await prisma.event.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.authSession.deleteMany({ where: { id: { in: [CREATOR_AUTH_ID, MEMBER_AUTH_ID] } } });
  await prisma.gameSession.deleteMany({ where: { id: SESSION_ID } });
  await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
  await prisma.game.deleteMany({ where: { id: GAME_ID } });
  await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
  await prisma.user.deleteMany({ where: { discordId: { in: [CREATOR_ID, MEMBER_ID] } } });
}

describe("PATCH /sessions/:sessionId permissions", () => {
  let app: FastifyInstance;
  let creatorCookie: string;
  let memberCookie: string;
  let revisionId: string;

  beforeAll(async () => {
    await cleanup();

    for (const [discordId, username] of [
      [CREATOR_ID, "spatchcreator"],
      [MEMBER_ID, "spatchmember"],
    ] as const) {
      await prisma.user.create({
        data: {
          discordId,
          username,
          displayName: username,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }

    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Patch Server" },
        { id: OTHER_SERVER_ID, name: "Other Server" },
      ],
    });
    await prisma.game.create({
      data: { id: GAME_ID, serverId: SERVER_ID, name: "Patch Game", gameKey: "spatch-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: GAME_ID,
        revision: 1,
        checksum: "spatch-rev-checksum",
        definition: { id: "spatch-game", name: "Patch Game", serverId: SERVER_ID },
      },
    });
    revisionId = rev.id;

    await prisma.gameSession.create({
      data: {
        id: SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: CREATOR_ID,
        name: "Patch Session",
        visibility: "shared",
        gameRevisionId: rev.id,
      },
    });
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: MEMBER_ID, role: "member", acceptedAt: new Date() },
    });

    await prisma.authSession.createMany({
      data: [
        { id: CREATOR_AUTH_ID, userId: CREATOR_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: MEMBER_AUTH_ID, userId: MEMBER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    app = await buildTestApp();
    creatorCookie = `session=${app.signCookie(CREATOR_AUTH_ID)}`;
    memberCookie = `session=${app.signCookie(MEMBER_AUTH_ID)}`;
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  function patch(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}`,
      headers: { cookie },
      payload,
    });
  }

  async function loadSession() {
    return prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
  }

  test("a member cannot take over the session by sending creatorId", async () => {
    const res = await patch(memberCookie, { creatorId: MEMBER_ID, hiderLat: 1, hiderLng: 2 });
    // Unknown fields are dropped, not rejected, so the allowed part still applies.
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.creatorId).toBe(CREATOR_ID);
    expect(s.hiderLat).toBe(1);
    expect(s.hiderLng).toBe(2);
  });

  test("a member cannot move the session to another server, game or revision", async () => {
    await patch(memberCookie, {
      serverId: OTHER_SERVER_ID,
      gameId: "some-other-game",
      gameRevisionId: "some-other-revision",
    });
    const s = await loadSession();
    expect(s.serverId).toBe(SERVER_ID);
    expect(s.gameId).toBe(GAME_ID);
    expect(s.gameRevisionId).toBe(revisionId);
  });

  test("a member cannot rewind the event sequence", async () => {
    await patch(memberCookie, { hiderLat: 10, hiderLng: 20 });
    const before = (await loadSession()).eventSequence;
    expect(before).toBeGreaterThan(0);

    await patch(memberCookie, { eventSequence: 0 });
    expect((await loadSession()).eventSequence).toBe(before);
  });

  test("the creator cannot write unlisted fields either", async () => {
    await patch(creatorCookie, { creatorId: MEMBER_ID, serverId: OTHER_SERVER_ID });
    const s = await loadSession();
    expect(s.creatorId).toBe(CREATOR_ID);
    expect(s.serverId).toBe(SERVER_ID);
  });

  test("a member cannot change name or visibility", async () => {
    const res = await patch(memberCookie, { name: "Hijacked", visibility: "private" });
    expect(res.statusCode).toBe(403);
    const s = await loadSession();
    expect(s.name).toBe("Patch Session");
    expect(s.visibility).toBe("shared");
  });

  test("a member can still update the hider position and planning mode", async () => {
    const res = await patch(memberCookie, { hiderLat: 47.1, hiderLng: 8.5, planningModeEnabled: true });
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.hiderLat).toBe(47.1);
    expect(s.hiderLng).toBe(8.5);
    expect(s.planningModeEnabled).toBe(true);
  });

  test("the creator can still rename the session", async () => {
    const res = await patch(creatorCookie, { name: "Renamed" });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).name).toBe("Renamed");
  });
});
