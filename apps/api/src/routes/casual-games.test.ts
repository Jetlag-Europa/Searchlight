import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Every membership this file needs is cached up front. Other lookups fail:
// GET /servers asks about every server, and a membership cached on another
// test file's server would stop that file deleting it.
vi.mock("../lib/discord-client.js", () => ({
  discord: {
    getGuildMember: vi.fn(async () => {
      throw new Error("Not this file's membership");
    }),
    getGuildRoles: vi.fn(async (guildId: string) => {
      if (guildId !== "1190673594649415730") throw new Error("Discord /guilds/roles failed: 404");
      return [{ id: "test-casual-creator-role", name: "Creator", color: 0, position: 1 }];
    }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { CASUAL_SERVER_ID } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { discord } from "../lib/discord-client.js";
import { gameRoutes } from "./games.js";
import { gameImportRoutes } from "./game-imports.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./game-links.js";
import { sessionRoutes } from "./sessions.js";
import { serverRoutes } from "./servers.js";

const EU_SERVER_ID = "1190673594649415730";
const CREATOR_ROLE = "test-casual-creator-role";
const MAPPED_ROLE = "test-casual-mapped-role";

const ADMIN = "test-casual-admin";
const CREATOR = "test-casual-creator"; // holds the creator role in JetLag EU
const RIVAL = "test-casual-rival"; // holds it too, but didn't create the game
const PLAYER = "test-casual-player"; // in JetLag EU without the role
const USERS = [ADMIN, CREATOR, RIVAL, PLAYER];

const KEY_PREFIX = "test-casual-";
const GAME_KEY = `${KEY_PREFIX}london`;

const mockGetGuildRoles = discord.getGuildRoles as unknown as ReturnType<typeof vi.fn>;

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  await app.register(gameRoutes, { prefix: "/games" });
  await app.register(gameImportRoutes, { prefix: "/games" });
  await app.register(gameLinkManagementRoutes, { prefix: "/games" });
  await app.register(gameLinkRoutes, { prefix: "/game-links" });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.register(serverRoutes, { prefix: "/servers" });
  await app.ready();
  return app;
}

function definition(id: string, name: string, bounds = [-0.5, 51.3, 0.3, 51.7]) {
  const [west, south, east, north] = bounds;
  const center = [(west + east) / 2, (south + north) / 2];
  return {
    id,
    name,
    serverId: CASUAL_SERVER_ID,
    map: {
      center,
      bounds,
      playArea: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
            },
          },
        ],
      },
    },
    hidingZones: {
      features: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: center } }],
      },
    },
  };
}

async function cleanup() {
  const games = { gameKey: { startsWith: KEY_PREFIX } };
  const sessions = { game: games };
  await prisma.sessionParticipant.deleteMany({ where: { session: sessions } });
  await prisma.gameSession.deleteMany({ where: sessions });
  await prisma.gameLink.deleteMany({ where: { game: games } });
  await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { game: games } });
  await prisma.game.deleteMany({ where: games });
  await prisma.rolePermission.deleteMany({
    where: { serverId: CASUAL_SERVER_ID, discordRoleId: { in: [CREATOR_ROLE, MAPPED_ROLE] } },
  });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

describe("Casual Games", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const as = (userId: string) => ({ cookie: cookies[userId] });
  const previousAdmins = env.ADMIN_DISCORD_IDS;
  let gameId: string;

  const importAs = (userId: string, def: object, query = "") =>
    app.inject({ method: "POST", url: `/games/import${query}`, headers: as(userId), payload: def });
  const replaceAs = (userId: string, id: string, def: object, query = "") =>
    app.inject({ method: "POST", url: `/games/${id}/import${query}`, headers: as(userId), payload: def });

  const listGames = async (userId: string, includeUnlisted: boolean) => {
    const query = includeUnlisted ? "&includeUnlisted=true" : "";
    const res = await app.inject({
      method: "GET",
      url: `/games?serverId=${CASUAL_SERVER_ID}${query}`,
      headers: as(userId),
    });
    expect(res.statusCode).toBe(200);
    return res.json().games as { id: string; gameKey: string; createdById: string | null }[];
  };

  const setEuRoles = (userId: string, roles: string[]) =>
    prisma.serverMembershipCache.upsert({
      where: { userId_serverId: { userId, serverId: EU_SERVER_ID } },
      update: { isMember: true, roles, cachedAt: new Date() },
      create: { userId, serverId: EU_SERVER_ID, isMember: true, roles, cachedAt: new Date() },
    });

  beforeAll(async () => {
    await cleanup();
    env.ADMIN_DISCORD_IDS = ADMIN;
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

    await prisma.server.createMany({ data: [{ id: EU_SERVER_ID, name: "JetLag EU" }], skipDuplicates: true });
    await prisma.server.upsert({
      where: { id: CASUAL_SERVER_ID },
      update: { managementGuildId: EU_SERVER_ID },
      create: { id: CASUAL_SERVER_ID, name: "Casual Games", managementGuildId: EU_SERVER_ID },
    });
    await prisma.rolePermission.create({
      data: { serverId: CASUAL_SERVER_ID, discordRoleId: CREATOR_ROLE, permission: "games.create" },
    });

    await setEuRoles(CREATOR, [CREATOR_ROLE]);
    await setEuRoles(RIVAL, [CREATOR_ROLE]);
    await setEuRoles(PLAYER, []);
    const res = await importAs(CREATOR, definition(GAME_KEY, "London 2026"), "?unlisted=false");
    expect(res.statusCode).toBe(201);
    gameId = res.json().gameId;
  });

  // Fresh caches for every test, so roles always come from them.
  beforeEach(async () => {
    await setEuRoles(CREATOR, [CREATOR_ROLE]);
    await setEuRoles(RIVAL, [CREATOR_ROLE]);
    await setEuRoles(PLAYER, []);
  });

  afterAll(async () => {
    env.ADMIN_DISCORD_IDS = previousAdmins;
    await app?.close();
    await cleanup();
  });

  describe("importing", () => {
    test("a holder of the mapped JetLag EU role creates unlisted games, recorded as theirs", async () => {
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game).toMatchObject({ serverId: CASUAL_SERVER_ID, unlisted: true, createdById: CREATOR });
    });

    test("someone without the role can't import there", async () => {
      const res = await importAs(PLAYER, definition(`${KEY_PREFIX}player`, "Player Game"), "?dryRun=true");
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
    });

    test("an update shows the game it would replace, also on a dry run", async () => {
      const res = await importAs(CREATOR, definition(GAME_KEY, "London 2026 v2"), "?dryRun=true&allowUpdate=true");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "updated",
        existing: { name: "London 2026", revision: 1, createdByYou: true, likelyMistake: false, differences: [] },
      });
    });

    test("a file that looks like another game is flagged, also without allowUpdate", async () => {
      const paris = definition(GAME_KEY, "Paris 2026", [2.2, 48.8, 2.5, 48.95]);
      const res = await importAs(CREATOR, paris, "?dryRun=true");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "GAME_EXISTS", existing: { likelyMistake: true } });
      expect(res.json().existing.differences).toEqual([
        'Named "London 2026"; this file: "Paris 2026"',
        "Its play area doesn't overlap this file's",
      ]);
    });

    test("another role holder importing the same id gets a game of their own", async () => {
      const preview = await importAs(RIVAL, definition(GAME_KEY, "Rival 2026"), "?dryRun=true&allowUpdate=true");
      expect(preview.statusCode).toBe(201);
      expect(preview.json().status).toBe("created");
      expect(preview.json().existing).toBeUndefined();

      const res = await importAs(RIVAL, definition(GAME_KEY, "Rival 2026"));
      expect(res.statusCode).toBe(201);
      const rivalId = res.json().gameId;
      expect(rivalId).not.toBe(gameId);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: rivalId } })).toMatchObject({
        createdById: RIVAL,
        ownerScope: RIVAL,
      });
      const creators = await prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        include: { currentRevision: { select: { revision: true } } },
      });
      expect(creators).toMatchObject({ name: "London 2026", currentRevision: { revision: 1 } });

      const again = await importAs(RIVAL, definition(GAME_KEY, "Rival v2"), "?allowUpdate=true");
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ status: "updated", gameId: rivalId });

      await prisma.game.update({ where: { id: rivalId }, data: { currentRevisionId: null } });
      await prisma.gameRevision.deleteMany({ where: { gameId: rivalId } });
      await prisma.game.delete({ where: { id: rivalId } });
    });

    test("the creator can't update their game without the role any more", async () => {
      await setEuRoles(CREATOR, []);
      const res = await importAs(CREATOR, definition(GAME_KEY, "London 2026 v2"), "?dryRun=true&allowUpdate=true");
      expect(res.statusCode).toBe(403);
    });

    test("a global admin's import of a creator's id makes the admin's own game", async () => {
      const res = await importAs(ADMIN, definition(GAME_KEY, "London 2026 v2"), "?dryRun=true&allowUpdate=true");
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("created");
    });

    test("a global admin replaces another player's Casual game", async () => {
      const preview = await replaceAs(ADMIN, gameId, definition(GAME_KEY, "London 2026 v2"), "?dryRun=true");
      expect(preview.statusCode).toBe(200);
      expect(preview.json().status).toBe("updated");
      expect(preview.json().existing).toMatchObject({ createdByYou: false, likelyMistake: false });
      expect(preview.json().existing.differences).toEqual(["Created by someone else"]);

      const { currentRevisionId } = preview.json().existing;
      const res = await replaceAs(
        ADMIN,
        gameId,
        definition(GAME_KEY, "London 2026 v2"),
        `?expectedCurrentRevisionId=${currentRevisionId}`,
      );
      expect(res.statusCode).toBe(200);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).toMatchObject({
        createdById: CREATOR,
        ownerScope: CREATOR,
      });

      // The creator's own import still finds it, and restores the name.
      const back = await importAs(CREATOR, definition(GAME_KEY, "London 2026"), "?allowUpdate=true");
      expect(back.statusCode).toBe(200);
      expect(back.json().gameId).toBe(gameId);
    });

    test("replace is for whoever may update the game", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      expect((await replaceAs(CREATOR, gameId, def, "?dryRun=true")).statusCode).toBe(200);
      for (const userId of [RIVAL, PLAYER]) {
        const res = await replaceAs(userId, gameId, def, "?dryRun=true");
        expect(res.statusCode, userId).toBe(403);
        if (userId === RIVAL) expect(res.json().code).toBe("FORBIDDEN");
      }
      expect((await replaceAs(CREATOR, "does-not-exist", def, "?dryRun=true")).statusCode).toBe(404);
      await setEuRoles(CREATOR, []);
      expect((await replaceAs(CREATOR, gameId, def, "?dryRun=true")).statusCode).toBe(403);
    });

    test("replace ignores the file's id and serverId", async () => {
      const key = `${KEY_PREFIX}replace-target`;
      const created = await importAs(CREATOR, definition(key, "Target 2026"));
      expect(created.statusCode).toBe(201);
      const targetId = created.json().gameId;

      const res = await replaceAs(ADMIN, targetId, {
        ...definition(`${KEY_PREFIX}elsewhere`, "Target 2026 v2"),
        serverId: EU_SERVER_ID,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "updated", revision: 2, gameKey: key });

      const target = await prisma.game.findUniqueOrThrow({
        where: { id: targetId },
        include: { currentRevision: { select: { definition: true } } },
      });
      expect(target).toMatchObject({ serverId: CASUAL_SERVER_ID, createdById: CREATOR, ownerScope: CREATOR });
      expect(target.currentRevision?.definition).toMatchObject({ id: key, serverId: CASUAL_SERVER_ID });
      expect(await prisma.game.count({ where: { gameKey: `${KEY_PREFIX}elsewhere` } })).toBe(0);
    });

    test("replace refuses a stale preview, from the query or the body", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      const fromQuery = await replaceAs(CREATOR, gameId, def, "?expectedCurrentRevisionId=not-current");
      const fromBody = await replaceAs(CREATOR, gameId, { game: def, expectedCurrentRevisionId: "not-current" });
      for (const res of [fromQuery, fromBody]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: "GAME_CHANGED" });
      }
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game.name).toBe("London 2026");
    });

    test("an update pinned to the previewed revision goes ahead while the game is unchanged", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      const preview = await importAs(CREATOR, def, "?dryRun=true&allowUpdate=true");
      const { currentRevisionId } = preview.json().existing;
      expect(currentRevisionId).toBe((await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).currentRevisionId);

      const res = await importAs(CREATOR, def, `?dryRun=true&allowUpdate=true&expectedCurrentRevisionId=${currentRevisionId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("updated");
    });

    test("an update pinned to another revision is refused, from the query or the body", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      const fromQuery = await importAs(CREATOR, def, "?allowUpdate=true&expectedCurrentRevisionId=not-current");
      const fromBody = await importAs(CREATOR, { game: def, allowUpdate: true, expectedCurrentRevisionId: "not-current" });
      for (const res of [fromQuery, fromBody]) {
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ code: "GAME_CHANGED" });
      }
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game.name).toBe("London 2026");
    });

    test("a preview of a deleted game doesn't pin the game re-created with its id", async () => {
      const key = `${KEY_PREFIX}recreated`;
      const created = await importAs(CREATOR, definition(key, "Recreated 2026"));
      expect(created.statusCode).toBe(201);
      const preview = await importAs(CREATOR, definition(key, "Recreated 2026 v2"), "?dryRun=true&allowUpdate=true");
      const previewed = preview.json().existing.currentRevisionId;

      const old = await prisma.game.findUniqueOrThrow({ where: { id: created.json().gameId } });
      expect((await app.inject({ method: "DELETE", url: `/games/${old.id}`, headers: as(ADMIN) })).statusCode).toBe(204);
      expect((await importAs(CREATOR, definition(key, "Recreated 2026"))).statusCode).toBe(201);

      // Both are revision 1; only the id tells them apart.
      const res = await importAs(
        CREATOR,
        definition(key, "Recreated 2026 v2"),
        `?allowUpdate=true&expectedCurrentRevisionId=${previewed}`,
      );
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("GAME_CHANGED");
    });

    test("a Casual game without a recorded creator is reached only by replace", async () => {
      const key = `${KEY_PREFIX}legacy`;
      const legacy = await prisma.game.create({
        data: { gameKey: key, serverId: CASUAL_SERVER_ID, name: "Legacy 2026", unlisted: true },
      });
      const rev = await prisma.gameRevision.create({
        data: {
          gameId: legacy.id,
          revision: 1,
          formatVersion: 1,
          definition: definition(key, "Legacy 2026"),
          checksum: "test-casual-legacy-checksum",
          source: "api",
        },
      });
      await prisma.game.update({ where: { id: legacy.id }, data: { currentRevisionId: rev.id } });
      expect(legacy.ownerScope).toBe("");

      const own = await importAs(CREATOR, definition(key, "Legacy 2026"));
      expect(own.statusCode).toBe(201);
      expect(own.json()).toMatchObject({ status: "created" });
      expect(own.json().gameId).not.toBe(legacy.id);
      expect(await prisma.game.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
        name: "Legacy 2026",
        currentRevisionId: rev.id,
        createdById: null,
      });

      const legacyDef = definition(key, "Legacy 2026 v2");
      const byAdmin = await replaceAs(ADMIN, legacy.id, legacyDef, "?dryRun=true");
      expect(byAdmin.statusCode).toBe(200);
      expect(byAdmin.json().status).toBe("updated");
      expect((await replaceAs(CREATOR, legacy.id, legacyDef, "?dryRun=true")).statusCode).toBe(403);
    });
  });

  describe("visibility", () => {
    test("Casual games are never listed without includeUnlisted, for anyone", async () => {
      expect(await listGames(CREATOR, false)).toEqual([]);
      expect(await listGames(ADMIN, false)).toEqual([]);
    });

    test("with includeUnlisted, a creator sees only their own games and a global admin sees all", async () => {
      const creators = await listGames(CREATOR, true);
      expect(creators.map((g) => g.id)).toContain(gameId);
      expect(creators.every((g) => g.createdById === CREATOR)).toBe(true);

      expect((await listGames(RIVAL, true)).map((g) => g.id)).not.toContain(gameId);
      expect((await listGames(PLAYER, true)).map((g) => g.id)).not.toContain(gameId);
      expect((await listGames(ADMIN, true)).map((g) => g.id)).toContain(gameId);
    });

    test("only the creator and global admins can export the game", async () => {
      const exportAs = (userId: string) =>
        app.inject({ method: "GET", url: `/games/${gameId}/export`, headers: as(userId) });
      expect((await exportAs(CREATOR)).statusCode).toBe(200);
      expect((await exportAs(ADMIN)).statusCode).toBe(200);
      expect((await exportAs(RIVAL)).statusCode).toBe(403);
      expect((await exportAs(PLAYER)).statusCode).toBe(403);
    });

    test("a role gate on a role the creator lacks doesn't hide their game from them", async () => {
      const key = `${KEY_PREFIX}gated`;
      const gated = {
        ...definition(key, "Gated 2026"),
        visibility: { kind: "discord-role", guildId: EU_SERVER_ID, roleId: "test-casual-gone-role" },
      };
      const created = await importAs(CREATOR, gated);
      expect(created.statusCode).toBe(201);
      const game = await prisma.game.findUniqueOrThrow({ where: { id: created.json().gameId } });

      expect((await listGames(CREATOR, true)).map((g) => g.gameKey)).toContain(key);
      const exportAs = (userId: string) =>
        app.inject({ method: "GET", url: `/games/${game.id}/export`, headers: as(userId) });
      expect((await exportAs(CREATOR)).statusCode).toBe(200);
      expect((await exportAs(RIVAL)).statusCode).toBe(403);
    });

    test("the creator keeps access to their game after losing the role", async () => {
      await setEuRoles(CREATOR, []);
      const res = await app.inject({ method: "GET", url: `/games/${gameId}/export`, headers: as(CREATOR) });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("managing", () => {
    test("Casual games can't be listed, not even by a global admin", async () => {
      for (const userId of [CREATOR, ADMIN]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/games/${gameId}`,
          headers: as(userId),
          payload: { unlisted: false },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toBe("Casual games are always unlisted");
      }
    });

    test("another role holder can't manage the creator's game", async () => {
      const patch = await app.inject({
        method: "PATCH",
        url: `/games/${gameId}`,
        headers: as(RIVAL),
        payload: { unlisted: true },
      });
      expect(patch.statusCode).toBe(403);
      const links = await app.inject({ method: "POST", url: `/games/${gameId}/links`, headers: as(RIVAL) });
      expect(links.statusCode).toBe(403);
      const del = await app.inject({ method: "DELETE", url: `/games/${gameId}`, headers: as(RIVAL) });
      expect(del.statusCode).toBe(403);
    });

    test("the creator renames their game while they hold the role; others can't", async () => {
      const created = await importAs(CREATOR, definition(`${KEY_PREFIX}settings`, "Settings 2026"));
      expect(created.statusCode).toBe(201);
      const settingsGameId = created.json().gameId;
      const rename = async (userId: string, name: string) => {
        const game = await prisma.game.findUniqueOrThrow({ where: { id: settingsGameId } });
        return app.inject({
          method: "PATCH",
          url: `/games/${settingsGameId}/settings`,
          headers: as(userId),
          payload: { baseRevisionId: game.currentRevisionId, name },
        });
      };

      for (const userId of [RIVAL, PLAYER]) {
        expect((await rename(userId, "Not Yours 2026")).statusCode).toBe(403);
      }
      await setEuRoles(CREATOR, []);
      expect((await rename(CREATOR, "Without The Role 2026")).statusCode).toBe(403);
      await setEuRoles(CREATOR, [CREATOR_ROLE]);

      const own = await rename(CREATOR, "Settings 2026 Renamed");
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({
        status: "updated",
        game: { name: "Settings 2026 Renamed", unlisted: true, createdById: CREATOR },
      });
      const admin = await rename(ADMIN, "Settings 2026 By Admin");
      expect(admin.statusCode).toBe(200);
      expect(admin.json().game).toMatchObject({ name: "Settings 2026 By Admin", createdById: CREATOR });
    });

    test("the creator can't delete their game; that's for global admins", async () => {
      const res = await app.inject({ method: "DELETE", url: `/games/${gameId}`, headers: as(CREATOR) });
      expect(res.statusCode).toBe(403);
    });

    test("the creator starts sessions from a game link, not directly", async () => {
      const direct = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: as(CREATOR),
        payload: { gameId, name: "Direct" },
      });
      expect(direct.statusCode).toBe(403);

      const link = await app.inject({ method: "POST", url: `/games/${gameId}/links`, headers: as(CREATOR) });
      expect(link.statusCode).toBe(201);
      const session = await app.inject({
        method: "POST",
        url: `/game-links/${link.json().token}/sessions`,
        headers: as(RIVAL),
        payload: { name: "From the link", visibility: "private" },
      });
      expect(session.statusCode).toBe(201);
    });
  });

  describe("servers", () => {
    const listServers = async (userId: string) => {
      const res = await app.inject({ method: "GET", url: "/servers", headers: as(userId) });
      expect(res.statusCode).toBe(200);
      return res.json().servers as { id: string; permissions: string[]; isMember: boolean }[];
    };

    test("Casual is listed for role holders, with games.create only", async () => {
      const casual = (await listServers(RIVAL)).find((s) => s.id === CASUAL_SERVER_ID);
      expect(casual).toEqual(expect.objectContaining({ permissions: ["games.create"], isMember: true }));
    });

    test("Casual stays listed for a creator of Casual games without the role", async () => {
      await setEuRoles(CREATOR, []);
      const casual = (await listServers(CREATOR)).find((s) => s.id === CASUAL_SERVER_ID);
      expect(casual).toEqual(expect.objectContaining({ permissions: [], isMember: true }));
    });

    test("Casual is hidden from someone without permissions, sessions or games there", async () => {
      expect((await listServers(PLAYER)).map((s) => s.id)).not.toContain(CASUAL_SERVER_ID);
    });

    test("the role routes use the management guild's roles, for global admins only", async () => {
      mockGetGuildRoles.mockClear();
      const res = await app.inject({ method: "GET", url: `/servers/${CASUAL_SERVER_ID}/roles`, headers: as(ADMIN) });
      expect(res.statusCode).toBe(200);
      expect(mockGetGuildRoles).toHaveBeenCalledWith(EU_SERVER_ID, expect.anything(), expect.anything());
      expect(res.json().roles.map((r: { id: string }) => r.id)).toEqual([CREATOR_ROLE]);

      const creator = await app.inject({ method: "GET", url: `/servers/${CASUAL_SERVER_ID}/roles`, headers: as(CREATOR) });
      expect(creator.statusCode).toBe(403);
    });

    test("only games.create can be granted on Casual", async () => {
      const grant = (permission: string) =>
        app.inject({
          method: "POST",
          url: `/servers/${CASUAL_SERVER_ID}/roles`,
          headers: as(ADMIN),
          payload: { discordRoleId: MAPPED_ROLE, permission },
        });
      for (const permission of ["games.edit", "games.delete", "server.admin"]) {
        const res = await grant(permission);
        expect(res.statusCode).toBe(400);
        expect(res.json().message).toMatch(/Only games\.create/);
      }
      expect((await grant("games.create")).statusCode).toBe(200);
    });
  });
});
