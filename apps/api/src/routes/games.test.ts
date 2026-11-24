import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameRoutes } from "./games.js";
import { gameImportRoutes } from "./game-imports.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./game-links.js";
import { sessionRoutes } from "./sessions.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-games-gate-user";
const AUTH_SESSION_ID = "test-games-gate-auth";

const CASUAL_GAMES_ID = "home-games";
const EU_NONGATED_KEY = "__test-eu-nongated__";
const CASUAL_GATED_KEY = "__test-casual-gated__";
const EU_SERVER_ID = "1190673594649415730";
const GATE_ROLE_ID = "1514353477231312966";
async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(gameRoutes, { prefix: "/games" });
  await app.ready();
  return app;
}

function signedCookie(app: Awaited<ReturnType<typeof buildTestApp>>, value: string) {
  return `session=${app.signCookie(value)}`;
}

/** Cache the user as an EU guild member with these roles (fresh, so no Discord call). */
async function setEuRoles(roles: string[]) {
  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId: USER_ID, serverId: EU_SERVER_ID } },
    update: { isMember: true, roles, cachedAt: new Date() },
    create: {
      userId: USER_ID,
      serverId: EU_SERVER_ID,
      isMember: true,
      roles,
      cachedAt: new Date(),
    },
  });
}

describe("GET /games — Casual Games and per-game visibility gates", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.game.deleteMany({ where: { gameKey: EU_NONGATED_KEY } });
    await prisma.game.updateMany({
      where: { gameKey: CASUAL_GATED_KEY },
      data: { currentRevisionId: null },
    });
    await prisma.gameRevision.deleteMany({ where: { game: { gameKey: CASUAL_GATED_KEY } } });
    await prisma.game.deleteMany({ where: { gameKey: CASUAL_GATED_KEY } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "testuser-games",
        displayName: "Test Games User",
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

    // Servers + games (race-safe via skipDuplicates for concurrent test suites).
    await prisma.server.createMany({
      data: [
        { id: CASUAL_GAMES_ID, name: "Casual Games" },
        { id: EU_SERVER_ID, name: "JetLag EU" },
      ],
      skipDuplicates: true,
    });
    // A Casual game gated on a role the user holds.
    const gated = await prisma.game.create({
      data: {
        serverId: CASUAL_GAMES_ID,
        unlisted: true,
        name: "Test Casual Gated",
        gameKey: CASUAL_GATED_KEY,
        size: "medium",
      },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: gated.id,
        revision: 1,
        checksum: "test-rev-checksum",
        definition: {
          id: CASUAL_GATED_KEY,
          name: "Test Casual Gated",
          serverId: CASUAL_GAMES_ID,
          visibility: {
            kind: "discord-role",
            guildId: EU_SERVER_ID,
            roleId: GATE_ROLE_ID,
          },
        },
      },
    });
    await prisma.game.update({
      where: { id: gated.id },
      data: { currentRevisionId: rev.id },
    });

    // A non-gated game on the EU server to prove normal listing is unaffected.
    const nonGatedGame = await prisma.game.create({
      data: {
        serverId: EU_SERVER_ID,
        name: "Test EU Non-Gated",
        gameKey: EU_NONGATED_KEY,
        size: "medium",
      },
    });
    const nonGatedRev = await prisma.gameRevision.create({
      data: {
        gameId: nonGatedGame.id,
        revision: 1,
        checksum: "test-eu-nongated-checksum",
        definition: {
          id: EU_NONGATED_KEY,
          name: "Test EU Non-Gated",
          serverId: EU_SERVER_ID,
        },
      },
    });
    await prisma.game.update({
      where: { id: nonGatedGame.id },
      data: { currentRevisionId: nonGatedRev.id },
    });

    app = await buildTestApp();
  });

  afterAll(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.gameRevision.deleteMany({ where: { game: { gameKey: EU_NONGATED_KEY } } });
    await prisma.game.deleteMany({ where: { gameKey: EU_NONGATED_KEY } });
    await prisma.game.updateMany({
      where: { gameKey: CASUAL_GATED_KEY },
      data: { currentRevisionId: null },
    });
    await prisma.gameRevision.deleteMany({ where: { game: { gameKey: CASUAL_GATED_KEY } } });
    await prisma.game.deleteMany({ where: { gameKey: CASUAL_GATED_KEY } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    if (app) {
      await app.close();
    }
  });

  test("returns 401 without a session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/games?serverId=home-games" });
    expect(res.statusCode).toBe(401);
  });

  test("Casual games aren't listed, even for holders of their gate role", async () => {
    await setEuRoles([GATE_ROLE_ID]);

    const res = await app.inject({
      method: "GET",
      url: `/games?serverId=${CASUAL_GAMES_ID}`,
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    // Casual Games has no guild to be a member of: 200, not 403…
    expect(res.statusCode).toBe(200);
    // …but its games start from game links only.
    const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
    expect(gameKeys).not.toContain(CASUAL_GATED_KEY);
  });

  test("someone else's Casual game isn't listed with includeUnlisted either", async () => {
    await setEuRoles([GATE_ROLE_ID]);

    const res = await app.inject({
      method: "GET",
      url: `/games?serverId=${CASUAL_GAMES_ID}&includeUnlisted=true`,
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    expect(res.statusCode).toBe(200);
    const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
    expect(gameKeys).not.toContain(CASUAL_GATED_KEY);
  });

  test("non-gated games on a real server are unaffected by the gate", async () => {
    await setEuRoles([]); // an EU member without any roles

    const res = await app.inject({
      method: "GET",
      url: `/games?serverId=${EU_SERVER_ID}`,
      headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
    });

    expect(res.statusCode).toBe(200);
    const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
    expect(gameKeys).toContain(EU_NONGATED_KEY);
  });
});

describe("DELETE /games/:gameId — archive", () => {
  const SERVER_ID = "test-games-del-server";
  const MANAGER = "test-games-del-manager"; // games.delete + games.edit
  const PLAYER = "test-games-del-player"; // member, no roles
  const USERS = [MANAGER, PLAYER];
  const MANAGER_ROLE = "test-games-del-role";
  const KEY_PREFIX = "test-games-del-";
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const as = (userId: string) => ({ cookie: cookies[userId] });

  function definition(id: string, name: string) {
    return {
      id,
      name,
      serverId: SERVER_ID,
      map: {
        center: [0.5, 0.5],
        playArea: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 1],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
        },
      },
      hidingZones: {
        features: {
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0.5, 0.5] } }],
        },
      },
    };
  }

  // A game with revisions 1..count by MANAGER, the last current.
  async function createGame(key: string, count = 1) {
    let gameId = "";
    for (let n = 1; n <= count; n++) {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?allowUpdate=true",
        headers: as(MANAGER),
        payload: definition(key, `Game ${n}`),
      });
      expect(res.statusCode).toBeLessThan(300);
      gameId = res.json().gameId;
    }
    return prisma.game.findUniqueOrThrow({ where: { id: gameId }, include: { revisions: true } });
  }

  async function sessionOn(gameId: string, revision: number) {
    const rev = await prisma.gameRevision.findFirstOrThrow({ where: { gameId, revision } });
    return prisma.gameSession.create({
      data: {
        gameId,
        serverId: SERVER_ID,
        creatorId: PLAYER,
        name: "Started before the delete",
        gameRevisionId: rev.id,
      },
    });
  }

  const del = (gameId: string, userId = MANAGER) =>
    app.inject({ method: "DELETE", url: `/games/${gameId}`, headers: as(userId) });

  async function cleanup() {
    const games = { gameKey: { startsWith: KEY_PREFIX } };
    await prisma.gameSession.deleteMany({ where: { serverId: SERVER_ID } });
    await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
    await prisma.game.deleteMany({ where: games });
    await prisma.auditLog.deleteMany({ where: { serverId: SERVER_ID } });
    await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
  }

  beforeAll(async () => {
    await cleanup();
    app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(gameRoutes, { prefix: "/games" });
    await app.register(gameImportRoutes, { prefix: "/games" });
    await app.register(gameLinkManagementRoutes, { prefix: "/games" });
    await app.register(gameLinkRoutes, { prefix: "/game-links" });
    await app.register(sessionRoutes, { prefix: "/sessions" });
    await app.ready();

    await prisma.server.create({ data: { id: SERVER_ID, name: "Games Delete Server" } });
    await prisma.rolePermission.createMany({
      data: ["games.delete", "games.edit", "games.create", "server.admin"].map((permission) => ({
        serverId: SERVER_ID,
        discordRoleId: MANAGER_ROLE,
        permission,
      })),
    });
    for (const discordId of USERS) {
      await prisma.user.create({
        data: {
          discordId,
          username: discordId,
          displayName: `${discordId} name`,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const auth = await prisma.authSession.create({
        data: {
          id: `${discordId}-auth`,
          userId: discordId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }
  });

  // Fresh caches, so no request reaches Discord.
  beforeEach(async () => {
    for (const [userId, roles] of [
      [MANAGER, [MANAGER_ROLE]],
      [PLAYER, []],
    ] as const) {
      const row = { isMember: true, roles: [...roles], cachedAt: new Date() };
      await prisma.serverMembershipCache.upsert({
        where: { userId_serverId: { userId, serverId: SERVER_ID } },
        update: row,
        create: { userId, serverId: SERVER_ID, ...row },
      });
    }
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  test("lists each game's uploader and the current revision's upload time", async () => {
    const game = await createGame(`${KEY_PREFIX}listed`, 2);
    const res = await app.inject({
      method: "GET",
      url: `/games?serverId=${SERVER_ID}`,
      headers: as(PLAYER),
    });
    const current = game.revisions.find((r) => r.id === game.currentRevisionId)!;
    expect(res.json().games.find((g: { id: string }) => g.id === game.id)).toMatchObject({
      createdById: MANAGER,
      createdByName: `${MANAGER} name`,
      updatedAt: current.createdAt.toISOString(),
    });
  });

  test("a game without sessions goes with its revisions and links", async () => {
    const game = await createGame(`${KEY_PREFIX}unplayed`, 2);
    await prisma.gameLink.create({
      data: { token: `${KEY_PREFIX}unplayed`, gameId: game.id, createdById: MANAGER },
    });
    expect((await del(game.id, PLAYER)).statusCode).toBe(403);

    expect((await del(game.id)).statusCode).toBe(204);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).toBeNull();
    expect(await prisma.gameRevision.count({ where: { gameId: game.id } })).toBe(0);
    expect(await prisma.gameLink.count({ where: { gameId: game.id } })).toBe(0);
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: game.id, action: "game.delete" },
    });
    expect(entry).toMatchObject({ actorId: MANAGER, details: {} });
  });

  test("a game with sessions leaves every list and route but theirs, until its last session goes", async () => {
    const key = `${KEY_PREFIX}played`;
    const game = await createGame(key, 3);
    const session = await sessionOn(game.id, 1);
    const link = await prisma.gameLink.create({
      data: { token: `${KEY_PREFIX}played`, gameId: game.id, createdById: MANAGER },
    });

    expect((await del(game.id)).statusCode).toBe(204);

    // Revisions 2 and 3: nothing uses them.
    const archived = await prisma.game.findUniqueOrThrow({
      where: { id: game.id },
      include: { revisions: true },
    });
    expect(archived).toMatchObject({
      currentRevisionId: null,
      unlisted: true,
      ownerScope: `archived:${game.id}`,
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.revisions.map((r) => r.revision)).toEqual([1]);
    expect(
      (await prisma.gameLink.findUniqueOrThrow({ where: { id: link.id } })).revokedAt,
    ).not.toBeNull();
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: game.id, action: "game.delete" },
    });
    expect(entry.details).toEqual({ sessions: 1 });

    for (const query of ["", "&includeUnlisted=true"]) {
      const list = await app.inject({
        method: "GET",
        url: `/games?serverId=${SERVER_ID}${query}`,
        headers: as(MANAGER),
      });
      expect(list.json().games.map((g: { id: string }) => g.id)).not.toContain(game.id);
    }
    const stats = await app.inject({
      method: "GET",
      url: `/games/stats?serverId=${SERVER_ID}`,
      headers: as(MANAGER),
    });
    expect(stats.json().stats.map((s: { gameId: string }) => s.gameId)).not.toContain(game.id);
    expect((await app.inject({ method: "GET", url: `/game-links/${link.token}` })).json()).toEqual({
      valid: false,
    });

    // Its session plays on.
    const own = await app.inject({
      method: "GET",
      url: `/sessions/${session.id}`,
      headers: as(PLAYER),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ currentRevision: null, hasNewerRevision: false });

    // Not found for anything else.
    const requests = [
      { method: "DELETE", url: `/games/${game.id}` },
      { method: "PATCH", url: `/games/${game.id}`, payload: { unlisted: false } },
      {
        method: "PATCH",
        url: `/games/${game.id}/settings`,
        payload: { baseRevisionId: game.currentRevisionId, name: "Back" },
      },
      { method: "POST", url: `/games/${game.id}/links` },
      { method: "POST", url: `/games/${game.id}/import`, payload: definition(key, "Back") },
    ] as const;
    for (const request of requests) {
      const res = await app.inject({ ...request, headers: as(MANAGER) });
      expect(res.statusCode, `${request.method} ${request.url}`).toBe(404);
    }

    // The file's id makes a new game; the session stays with the old one.
    const again = await app.inject({
      method: "POST",
      url: "/games/import",
      headers: as(MANAGER),
      payload: definition(key, "Again"),
    });
    expect(again.statusCode).toBe(201);
    expect(again.json().gameId).not.toBe(game.id);

    const gone = await app.inject({
      method: "DELETE",
      url: `/sessions/${session.id}`,
      headers: as(PLAYER),
    });
    expect(gone.statusCode).toBe(204);
    expect(await prisma.game.findUnique({ where: { id: game.id } })).toBeNull();
    expect(await prisma.gameRevision.count({ where: { gameId: game.id } })).toBe(0);
  });

  test("a listing change racing a delete doesn't bring the game back", async () => {
    const game = await createGame(`${KEY_PREFIX}race`);
    await sessionOn(game.id, 1);
    expect((await del(game.id)).statusCode).toBe(204);
    // The PATCH read the game just before the delete committed.
    vi.spyOn(prisma.game, "findUnique").mockResolvedValueOnce(game);

    const res = await app.inject({
      method: "PATCH",
      url: `/games/${game.id}`,
      headers: as(MANAGER),
      payload: { unlisted: false },
    });
    vi.restoreAllMocks();
    expect(res.statusCode).toBe(404);
    expect(await prisma.game.findUniqueOrThrow({ where: { id: game.id } })).toMatchObject({
      unlisted: true,
    });
    expect(
      await prisma.auditLog.count({ where: { targetId: game.id, action: "game.listing" } }),
    ).toBe(0);
  });
});
