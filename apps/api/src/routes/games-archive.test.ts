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
const MANAGER_ID = "test-garchive-manager";
const PLAYER_ID = "test-garchive-player"; // server member without game permissions
const USERS = [MANAGER_ID, PLAYER_ID];
const SERVER_ID = "test-garchive-server";
const MANAGER_ROLE_ID = "test-garchive-manager-role";
const PAST_GAME_ID = "test-garchive-past";
const NEW_GAME_ID = "test-garchive-new";
const UNDATED_GAME_ID = "test-garchive-undated";
const GAMES = [PAST_GAME_ID, NEW_GAME_ID, UNDATED_GAME_ID];
const RULES = "https://docs.google.com/document/d/garchive/edit";

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

describe("archived games and game details", () => {
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

    await prisma.server.create({ data: { id: SERVER_ID, name: "Archive Server" } });
    await prisma.rolePermission.createMany({
      data: ["games.create", "games.edit", "games.delete"].map((permission) => ({
        serverId: SERVER_ID,
        discordRoleId: MANAGER_ROLE_ID,
        permission,
      })),
    });
    await prisma.game.createMany({
      data: [
        { id: PAST_GAME_ID, gameKey: PAST_GAME_ID, serverId: SERVER_ID, name: "Past", date: new Date("2026-05-30") },
        { id: NEW_GAME_ID, gameKey: NEW_GAME_ID, serverId: SERVER_ID, name: "New", date: new Date("2026-10-02") },
        { id: UNDATED_GAME_ID, gameKey: UNDATED_GAME_ID, serverId: SERVER_ID, name: "Anytime" },
      ],
    });
    for (const gameId of GAMES) {
      const rev = await prisma.gameRevision.create({
        data: { gameId, revision: 1, checksum: `${gameId}-r1`, definition: { id: gameId, name: gameId, serverId: SERVER_ID } },
      });
      await prisma.game.update({ where: { id: gameId }, data: { currentRevisionId: rev.id } });
    }
  });

  // Fresh membership caches, so no request reaches Discord.
  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.serverMembershipCache.createMany({
      data: [
        { userId: MANAGER_ID, serverId: SERVER_ID, isMember: true, roles: [MANAGER_ROLE_ID], cachedAt: new Date() },
        { userId: PLAYER_ID, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
      ],
    });
    await prisma.game.update({ where: { id: PAST_GAME_ID }, data: { archivedAt: null, rulesUrl: null } });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  const listGames = async (query = "") => {
    const res = await app.inject({ method: "GET", url: `/games?serverId=${SERVER_ID}${query}`, headers: as(PLAYER_ID) });
    expect(res.statusCode).toBe(200);
    return (res.json().games as Array<{ id: string }>).map((g) => g.id);
  };
  const patch = (userId: string, gameId: string, payload: object) =>
    app.inject({ method: "PATCH", url: `/games/${gameId}`, headers: as(userId), payload });
  const startSession = (gameId: string) =>
    app.inject({ method: "POST", url: "/sessions", headers: as(PLAYER_ID), payload: { gameId, name: "Replay" } });

  test("lists the newest event first, then undated games", async () => {
    expect(await listGames()).toEqual([NEW_GAME_ID, PAST_GAME_ID, UNDATED_GAME_ID]);
  });

  test("game managers archive a game: it leaves game lists unless asked for, and stays playable", async () => {
    expect((await patch(PLAYER_ID, PAST_GAME_ID, { archived: true })).statusCode).toBe(403);

    const archived = await patch(MANAGER_ID, PAST_GAME_ID, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).toEqual(expect.any(String));
    // Archiving again keeps the original time.
    expect((await patch(MANAGER_ID, PAST_GAME_ID, { archived: true })).json().archivedAt).toBe(
      archived.json().archivedAt,
    );

    expect(await listGames()).toEqual([NEW_GAME_ID, UNDATED_GAME_ID]);
    expect(await listGames("&includeArchived=true")).toEqual([NEW_GAME_ID, PAST_GAME_ID, UNDATED_GAME_ID]);

    // Still playable directly and from a game link.
    expect((await startSession(PAST_GAME_ID)).statusCode).toBe(201);
    const link = await app.inject({ method: "POST", url: `/games/${PAST_GAME_ID}/links`, headers: as(MANAGER_ID) });
    const fromLink = await app.inject({
      method: "POST",
      url: `/game-links/${link.json().token}/sessions`,
      headers: as(PLAYER_ID),
      payload: { name: "From link", visibility: "private" },
    });
    expect(fromLink.statusCode).toBe(201);

    expect((await patch(MANAGER_ID, PAST_GAME_ID, { archived: false })).json().archivedAt).toBeNull();
    expect(await listGames()).toContain(PAST_GAME_ID);
  });

  test("game managers set the date, end date and rules link; sessions carry the link", async () => {
    const res = await patch(MANAGER_ID, PAST_GAME_ID, { date: "2026-05-30", endDate: "2026-05-31", rulesUrl: RULES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ date: "2026-05-30", endDate: "2026-05-31", rulesUrl: RULES });

    const session = await startSession(PAST_GAME_ID);
    expect(session.json().rulesUrl).toBe(RULES);
    const listed = await app.inject({ method: "GET", url: `/sessions?serverId=${SERVER_ID}`, headers: as(PLAYER_ID) });
    expect(listed.json().sessions.find((s: { id: string }) => s.id === session.json().id).rulesUrl).toBe(RULES);
    const opened = await app.inject({ method: "GET", url: `/sessions/${session.json().id}`, headers: as(PLAYER_ID) });
    expect(opened.json().rulesUrl).toBe(RULES);
    const link = await app.inject({ method: "POST", url: `/games/${PAST_GAME_ID}/links`, headers: as(MANAGER_ID) });
    const fromLink = await app.inject({
      method: "POST",
      url: `/game-links/${link.json().token}/sessions`,
      headers: as(PLAYER_ID),
      payload: { name: "From link", visibility: "private" },
    });
    expect(fromLink.json().rulesUrl).toBe(RULES);

    // Exports carry the details, so a saved export keeps them; the ETag follows them.
    const exported = await app.inject({ method: "GET", url: `/games/${PAST_GAME_ID}/export`, headers: as(MANAGER_ID) });
    expect(exported.json()).toMatchObject({ date: "2026-05-30", endDate: "2026-05-31", rulesUrl: RULES });
    expect(Object.keys(exported.json()).slice(0, 4)).toEqual(["id", "name", "serverId", "date"]);

    const cleared = await patch(MANAGER_ID, PAST_GAME_ID, { endDate: null, date: "2026-05-30", rulesUrl: null });
    expect(cleared.json()).toMatchObject({ date: "2026-05-30", endDate: null, rulesUrl: null });
    const reexported = await app.inject({ method: "GET", url: `/games/${PAST_GAME_ID}/export`, headers: as(MANAGER_ID) });
    expect(reexported.json()).not.toHaveProperty("rulesUrl");
    expect(reexported.headers.etag).not.toBe(exported.headers.etag);
  });

  test("refuses details that don't fit, and a date without its end date", async () => {
    for (const body of [
      { date: "2026-05-30" },
      { date: "2026-02-30", endDate: null },
      { date: "2026-05-30", endDate: "2026-05-29" },
      { date: null, endDate: "2026-05-29" },
      { rulesUrl: "http://example.com/rules" },
      {},
      { archive: true }, // a typo: unknown keys are stripped, leaving nothing to change
    ]) {
      expect((await patch(MANAGER_ID, PAST_GAME_ID, body)).statusCode).toBe(400);
    }
  });

  test("a game with sessions can't be deleted, and the refusal points to archiving", async () => {
    await startSession(NEW_GAME_ID);
    const res = await app.inject({ method: "DELETE", url: `/games/${NEW_GAME_ID}`, headers: as(MANAGER_ID) });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/archive it instead/i);
  });
});
