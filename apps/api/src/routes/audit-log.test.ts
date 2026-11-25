import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// Roles come from fresh membership caches, so Discord is only asked for role names.
vi.mock("../lib/discord-client.js", () => ({
  discord: {
    getGuildMember: vi.fn().mockResolvedValue(null),
    getGuildRoles: vi.fn().mockResolvedValue([
      { id: "r1", name: "Mods" },
      { id: "test-audit-server", name: "@everyone" },
    ]),
  },
}));

import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { CASUAL_SERVER_ID, type AuditLogFilters, type AuditLogResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { discord } from "../lib/discord-client.js";
import { importGameDefinition } from "../games/import-service.js";
import { auditLogRoutes } from "./audit-log.js";
import { gameRoutes } from "./games.js";
import { serverRoutes } from "./servers.js";

const SERVER_ID = "test-audit-server";
const OTHER_SERVER_ID = "test-audit-other";
const SERVERS = [SERVER_ID, OTHER_SERVER_ID];
const ADMIN_ROLE = "test-audit-admin-role";
const MANAGER_ROLE = "test-audit-manager-role";
const GLOBAL_ADMIN = "test-audit-global";
const SERVER_ADMIN = "test-audit-server-admin";
const MANAGER = "test-audit-manager"; // games.create, no server.admin
const MEMBER = "test-audit-member";
const USERS = [GLOBAL_ADMIN, SERVER_ADMIN, MANAGER, MEMBER];
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
  const games = { gameKey: { startsWith: GAME_KEY } };
  const gameIds = (await prisma.game.findMany({ where: games, select: { id: true } })).map(
    (g) => g.id,
  );
  await prisma.auditLog.deleteMany({ where: { targetId: { in: gameIds } } });
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
    await prisma.rolePermission.createMany({
      data: [
        { serverId: SERVER_ID, discordRoleId: ADMIN_ROLE, permission: "server.admin" },
        { serverId: SERVER_ID, discordRoleId: MANAGER_ROLE, permission: "games.create" },
      ],
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
              roles:
                discordId === SERVER_ADMIN
                  ? [ADMIN_ROLE]
                  : discordId === MANAGER
                    ? [MANAGER_ROLE]
                    : [],
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
    const grant = async (discordRoleId = "r1") =>
      (
        await app.inject({
          method: "POST",
          url: `/servers/${SERVER_ID}/roles`,
          headers,
          payload: { discordRoleId, permission: "games.create" },
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
    // Not a role of the server, and @everyone (the guild's id): refused, stored and logged nowhere.
    expect([await grant("1999999999999999999"), await grant(SERVER_ID)]).toEqual([400, 400]);
    expect(await prisma.rolePermission.count({ where: { serverId: SERVER_ID } })).toBe(1);

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

  test("filters by action, actor and game, and lists what there is to filter by", async () => {
    const filters = await read(SERVER_ADMIN, `/filters?serverId=${SERVER_ID}`);
    expect(filters.statusCode).toBe(200);
    const { servers, actors, games } = filters.json() as AuditLogFilters;
    // Only the global log picks a server.
    expect(servers).toEqual([]);
    const global = (await read(GLOBAL_ADMIN, "/filters")).json() as AuditLogFilters;
    expect(global.servers).toContainEqual({ id: SERVER_ID, name: "Audit Server" });
    expect(actors).toHaveLength(2);
    expect(actors).toEqual(
      expect.arrayContaining([
        { id: SERVER_ADMIN, name: `${SERVER_ADMIN} name` },
        { id: GLOBAL_ADMIN, name: `${GLOBAL_ADMIN} name` },
      ]),
    );
    // The deleted game, by its latest name.
    expect(games).toEqual([
      { id: expect.any(String), name: "Second (deleted)", serverId: SERVER_ID },
    ]);

    const actions = async (query: string) =>
      (
        (await read(SERVER_ADMIN, `?serverId=${SERVER_ID}${query}`)).json() as AuditLogResponse
      ).entries.map((e) => e.action);
    expect(await actions("&action=role.grant")).toEqual(["role.grant"]);
    expect(await actions(`&actorId=${GLOBAL_ADMIN}`)).toEqual(["game.delete"]);
    expect(await actions(`&targetId=${games[0].id}`)).toEqual([
      "game.delete",
      "game.revision",
      "game.create",
    ]);

    expect((await read(MEMBER, `/filters?serverId=${SERVER_ID}`)).statusCode).toBe(403);
    expect((await read(SERVER_ADMIN, "/filters")).statusCode).toBe(403);
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
    // Another server's entry is no cursor here.
    const foreign = await read(GLOBAL_ADMIN, `?serverId=${SERVER_ID}&before=${first.nextCursor}`);
    expect(foreign.statusCode).toBe(400);
  });
  describe("a game's history", () => {
    let casualGameId: string;
    let serverGameId: string;
    let roleEntryId: string;

    const entry = (serverId: string, targetId: string, action: string, minutesAgo: number) =>
      prisma.auditLog.create({
        data: {
          serverId,
          actorId: MEMBER,
          action,
          targetId,
          targetName: "History",
          details: {},
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
        },
      });
    const actions = async (userId: string, query: string) => {
      const res = await read(userId, query);
      expect(res.statusCode).toBe(200);
      return (res.json() as AuditLogResponse).entries.map((e) => e.action);
    };

    beforeAll(async () => {
      const game = (serverId: string, suffix: string, createdById: string | null) =>
        prisma.game.create({
          data: {
            gameKey: `${GAME_KEY}-${suffix}`,
            serverId,
            name: "History",
            unlisted: true,
            ownerScope: serverId === CASUAL_SERVER_ID ? createdById! : "",
            createdById,
          },
        });
      casualGameId = (await game(CASUAL_SERVER_ID, "casual", MEMBER)).id;
      serverGameId = (await game(SERVER_ID, "server", null)).id;
      await entry(CASUAL_SERVER_ID, casualGameId, "game.create", 3);
      await entry(CASUAL_SERVER_ID, casualGameId, "link.create", 2);
      // Audit targets are untyped: a role entry can carry a game's id.
      roleEntryId = (await entry(CASUAL_SERVER_ID, casualGameId, "role.grant", 1)).id;
      await entry(SERVER_ID, serverGameId, "game.create", 3);
      await entry(SERVER_ID, serverGameId, "game.listing", 2);
    });

    test("a Casual game's creator reads its game and link entries, without a Discord lookup", async () => {
      const getGuildMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;
      getGuildMember.mockClear();
      expect(await actions(MEMBER, `?targetId=${casualGameId}`)).toEqual([
        "link.create",
        "game.create",
      ]);
      expect(
        await actions(MEMBER, `?targetId=${casualGameId}&serverId=${CASUAL_SERVER_ID}`),
      ).toEqual(["link.create", "game.create"]);
      expect(await actions(MEMBER, `?targetId=${casualGameId}&action=link.create`)).toEqual([
        "link.create",
      ]);
      expect(await actions(MEMBER, `?targetId=${casualGameId}&action=role.grant`)).toEqual([]);
      expect(getGuildMember).not.toHaveBeenCalled();
    });

    test("the game grant reaches that game only, on its own server", async () => {
      expect((await read(SERVER_ADMIN, `?targetId=${casualGameId}`)).statusCode).toBe(403);
      expect(
        (await read(MEMBER, `?targetId=${casualGameId}&serverId=${SERVER_ID}`)).statusCode,
      ).toBe(403);
      expect((await read(MEMBER, `?serverId=${CASUAL_SERVER_ID}`)).statusCode).toBe(403);
      expect((await read(MEMBER, `?targetId=${GAME_KEY}-missing`)).statusCode).toBe(403);
      expect((await read(MEMBER, "/filters")).statusCode).toBe(403);
    });

    test("a game's managers read its history; other members don't", async () => {
      expect(await actions(MANAGER, `?targetId=${serverGameId}`)).toEqual([
        "game.listing",
        "game.create",
      ]);
      expect((await read(MEMBER, `?targetId=${serverGameId}`)).statusCode).toBe(403);
      expect((await read(MANAGER, `?serverId=${SERVER_ID}`)).statusCode).toBe(403);
    });

    test("the cursor stays within the game's entries", async () => {
      const first = (await read(MEMBER, `?targetId=${casualGameId}&limit=1`)).json();
      expect(first.entries.map((e: { action: string }) => e.action)).toEqual(["link.create"]);
      const second = await read(MEMBER, `?targetId=${casualGameId}&before=${first.nextCursor}`);
      expect((second.json() as AuditLogResponse).entries.map((e) => e.action)).toEqual([
        "game.create",
      ]);
      const role = await read(MEMBER, `?targetId=${casualGameId}&before=${roleEntryId}`);
      expect(role.statusCode).toBe(400);
    });
  });

  test("the history backfill adds each revision uploaded without an entry, once", async () => {
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261125120000_audit_log_backfill/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const rollback = new Error("rollback");
    // Rolled back: the backfill covers every game, other test files' included.
    const run = prisma.$transaction(async (tx) => {
      const at = (day: number) => new Date(Date.UTC(2026, 9, day));
      const game = await tx.game.create({
        data: { gameKey: `${GAME_KEY}-backfill`, serverId: SERVER_ID, name: "Backfill" },
      });
      const revision = (revision: number, day: number) =>
        tx.gameRevision.create({
          data: {
            gameId: game.id,
            revision,
            checksum: `${GAME_KEY}-${revision}`,
            definition: { name: `Rev ${revision}` },
            source: "web",
            createdBy: MEMBER,
            createdAt: at(day),
          },
        });
      // First imported as revision 3.
      const [r3, r4] = [await revision(3, 1), await revision(4, 2)];
      await revision(5, 3);
      const r6 = await revision(6, 4);
      const logged = (revision: number, createdAt: Date) =>
        tx.auditLog.create({
          data: {
            serverId: SERVER_ID,
            actorId: MEMBER,
            action: "game.revision",
            targetId: game.id,
            targetName: "Backfill",
            details: { revision, source: "web" },
            createdAt,
          },
        });
      // Revision 5's upload was logged; revision 3 was re-activated weeks later.
      const upload = await logged(5, new Date(at(3).getTime() + 50));
      const reactivation = await logged(3, at(30));
      // Uploaded just before audit logging went live, re-activated just after.
      const quick = await logged(6, new Date(at(4).getTime() + 30_000));

      await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(sql);
      const entries = await tx.auditLog.findMany({
        where: { targetId: game.id },
        orderBy: { createdAt: "asc" },
      });
      expect(entries.map((e) => [e.id, e.action, e.createdAt, e.details])).toEqual([
        [`backfill_${r3.id}`, "game.create", at(1), { revision: 3, source: "web" }],
        [`backfill_${r4.id}`, "game.revision", at(2), { revision: 4, source: "web" }],
        [upload.id, "game.revision", upload.createdAt, upload.details],
        [`backfill_${r6.id}`, "game.revision", at(4), { revision: 6, source: "web" }],
        [quick.id, "game.revision", quick.createdAt, quick.details],
        [reactivation.id, "game.revision", at(30), reactivation.details],
      ]);
      expect(entries[0]).toMatchObject({ actorId: MEMBER, targetName: "Rev 3" });
      throw rollback;
    });
    await expect(run).rejects.toBe(rollback);
  });
});
