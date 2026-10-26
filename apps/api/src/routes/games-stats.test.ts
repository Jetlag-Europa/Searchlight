import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { addPresence, removePresence } from "../lib/broadcaster.js";
import { gameRoutes } from "./games.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const ADMIN_ID = "test-gstats-admin"; // server.admin through a role
const MANAGER_ID = "test-gstats-manager"; // game permissions, no server.admin
const PLAYER_A = "test-gstats-player-a";
const PLAYER_B = "test-gstats-player-b";
const VIEWER_ID = "test-gstats-viewer";
const USERS = [ADMIN_ID, MANAGER_ID, PLAYER_A, PLAYER_B, VIEWER_ID];
const SERVER_ID = "test-gstats-server";
const ADMIN_ROLE_ID = "test-gstats-admin-role";
const MANAGER_ROLE_ID = "test-gstats-manager-role";
const BUSY_GAME_ID = "test-gstats-busy";
const QUIET_GAME_ID = "test-gstats-quiet";
const NEW_GAME_ID = "test-gstats-new";
const GAMES = [BUSY_GAME_ID, QUIET_GAME_ID, NEW_GAME_ID];
const RECENT_SESSION_ID = "test-gstats-recent";
const OLD_SESSION_ID = "test-gstats-old";
const NEW_SESSION_ID = "test-gstats-new-session";

const DAY = 86_400_000;

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  await app.register(gameRoutes, { prefix: "/games" });
  await app.ready();
  return app;
}

async function cleanup() {
  const sessions = { gameId: { in: GAMES } };
  await prisma.event.deleteMany({ where: { session: sessions } });
  await prisma.sessionQuestion.deleteMany({ where: { session: sessions } });
  await prisma.sessionParticipant.deleteMany({ where: { session: sessions } });
  await prisma.gameSession.deleteMany({ where: sessions });
  await prisma.game.updateMany({ where: { id: { in: GAMES } }, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.deleteMany({ where: { id: { in: GAMES } } });
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

async function createSession(id: string, createdAt: Date, revisionId: string, gameId = BUSY_GAME_ID) {
  await prisma.gameSession.create({
    data: {
      id,
      gameId,
      serverId: SERVER_ID,
      creatorId: PLAYER_A,
      name: `${id} name`,
      gameRevisionId: revisionId,
      createdAt,
      participants: {
        create: [
          { userId: PLAYER_A, role: "creator", acceptedAt: createdAt },
          { userId: PLAYER_B, role: "member", acceptedAt: createdAt },
        ],
      },
    },
  });
}

describe("GET /games/stats", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const as = (userId: string) => ({ cookie: cookies[userId] });
  let newSessionCreatedAt: Date;

  beforeAll(async () => {
    await cleanup();
    app = await buildTestApp();

    for (const discordId of USERS) {
      await prisma.user.create({
        data: {
          discordId,
          username: discordId,
          displayName: discordId,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + DAY),
        },
      });
      const auth = await prisma.authSession.create({
        data: { id: `${discordId}-auth`, userId: discordId, expiresAt: new Date(Date.now() + DAY) },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }

    await prisma.server.create({ data: { id: SERVER_ID, name: "Game Stats Server" } });
    await prisma.rolePermission.createMany({
      data: [
        { serverId: SERVER_ID, discordRoleId: ADMIN_ROLE_ID, permission: "server.admin" },
        ...["games.create", "games.edit", "games.delete"].map((permission) => ({
          serverId: SERVER_ID,
          discordRoleId: MANAGER_ROLE_ID,
          permission,
        })),
      ],
    });
    await prisma.game.createMany({
      data: GAMES.map((id) => ({ id, gameKey: id, serverId: SERVER_ID, name: id })),
    });
    const createRevision = (gameId: string) =>
      prisma.gameRevision.create({
        data: { gameId, revision: 1, checksum: `${gameId}-r1`, definition: { id: gameId, name: gameId, serverId: SERVER_ID } },
      });
    const revision = await createRevision(BUSY_GAME_ID);

    // One session played today, one last played 10 days ago.
    await createSession(RECENT_SESSION_ID, new Date(Date.now() - 3 * DAY), revision.id);
    await createSession(OLD_SESSION_ID, new Date(Date.now() - 20 * DAY), revision.id);
    // Created 20 hours ago and never changed: its creation is its last activity.
    newSessionCreatedAt = new Date(Date.now() - (20 * DAY) / 24);
    await createSession(NEW_SESSION_ID, newSessionCreatedAt, (await createRevision(NEW_GAME_ID)).id, NEW_GAME_ID);
    await prisma.event.createMany({
      data: [
        { sessionId: RECENT_SESSION_ID, at: Date.now() - DAY / 24 },
        { sessionId: OLD_SESSION_ID, at: Date.now() - 10 * DAY },
      ].map(({ sessionId, at }, i) => ({
        sessionId,
        userId: PLAYER_A,
        sequence: 1,
        type: "stroke.create",
        payloadJson: {},
        clientUuid: `test-gstats-event-${i}`,
        clientCreatedAt: new Date(at),
        serverReceivedAt: new Date(at),
      })),
    });
    await prisma.sessionQuestion.createMany({
      data: [RECENT_SESSION_ID, RECENT_SESSION_ID, OLD_SESSION_ID].map((sessionId, i) => ({
        sessionId,
        payloadJson: {},
        ordinal: i,
        clientUuid: `test-gstats-question-${i}`,
      })),
    });
  });

  // Fresh membership caches, so no request reaches Discord.
  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.serverMembershipCache.createMany({
      data: [
        { userId: ADMIN_ID, serverId: SERVER_ID, isMember: true, roles: [ADMIN_ROLE_ID], cachedAt: new Date() },
        { userId: MANAGER_ID, serverId: SERVER_ID, isMember: true, roles: [MANAGER_ROLE_ID], cachedAt: new Date() },
        { userId: PLAYER_A, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  const getStats = (userId: string, serverId = SERVER_ID) =>
    app.inject({ method: "GET", url: `/games/stats?serverId=${serverId}`, headers: as(userId) });

  test("sums each game's sessions for a server admin", async () => {
    const user = { userId: PLAYER_A, displayName: PLAYER_A, avatarUrl: "https://example.com/a.png" };
    addPresence(RECENT_SESSION_ID, user);
    addPresence(RECENT_SESSION_ID, user); // a second tab
    try {
      const res = await getStats(ADMIN_ID);
      expect(res.statusCode).toBe(200);
      const stats = res.json().stats as Array<Record<string, unknown>>;
      const busy = stats.find((s) => s.gameId === BUSY_GAME_ID)!;
      expect(busy).toMatchObject({
        liveSessions: 1,
        livePlayers: 1,
        activeSessions24h: 1,
        activeSessions7d: 1,
        totalSessions: 2,
        players: 2,
        questions: 3,
      });
      expect(Date.now() - Date.parse(busy.lastActivityAt as string)).toBeLessThan(DAY / 12);
      expect(stats.find((s) => s.gameId === QUIET_GAME_ID)).toEqual({
        gameId: QUIET_GAME_ID,
        liveSessions: 0,
        livePlayers: 0,
        activeSessions24h: 0,
        activeSessions7d: 0,
        totalSessions: 0,
        players: 0,
        questions: 0,
        lastActivityAt: null,
      });

      expect(stats.find((s) => s.gameId === NEW_GAME_ID)).toMatchObject({
        activeSessions24h: 1,
        activeSessions7d: 1,
        totalSessions: 1,
        lastActivityAt: newSessionCreatedAt.toISOString(),
      });

      // Nothing that leads to a session or a player.
      for (const secret of [RECENT_SESSION_ID, OLD_SESSION_ID, NEW_SESSION_ID, PLAYER_A, PLAYER_B]) {
        expect(res.body).not.toContain(secret);
      }
    } finally {
      removePresence(RECENT_SESSION_ID, PLAYER_A);
      removePresence(RECENT_SESSION_ID, PLAYER_A);
    }
  });

  test("leaves viewers out of players and live players", async () => {
    await prisma.sessionParticipant.createMany({
      data: [RECENT_SESSION_ID, OLD_SESSION_ID].map((sessionId) => ({
        sessionId,
        userId: VIEWER_ID,
        role: "viewer" as const,
        acceptedAt: new Date(),
      })),
    });
    const viewer = { userId: VIEWER_ID, displayName: VIEWER_ID, avatarUrl: "https://example.com/a.png" };
    const player = { userId: PLAYER_B, displayName: PLAYER_B, avatarUrl: "https://example.com/a.png" };
    addPresence(RECENT_SESSION_ID, player);
    addPresence(RECENT_SESSION_ID, viewer);
    // Only watched: not live.
    addPresence(OLD_SESSION_ID, viewer);
    try {
      const res = await getStats(ADMIN_ID);
      const busy = (res.json().stats as Array<Record<string, unknown>>).find((s) => s.gameId === BUSY_GAME_ID);
      expect(busy).toMatchObject({ liveSessions: 1, livePlayers: 1, players: 2 });
    } finally {
      removePresence(RECENT_SESSION_ID, PLAYER_B);
      removePresence(RECENT_SESSION_ID, VIEWER_ID);
      removePresence(OLD_SESSION_ID, VIEWER_ID);
      await prisma.sessionParticipant.deleteMany({ where: { userId: VIEWER_ID } });
    }
  });

  test("refuses game managers without server.admin and players", async () => {
    expect((await getStats(MANAGER_ID)).statusCode).toBe(403);
    expect((await getStats(PLAYER_A)).statusCode).toBe(403);
  });

  test("404s for an unknown server", async () => {
    expect((await getStats(ADMIN_ID, "test-gstats-missing")).statusCode).toBe(404);
  });
});
