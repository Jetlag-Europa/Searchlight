import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { sessionRoutes } from "./sessions.js";
import { linkRoutes } from "./links.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const CREATOR_ID = "test-sshare-creator";
const FRIEND_ID = "test-sshare-friend";
const SERVER_ID = "test-sshare-server";
const GAME_ID = "test-sshare-game";
const SESSION_ID = "test-sshare-session";
const CREATOR_AUTH_ID = "test-sshare-auth-creator";
const FRIEND_AUTH_ID = "test-sshare-auth-friend";
const USER_IDS = [CREATOR_ID, FRIEND_ID];

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.register(linkRoutes, { prefix: "/links" });
  await app.ready();
  return app;
}

// Sessions created by the routes under test (forks, POST /sessions) get
// generated ids, so clean up everything on this suite's game.
async function deleteSessions() {
  const where = { gameId: GAME_ID };
  const ids = (await prisma.gameSession.findMany({ where, select: { id: true } })).map((s) => s.id);
  await prisma.sessionLink.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.sessionQuestion.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.event.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.sessionParticipant.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.gameSession.deleteMany({ where });
}

async function cleanup() {
  await deleteSessions();
  await prisma.authSession.deleteMany({ where: { id: { in: [CREATOR_AUTH_ID, FRIEND_AUTH_ID] } } });
  await prisma.serverMembershipCache.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
  await prisma.game.deleteMany({ where: { id: GAME_ID } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USER_IDS } } });
}

describe("session sharing and links", () => {
  let app: FastifyInstance;
  let creatorCookie: string;
  let friendCookie: string;
  let revisionId: string;

  beforeAll(async () => {
    await cleanup();

    for (const [discordId, username] of [
      [CREATOR_ID, "ssharecreator"],
      [FRIEND_ID, "sshareFriend"],
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

    await prisma.server.create({ data: { id: SERVER_ID, name: "Share Server" } });
    await prisma.game.create({
      data: { id: GAME_ID, serverId: SERVER_ID, name: "Share Game", gameKey: "sshare-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: GAME_ID,
        revision: 1,
        checksum: "sshare-rev-checksum",
        definition: { id: "sshare-game", name: "Share Game", serverId: SERVER_ID },
      },
    });
    revisionId = rev.id;
    await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: rev.id } });

    // Creating a session checks server membership; a fresh cache entry
    // answers it without calling Discord.
    await prisma.serverMembershipCache.create({
      data: { userId: CREATOR_ID, serverId: SERVER_ID, isMember: true, cachedAt: new Date() },
    });

    await prisma.authSession.createMany({
      data: [
        { id: CREATOR_AUTH_ID, userId: CREATOR_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: FRIEND_AUTH_ID, userId: FRIEND_ID, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    app = await buildTestApp();
    creatorCookie = `session=${app.signCookie(CREATOR_AUTH_ID)}`;
    friendCookie = `session=${app.signCookie(FRIEND_AUTH_ID)}`;
  });

  // Every test starts from a fresh private session owned by the creator.
  beforeEach(async () => {
    await deleteSessions();
    await prisma.gameSession.create({
      data: {
        id: SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: CREATOR_ID,
        name: "Share Session",
        visibility: "private",
        gameRevisionId: revisionId,
      },
    });
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: CREATOR_ID, role: "creator", acceptedAt: new Date() },
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  async function createLink(linkType: "join" | "fork") {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/links`,
      headers: { cookie: creatorCookie },
      payload: { linkType },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { token: string }).token;
  }

  function redeem(token: string, cookie = friendCookie) {
    return app.inject({
      method: "POST",
      url: `/links/${token}/redeem`,
      headers: { cookie },
    });
  }

  async function listedSessionIds(cookie: string) {
    const res = await app.inject({
      method: "GET",
      url: `/sessions?serverId=${SERVER_ID}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessions: { id: string }[] }).sessions.map((s) => s.id);
  }

  test("a session created without a visibility starts private", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { cookie: creatorCookie },
      payload: { gameId: GAME_ID, name: "No visibility" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().visibility).toBe("private");
  });

  test("a join link makes the session shared, so it is listed after joining", async () => {
    const token = await createLink("join");
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
    expect(session.visibility).toBe("shared");

    const res = await redeem(token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "join" });
    expect(await listedSessionIds(friendCookie)).toContain(SESSION_ID);
  });

  test("joining a still-private session by link makes it shared", async () => {
    const token = await createLink("join");
    await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { visibility: "private" } });
    expect((await redeem(token)).statusCode).toBe(200);
    expect(await listedSessionIds(friendCookie)).toContain(SESSION_ID);
  });

  test("a revoked link no longer redeems, and members who joined stay in", async () => {
    const token = await createLink("join");
    expect((await redeem(token)).statusCode).toBe(200);

    const link = await prisma.sessionLink.findUniqueOrThrow({ where: { token } });
    const revoke = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/links/${link.id}`,
      headers: { cookie: creatorCookie },
    });
    expect(revoke.statusCode).toBe(204);

    expect((await redeem(token)).statusCode).toBe(404);
    expect(await listedSessionIds(friendCookie)).toContain(SESSION_ID);
  });

  test("a participant who left can rejoin through the same join link", async () => {
    const token = await createLink("join");
    expect((await redeem(token)).statusCode).toBe(200);

    const leave = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/leave`,
      headers: { cookie: friendCookie },
    });
    expect(leave.statusCode).toBe(204);
    expect(await listedSessionIds(friendCookie)).not.toContain(SESSION_ID);

    expect((await redeem(token)).statusCode).toBe(200);
    expect(await listedSessionIds(friendCookie)).toContain(SESSION_ID);
  });

  test("only the creator can create, list or revoke links", async () => {
    const token = await createLink("join");
    expect((await redeem(token)).statusCode).toBe(200);
    const link = await prisma.sessionLink.findUniqueOrThrow({ where: { token } });

    const create = await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/links`,
      headers: { cookie: friendCookie },
      payload: { linkType: "join" },
    });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}/links`,
      headers: { cookie: friendCookie },
    });
    expect(list.statusCode).toBe(403);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/links/${link.id}`,
      headers: { cookie: friendCookie },
    });
    expect(revoke.statusCode).toBe(403);

    const after = await prisma.sessionLink.findMany({ where: { sessionId: SESSION_ID } });
    expect(after).toEqual([expect.objectContaining({ id: link.id, revokedAt: null })]);
  });

  test("a share link gives the recipient a private copy they created", async () => {
    const token = await createLink("fork");
    const res = await redeem(token);
    expect(res.statusCode).toBe(200);
    const { sessionId } = res.json() as { sessionId: string };

    const copy = await prisma.gameSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(copy.creatorId).toBe(FRIEND_ID);
    expect(copy.visibility).toBe("private");

    const detail = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { cookie: friendCookie },
    });
    expect(detail.json().participants).toEqual([
      expect.objectContaining({ userId: FRIEND_ID, role: "creator" }),
    ]);

    // The original stays private: a copy does not let anyone in.
    const original = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
    expect(original.visibility).toBe("private");
    expect(await listedSessionIds(friendCookie)).not.toContain(SESSION_ID);
  });

  test("kicking someone who is not in the session is a 404", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/participants/${FRIEND_ID}`,
      headers: { cookie: creatorCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  test("PATCH returns the session's revision fields", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}`,
      headers: { cookie: creatorCookie },
      payload: { visibility: "shared" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      visibility: "shared",
      gameRevisionId: revisionId,
      sessionRevision: 1,
      currentRevision: 1,
      hasNewerRevision: false,
    });
  });

  test("the creator opening their own join link is taken to the session", async () => {
    const res = await redeem(await createLink("join"), creatorCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "join" });
  });

  test("the creator cannot take a copy from their own share link", async () => {
    const res = await redeem(await createLink("fork"), creatorCookie);
    expect(res.statusCode).toBe(403);
    // A share link must not make the original shared.
    const original = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
    expect(original.visibility).toBe("private");
  });
});
