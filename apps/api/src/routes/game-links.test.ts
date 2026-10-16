import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameRoutes } from "./games.js";
import { gameImportRoutes } from "./game-imports.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./game-links.js";
import { sessionRoutes } from "./sessions.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const MANAGER_ID = "test-glink-manager";
const PLAYER_ID = "test-glink-player"; // server member without game permissions
const OUTSIDER_ID = "test-glink-outsider"; // not in the server
const USERS = [MANAGER_ID, PLAYER_ID, OUTSIDER_ID];
const SERVER_ID = "test-glink-server";
const MANAGER_ROLE_ID = "test-glink-manager-role";
const LISTED_GAME_ID = "test-glink-listed";
const UNLISTED_GAME_ID = "test-glink-unlisted";
const GAMES = [LISTED_GAME_ID, UNLISTED_GAME_ID];

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  await app.register(gameRoutes, { prefix: "/games" });
  await app.register(gameImportRoutes, { prefix: "/games" });
  await app.register(gameLinkManagementRoutes, { prefix: "/games" });
  await app.register(gameLinkRoutes, { prefix: "/game-links" });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

async function cleanup() {
  const sessions = { gameId: { in: GAMES } };
  await prisma.event.deleteMany({ where: { session: sessions } });
  await prisma.sessionParticipant.deleteMany({ where: { session: sessions } });
  await prisma.gameSession.deleteMany({ where: sessions });
  await prisma.gameLink.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.updateMany({ where: { id: { in: GAMES } }, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.deleteMany({ where: { id: { in: GAMES } } });
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

async function publishRevision(gameId: string, revision: number) {
  const rev = await prisma.gameRevision.create({
    data: {
      gameId,
      revision,
      checksum: `${gameId}-r${revision}`,
      definition: { id: gameId, name: gameId, serverId: SERVER_ID },
    },
  });
  await prisma.game.update({ where: { id: gameId }, data: { currentRevisionId: rev.id } });
  return rev;
}

describe("unlisted games and game links", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  const as = (userId: string) => ({ cookie: cookies[userId] });

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
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const auth = await prisma.authSession.create({
        data: { id: `${discordId}-auth`, userId: discordId, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }

    await prisma.server.create({ data: { id: SERVER_ID, name: "Game Link Server" } });
    await prisma.rolePermission.createMany({
      data: ["games.create", "games.edit"].map((permission) => ({
        serverId: SERVER_ID,
        discordRoleId: MANAGER_ROLE_ID,
        permission,
      })),
    });
    await prisma.game.createMany({
      data: [
        { id: LISTED_GAME_ID, gameKey: LISTED_GAME_ID, serverId: SERVER_ID, name: "Listed" },
        { id: UNLISTED_GAME_ID, gameKey: UNLISTED_GAME_ID, serverId: SERVER_ID, name: "Unlisted", unlisted: true },
      ],
    });
    await publishRevision(LISTED_GAME_ID, 1);
    await publishRevision(UNLISTED_GAME_ID, 1);
  });

  // Fresh membership caches, so no request reaches Discord.
  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.serverMembershipCache.createMany({
      data: [
        { userId: MANAGER_ID, serverId: SERVER_ID, isMember: true, roles: [MANAGER_ROLE_ID], cachedAt: new Date() },
        { userId: PLAYER_ID, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
        { userId: OUTSIDER_ID, serverId: SERVER_ID, isMember: false, roles: [], cachedAt: new Date() },
      ],
    });
    await prisma.game.update({ where: { id: UNLISTED_GAME_ID }, data: { unlisted: true } });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  const listGames = async (userId: string) => {
    const res = await app.inject({ method: "GET", url: `/games?serverId=${SERVER_ID}`, headers: as(userId) });
    expect(res.statusCode).toBe(200);
    return res.json().games as Array<{ id: string; unlisted: boolean }>;
  };

  const createLink = async (gameId: string) => {
    const res = await app.inject({ method: "POST", url: `/games/${gameId}/links`, headers: as(MANAGER_ID) });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; token: string; createdByDisplayName: string };
  };

  const startFromLink = (token: string, userId: string) =>
    app.inject({
      method: "POST",
      url: `/game-links/${token}/sessions`,
      headers: as(userId),
      payload: { name: "From link", visibility: "private" },
    });

  test("unlisted games are only listed for game managers", async () => {
    expect((await listGames(PLAYER_ID)).map((g) => g.id)).toEqual([LISTED_GAME_ID]);
    const managerGames = await listGames(MANAGER_ID);
    expect(managerGames.map((g) => [g.id, g.unlisted])).toEqual([
      [LISTED_GAME_ID, false],
      [UNLISTED_GAME_ID, true],
    ]);
  });

  test("only game managers can start sessions or read definitions of an unlisted game", async () => {
    const create = (userId: string) =>
      app.inject({
        method: "POST",
        url: "/sessions",
        headers: as(userId),
        payload: { gameId: UNLISTED_GAME_ID, name: "Direct", visibility: "private" },
      });
    expect((await create(PLAYER_ID)).statusCode).toBe(403);
    expect((await create(MANAGER_ID)).statusCode).toBe(201);

    const exportAs = (userId: string) =>
      app.inject({ method: "GET", url: `/games/${UNLISTED_GAME_ID}/export`, headers: as(userId) });
    expect((await exportAs(PLAYER_ID)).statusCode).toBe(403);
    expect((await exportAs(MANAGER_ID)).statusCode).toBe(200);
  });

  test("game managers can list and unlist a game; others cannot", async () => {
    const patch = (userId: string, unlisted: boolean) =>
      app.inject({ method: "PATCH", url: `/games/${LISTED_GAME_ID}`, headers: as(userId), payload: { unlisted } });

    expect((await patch(PLAYER_ID, true)).statusCode).toBe(403);

    const res = await patch(MANAGER_ID, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: LISTED_GAME_ID, unlisted: true });
    expect((await listGames(PLAYER_ID)).map((g) => g.id)).toEqual([]);

    expect((await patch(MANAGER_ID, false)).json()).toMatchObject({ unlisted: false });
    expect((await listGames(PLAYER_ID)).map((g) => g.id)).toEqual([LISTED_GAME_ID]);
  });

  test("only game managers can manage links", async () => {
    for (const [method, url] of [
      ["GET", `/games/${UNLISTED_GAME_ID}/links`],
      ["POST", `/games/${UNLISTED_GAME_ID}/links`],
    ] as const) {
      expect((await app.inject({ method, url, headers: as(PLAYER_ID) })).statusCode).toBe(403);
    }
    const link = await createLink(UNLISTED_GAME_ID);
    const del = await app.inject({
      method: "DELETE",
      url: `/games/${UNLISTED_GAME_ID}/links/${link.id}`,
      headers: as(PLAYER_ID),
    });
    expect(del.statusCode).toBe(403);
  });

  test("a link starts sessions for anyone, survives listing changes, and stops when revoked", async () => {
    const link = await createLink(UNLISTED_GAME_ID);
    expect(link.createdByDisplayName).toBe(MANAGER_ID);

    const info = await app.inject({ method: "GET", url: `/game-links/${link.token}` });
    expect(info.json()).toEqual({ valid: true, gameName: "Unlisted", serverName: "Game Link Server" });

    // Neither a member without permissions nor a non-member could use the game directly.
    for (const userId of [PLAYER_ID, OUTSIDER_ID]) {
      const res = await startFromLink(link.token, userId);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ gameId: UNLISTED_GAME_ID, role: "creator", name: "From link" });
      const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: res.json().id } });
      expect(session.gameLinkId).toBe(link.id);

      // The session's participant can load its pinned revision.
      const rev = await app.inject({
        method: "GET",
        url: `/games/revisions/${session.gameRevisionId}?sessionId=${session.id}`,
        headers: as(userId),
      });
      expect(rev.statusCode).toBe(200);
    }

    // Listing or unlisting the game leaves the link alone.
    for (const unlisted of [false, true]) {
      await app.inject({
        method: "PATCH",
        url: `/games/${UNLISTED_GAME_ID}`,
        headers: as(MANAGER_ID),
        payload: { unlisted },
      });
      expect((await startFromLink(link.token, OUTSIDER_ID)).statusCode).toBe(201);
    }

    const listed = await app.inject({ method: "GET", url: `/games/${UNLISTED_GAME_ID}/links`, headers: as(MANAGER_ID) });
    expect(listed.json().links.map((l: { id: string }) => l.id)).toContain(link.id);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/games/${UNLISTED_GAME_ID}/links/${link.id}`,
      headers: as(MANAGER_ID),
    });
    expect(revoke.statusCode).toBe(204);

    expect((await app.inject({ method: "GET", url: `/game-links/${link.token}` })).json()).toEqual({ valid: false });
    expect((await startFromLink(link.token, OUTSIDER_ID)).statusCode).toBe(404);
    const after = await app.inject({ method: "GET", url: `/games/${UNLISTED_GAME_ID}/links`, headers: as(MANAGER_ID) });
    expect(after.json().links.map((l: { id: string }) => l.id)).not.toContain(link.id);
    // Revoking twice, or another game's link, is a 404.
    const again = await app.inject({
      method: "DELETE",
      url: `/games/${UNLISTED_GAME_ID}/links/${link.id}`,
      headers: as(MANAGER_ID),
    });
    expect(again.statusCode).toBe(404);
  });

  test("links are per game, and work for listed games too", async () => {
    const link = await createLink(LISTED_GAME_ID);
    const res = await startFromLink(link.token, OUTSIDER_ID);
    expect(res.statusCode).toBe(201);
    expect(res.json().gameId).toBe(LISTED_GAME_ID);

    const wrongGame = await app.inject({
      method: "DELETE",
      url: `/games/${UNLISTED_GAME_ID}/links/${link.id}`,
      headers: as(MANAGER_ID),
    });
    expect(wrongGame.statusCode).toBe(404);
    expect((await startFromLink(link.token, OUTSIDER_ID)).statusCode).toBe(201);
  });

  test("an unknown link is invalid", async () => {
    expect((await app.inject({ method: "GET", url: "/game-links/nope" })).json()).toEqual({ valid: false });
    expect((await startFromLink("nope", PLAYER_ID)).statusCode).toBe(404);
  });

  test("a session started from a link can upgrade while the link is active", async () => {
    const link = await createLink(UNLISTED_GAME_ID);
    const started = await startFromLink(link.token, OUTSIDER_ID);
    const sessionId = started.json().id as string;

    await publishRevision(UNLISTED_GAME_ID, 2);
    const upgrade = () =>
      app.inject({ method: "POST", url: `/sessions/${sessionId}/upgrade-revision`, headers: as(OUTSIDER_ID) });

    const res = await upgrade();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "upgraded", newRevision: 2 });

    await app.inject({ method: "DELETE", url: `/games/${UNLISTED_GAME_ID}/links/${link.id}`, headers: as(MANAGER_ID) });
    await publishRevision(UNLISTED_GAME_ID, 3);
    expect((await upgrade()).statusCode).toBe(403);
  });

  test("an import can create a game unlisted, and leaves an existing game's listing alone", async () => {
    const gameKey = "test-glink-imported";
    await prisma.game.deleteMany({ where: { gameKey } });
    const definition = (name: string) => ({
      id: gameKey,
      name,
      serverId: SERVER_ID,
      map: {
        center: [0.5, 0.5],
        playArea: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
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
    });
    try {
      const create = await app.inject({
        method: "POST",
        url: "/games/import?unlisted=true",
        headers: as(MANAGER_ID),
        payload: definition("Imported"),
      });
      expect(create.statusCode, create.body).toBe(201);
      expect((await prisma.game.findUniqueOrThrow({ where: { gameKey } })).unlisted).toBe(true);

      await prisma.game.update({ where: { gameKey }, data: { unlisted: false } });
      const update = await app.inject({
        method: "POST",
        url: "/games/import?unlisted=true&allowUpdate=true",
        headers: as(MANAGER_ID),
        payload: definition("Imported v2"),
      });
      expect(update.statusCode, update.body).toBe(200);
      expect((await prisma.game.findUniqueOrThrow({ where: { gameKey } })).unlisted).toBe(false);
    } finally {
      const game = await prisma.game.findUnique({ where: { gameKey } });
      if (game) {
        await prisma.game.update({ where: { id: game.id }, data: { currentRevisionId: null } });
        await prisma.game.delete({ where: { id: game.id } });
      }
    }
  });
});
