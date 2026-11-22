import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// Roles come from fresh membership caches, so Discord is only asked for role names.
vi.mock("../lib/discord-client.js", () => ({
  discord: {
    getGuildMember: vi.fn().mockResolvedValue(null),
    getGuildRoles: vi.fn().mockResolvedValue([{ id: "r1", name: "Mods" }]),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { CASUAL_SERVER_ID, type AuditLogResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { importGameDefinition } from "../games/import-service.js";
import { auditLogRoutes } from "./audit-log.js";
import { gameRoutes } from "./games.js";
import { serverRoutes } from "./servers.js";

const SERVER_ID = "test-audit-server";
const OTHER_SERVER_ID = "test-audit-other";
const SERVERS = [SERVER_ID, OTHER_SERVER_ID];
const ADMIN_ROLE = "test-audit-admin-role";
const GLOBAL_ADMIN = "test-audit-global";
const SERVER_ADMIN = "test-audit-server-admin";
const MEMBER = "test-audit-member";
const USERS = [GLOBAL_ADMIN, SERVER_ADMIN, MEMBER];
const GAME_KEY = "test-audit-game";
const DAY = 86_400_000;

function definition(name: string) {
  return {
    id: GAME_KEY,
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

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { serverId: { in: SERVERS } } });
  const games = { gameKey: GAME_KEY };
  await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { game: games } });
  await prisma.game.deleteMany({ where: games });
  await prisma.rolePermission.deleteMany({ where: { serverId: { in: SERVERS } } });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: { in: SERVERS } } });
}

describe("/audit-log", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const previousAdmins = env.ADMIN_DISCORD_IDS;

  beforeAll(async () => {
    await cleanup();
    env.ADMIN_DISCORD_IDS = GLOBAL_ADMIN;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(auditLogRoutes, { prefix: "/audit-log" });
    await app.register(gameRoutes, { prefix: "/games" });
    await app.register(serverRoutes, { prefix: "/servers" });
    await app.ready();

    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Audit Server" },
        { id: OTHER_SERVER_ID, name: "Audit Other" },
      ],
    });
    await prisma.server.createMany({
      data: [{ id: CASUAL_SERVER_ID, name: "Casual Games" }],
      skipDuplicates: true,
    });
    await prisma.rolePermission.create({
      data: { serverId: SERVER_ID, discordRoleId: ADMIN_ROLE, permission: "server.admin" },
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
          discordTokenExpiresAt: new Date(Date.now() + DAY),
          sessions: { create: { id: `${discordId}-auth`, expiresAt: new Date(Date.now() + DAY) } },
          membershipCaches: {
            create: {
              serverId: SERVER_ID,
              isMember: true,
              roles: discordId === SERVER_ADMIN ? [ADMIN_ROLE] : [],
              cachedAt: new Date(),
            },
          },
        },
      });
      cookies[discordId] = `session=${app.signCookie(`${discordId}-auth`)}`;
    }
  });

  afterAll(async () => {
    env.ADMIN_DISCORD_IDS = previousAdmins;
    await app.close();
    await cleanup();
  });

  const read = (userId: string, query = "") =>
    app.inject({ url: `/audit-log${query}`, headers: { cookie: cookies[userId] } });

  test("logs game and role changes, and keeps them once the game is deleted", async () => {
    const actor = { userId: SERVER_ADMIN, canCreateGames: () => true, canEditGames: () => true };
    const created = await importGameDefinition({ raw: definition("First"), actor });
    await importGameDefinition({ raw: definition("Second"), actor, allowUpdate: true });

    const headers = { cookie: cookies[SERVER_ADMIN] };
    const grant = async () =>
      (
        await app.inject({
          method: "POST",
          url: `/servers/${SERVER_ID}/roles`,
          headers,
          payload: { discordRoleId: "r1", permission: "games.create" },
        })
      ).statusCode;
    const revoke = async () =>
      (
        await app.inject({
          method: "DELETE",
          url: `/servers/${SERVER_ID}/roles/r1/permissions/games.create`,
          headers,
        })
      ).statusCode;
    // The repeats change nothing and are not logged.
    expect([await grant(), await grant(), await revoke(), await revoke()]).toEqual([
      200, 200, 204, 204,
    ]);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/games/${created.gameId}`,
      headers: { cookie: cookies[GLOBAL_ADMIN] },
    });
    expect(deleted.statusCode).toBe(204);

    const res = await read(SERVER_ADMIN, `?serverId=${SERVER_ID}`);
    expect(res.statusCode).toBe(200);
    const { entries, nextCursor } = res.json() as AuditLogResponse;
    expect(nextCursor).toBeNull();
    expect(entries.map((e) => [e.action, e.actorId, e.targetName])).toEqual([
      ["game.delete", GLOBAL_ADMIN, "Second"],
      ["role.revoke", SERVER_ADMIN, "Mods"],
      ["role.grant", SERVER_ADMIN, "Mods"],
      ["game.revision", SERVER_ADMIN, "Second"],
      ["game.create", SERVER_ADMIN, "First"],
    ]);
    expect(entries[3]).toMatchObject({
      serverName: "Audit Server",
      actorName: `${SERVER_ADMIN} name`,
      targetId: created.gameId,
      details: { revision: 2, source: "api", name: { from: "First", to: "Second" } },
    });
    expect(entries[2].details).toEqual({ permission: "games.create" });
  });

  test("a server's log is for its server admins; the whole log and Casual Games' for global admins", async () => {
    expect((await read(MEMBER, `?serverId=${SERVER_ID}`)).statusCode).toBe(403);
    expect((await read(SERVER_ADMIN, `?serverId=${OTHER_SERVER_ID}`)).statusCode).toBe(403);
    expect((await read(SERVER_ADMIN, `?serverId=${CASUAL_SERVER_ID}`)).statusCode).toBe(403);
    expect((await read(SERVER_ADMIN, `?serverId=test-audit-missing`)).statusCode).toBe(403);
    expect((await read(SERVER_ADMIN)).statusCode).toBe(403);
    expect((await read(GLOBAL_ADMIN, `?serverId=${CASUAL_SERVER_ID}`)).statusCode).toBe(200);
    expect((await read(GLOBAL_ADMIN)).statusCode).toBe(200);
    expect((await app.inject({ url: "/audit-log" })).statusCode).toBe(401);
  });

  test("pages newest first, through entries made at the same moment", async () => {
    const createdAt = new Date();
    await prisma.auditLog.createMany({
      data: [1, 2, 3].map((n) => ({
        serverId: OTHER_SERVER_ID,
        action: "game.delete",
        targetId: `t${n}`,
        targetName: `T${n}`,
        details: {},
        createdAt,
      })),
    });
    const page = async (query: string) => {
      const res = await read(GLOBAL_ADMIN, `?serverId=${OTHER_SERVER_ID}&limit=2${query}`);
      expect(res.statusCode).toBe(200);
      return res.json() as AuditLogResponse;
    };

    const first = await page("");
    expect(first.entries).toHaveLength(2);
    const second = await page(`&before=${first.nextCursor}`);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(new Set(ids).size).toBe(3);
    expect(second.entries[0]).toMatchObject({ actorId: null, actorName: null });

    expect((await read(GLOBAL_ADMIN, "?limit=101")).statusCode).toBe(400);
    expect((await read(GLOBAL_ADMIN, "?before=nope")).statusCode).toBe(400);
  });
});
