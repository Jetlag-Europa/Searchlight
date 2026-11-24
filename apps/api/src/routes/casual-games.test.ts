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
      return [
        { id: "test-casual-creator-role", name: "Creator", color: 0, position: 1 },
        { id: "test-casual-mapped-role", name: "Mapped", color: 0, position: 2 },
      ];
    }),
  },
}));

import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { request } from "node:http";
import { CASUAL_SERVER_ID } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { discord } from "../lib/discord-client.js";
import { CASUAL_LIMITS } from "../games/import-service.js";
import { acquireUploadSlot, resetWriteLimits, WRITE_LIMIT } from "../lib/write-limit.js";
import { gameRoutes } from "./games.js";
import { gameImportRoutes } from "./game-imports.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./game-links.js";
import { sessionRoutes } from "./sessions.js";
import { serverRoutes } from "./servers.js";

const EU_SERVER_ID = "1190673594649415730";
const CREATOR_ROLE = "test-casual-creator-role";
const MAPPED_ROLE = "test-casual-mapped-role";

const ADMIN = "test-casual-admin";
const CREATOR = "test-casual-creator"; // in JetLag EU
const RIVAL = "test-casual-rival"; // in it too, but didn't create the game
const PLAYER = "test-casual-player"; // in it too
const OUTSIDER = "test-casual-outsider"; // in no server
const LIMITED = "test-casual-limited"; // in JetLag EU, for the limits
const USERS = [ADMIN, CREATOR, RIVAL, PLAYER, OUTSIDER, LIMITED];

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
              coordinates: [
                [
                  [west, south],
                  [east, south],
                  [east, north],
                  [west, north],
                  [west, south],
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
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: center } }],
      },
    },
  };
}

async function cleanup() {
  const games = { gameKey: { startsWith: KEY_PREFIX } };
  const sessions = { game: games };
  await prisma.auditLog.deleteMany({ where: { actorId: { in: USERS } } });
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
    app.inject({
      method: "POST",
      url: `/games/${id}/import${query}`,
      headers: as(userId),
      payload: def,
    });

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

  // In JetLag EU or not, freshly cached, so no request reaches Discord.
  const setEuMember = (userId: string, isMember = true) =>
    prisma.serverMembershipCache.upsert({
      where: { userId_serverId: { userId, serverId: EU_SERVER_ID } },
      update: { isMember, roles: [], cachedAt: new Date() },
      create: { userId, serverId: EU_SERVER_ID, isMember, roles: [], cachedAt: new Date() },
    });

  beforeAll(async () => {
    await cleanup();
    env.ADMIN_DISCORD_IDS = ADMIN;
    app = await buildTestApp();
    // Imports ask about every registered server: other test files' aren't
    // this file's to cache memberships on.
    const findServers = prisma.server.findMany.bind(prisma.server);
    vi.spyOn(prisma.server, "findMany").mockImplementation(((args: { where?: object }) =>
      findServers({
        ...args,
        where: { AND: [args?.where ?? {}, { id: { in: [EU_SERVER_ID, CASUAL_SERVER_ID] } }] },
      })) as never);

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
        data: {
          id: `${discordId}-auth`,
          userId: discordId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }

    await prisma.server.createMany({
      data: [{ id: EU_SERVER_ID, name: "JetLag EU" }],
      skipDuplicates: true,
    });
    // The role routes still use the management guild (kept for rolling back).
    await prisma.server.upsert({
      where: { id: CASUAL_SERVER_ID },
      update: { managementGuildId: EU_SERVER_ID },
      create: { id: CASUAL_SERVER_ID, name: "Casual Games", managementGuildId: EU_SERVER_ID },
    });

    for (const userId of [CREATOR, RIVAL, PLAYER, LIMITED]) await setEuMember(userId);
    await setEuMember(OUTSIDER, false);
    const res = await importAs(CREATOR, definition(GAME_KEY, "London 2026"), "?unlisted=false");
    expect(res.statusCode).toBe(201);
    gameId = res.json().gameId;
  });

  // Fresh caches for every test, so memberships always come from them.
  beforeEach(async () => {
    for (const userId of [CREATOR, RIVAL, PLAYER, LIMITED]) await setEuMember(userId);
    await setEuMember(OUTSIDER, false);
    resetWriteLimits();
  });

  afterAll(async () => {
    vi.mocked(prisma.server.findMany).mockRestore();
    env.ADMIN_DISCORD_IDS = previousAdmins;
    await app?.close();
    await cleanup();
  });

  describe("importing", () => {
    test("anyone in one of the servers creates unlisted games, recorded as theirs", async () => {
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game).toMatchObject({
        serverId: CASUAL_SERVER_ID,
        unlisted: true,
        createdById: CREATOR,
      });
    });

    test("someone in no server can't import, before the body is read", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { ...as(OUTSIDER), "content-type": "application/json" },
        payload: "{ not json",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: "FORBIDDEN",
        message: "To upload games, join one of the JetLag Discord servers that use Searchlight.",
      });
    });

    test("an update shows the game it would replace, also on a dry run", async () => {
      const res = await importAs(
        CREATOR,
        definition(GAME_KEY, "London 2026 v2"),
        "?dryRun=true&allowUpdate=true",
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "updated",
        existing: {
          name: "London 2026",
          revision: 1,
          createdByYou: true,
          likelyMistake: false,
          differences: [],
        },
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

    test("another creator importing the same id gets a game of their own", async () => {
      const preview = await importAs(
        RIVAL,
        definition(GAME_KEY, "Rival 2026"),
        "?dryRun=true&allowUpdate=true",
      );
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

    test("the creator can't update their game after leaving every server", async () => {
      await setEuMember(CREATOR, false);
      const res = await importAs(
        CREATOR,
        definition(GAME_KEY, "London 2026 v2"),
        "?dryRun=true&allowUpdate=true",
      );
      expect(res.statusCode).toBe(403);
    });

    test("a global admin's import of a creator's id makes the admin's own game", async () => {
      const res = await importAs(
        ADMIN,
        definition(GAME_KEY, "London 2026 v2"),
        "?dryRun=true&allowUpdate=true",
      );
      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe("created");
    });

    test("a global admin replaces another player's Casual game", async () => {
      const preview = await replaceAs(
        ADMIN,
        gameId,
        definition(GAME_KEY, "London 2026 v2"),
        "?dryRun=true",
      );
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
      const back = await importAs(
        CREATOR,
        definition(GAME_KEY, "London 2026"),
        "?allowUpdate=true",
      );
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
      expect((await replaceAs(CREATOR, "does-not-exist", def, "?dryRun=true")).statusCode).toBe(
        404,
      );
      await setEuMember(CREATOR, false);
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
      expect(target).toMatchObject({
        serverId: CASUAL_SERVER_ID,
        createdById: CREATOR,
        ownerScope: CREATOR,
      });
      expect(target.currentRevision?.definition).toMatchObject({
        id: key,
        serverId: CASUAL_SERVER_ID,
      });
      expect(await prisma.game.count({ where: { gameKey: `${KEY_PREFIX}elsewhere` } })).toBe(0);
    });

    test("replace refuses a stale preview, from the query or the body", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      const fromQuery = await replaceAs(
        CREATOR,
        gameId,
        def,
        "?expectedCurrentRevisionId=not-current",
      );
      const fromBody = await replaceAs(CREATOR, gameId, {
        game: def,
        expectedCurrentRevisionId: "not-current",
      });
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
      expect(currentRevisionId).toBe(
        (await prisma.game.findUniqueOrThrow({ where: { id: gameId } })).currentRevisionId,
      );

      const res = await importAs(
        CREATOR,
        def,
        `?dryRun=true&allowUpdate=true&expectedCurrentRevisionId=${currentRevisionId}`,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("updated");
    });

    test("an update pinned to another revision is refused, from the query or the body", async () => {
      const def = definition(GAME_KEY, "London 2026 v2");
      const fromQuery = await importAs(
        CREATOR,
        def,
        "?allowUpdate=true&expectedCurrentRevisionId=not-current",
      );
      const fromBody = await importAs(CREATOR, {
        game: def,
        allowUpdate: true,
        expectedCurrentRevisionId: "not-current",
      });
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
      const preview = await importAs(
        CREATOR,
        definition(key, "Recreated 2026 v2"),
        "?dryRun=true&allowUpdate=true",
      );
      const previewed = preview.json().existing.currentRevisionId;

      const old = await prisma.game.findUniqueOrThrow({ where: { id: created.json().gameId } });
      expect(
        (await app.inject({ method: "DELETE", url: `/games/${old.id}`, headers: as(ADMIN) }))
          .statusCode,
      ).toBe(204);
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
        visibility: {
          kind: "discord-role",
          guildId: EU_SERVER_ID,
          roleId: "test-casual-gone-role",
        },
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

    test("the creator keeps their game after leaving every server: list, export, links", async () => {
      await setEuMember(CREATOR, false);
      expect((await listGames(CREATOR, true)).map((g) => g.id)).toContain(gameId);
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameId}/export`,
        headers: as(CREATOR),
      });
      expect(res.statusCode).toBe(200);
      const link = await app.inject({
        method: "POST",
        url: `/games/${gameId}/links`,
        headers: as(CREATOR),
      });
      expect(link.statusCode).toBe(201);
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

    test("another creator can't manage the creator's game", async () => {
      const patch = await app.inject({
        method: "PATCH",
        url: `/games/${gameId}`,
        headers: as(RIVAL),
        payload: { unlisted: true },
      });
      expect(patch.statusCode).toBe(403);
      const links = await app.inject({
        method: "POST",
        url: `/games/${gameId}/links`,
        headers: as(RIVAL),
      });
      expect(links.statusCode).toBe(403);
      const del = await app.inject({
        method: "DELETE",
        url: `/games/${gameId}`,
        headers: as(RIVAL),
      });
      expect(del.statusCode).toBe(403);
    });

    test("the creator renames their game while in a server; others can't", async () => {
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
      await setEuMember(CREATOR, false);
      expect((await rename(CREATOR, "After Leaving 2026")).statusCode).toBe(403);
      await setEuMember(CREATOR);

      const own = await rename(CREATOR, "Settings 2026 Renamed");
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({
        status: "updated",
        game: { name: "Settings 2026 Renamed", unlisted: true, createdById: CREATOR },
      });
      const admin = await rename(ADMIN, "Settings 2026 By Admin");
      expect(admin.statusCode).toBe(200);
      expect(admin.json().game).toMatchObject({
        name: "Settings 2026 By Admin",
        createdById: CREATOR,
      });
    });

    test("the creator deletes their game, also after leaving every server, as do global admins", async () => {
      const del = async (userId: string, suffix: string) => {
        const created = await importAs(CREATOR, definition(`${KEY_PREFIX}${suffix}`, "Doomed"));
        expect(created.statusCode).toBe(201);
        if (suffix === "deleted-after-leaving") await setEuMember(CREATOR, false);
        const res = await app.inject({
          method: "DELETE",
          url: `/games/${created.json().gameId}`,
          headers: as(userId),
        });
        await setEuMember(CREATOR);
        return res.statusCode;
      };
      expect(await del(CREATOR, "deleted")).toBe(204);
      expect(await del(CREATOR, "deleted-after-leaving")).toBe(204);
      expect(await del(ADMIN, "deleted-by-admin")).toBe(204);
      expect(await del(RIVAL, "not-deleted")).toBe(403);
    });

    test("the creator starts sessions from a game link, not directly", async () => {
      const direct = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: as(CREATOR),
        payload: { gameId, name: "Direct" },
      });
      expect(direct.statusCode).toBe(403);

      const link = await app.inject({
        method: "POST",
        url: `/games/${gameId}/links`,
        headers: as(CREATOR),
      });
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

  describe("limits", () => {
    const saved = { ...CASUAL_LIMITS, ...WRITE_LIMIT };
    const limitedKey = (suffix: string) => `${KEY_PREFIX}limited-${suffix}`;
    // A definition about `points` hiding zones big, which compression can't shrink.
    const sized = (id: string, name: string, points: number) => {
      const def = definition(id, name);
      def.hidingZones.features.features = Array.from({ length: points }, () => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [-0.5 + Math.random() * 0.8, 51.3 + Math.random() * 0.4],
        },
      }));
      return def;
    };
    const create = async (suffix: string, def = definition(limitedKey(suffix), suffix)) => {
      const res = await importAs(LIMITED, def);
      expect(res.statusCode, res.body).toBe(201);
      return res.json().gameId as string;
    };
    const storedBytes = async () => {
      const [{ bytes }] = await prisma.$queryRaw<{ bytes: bigint }[]>`
        SELECT COALESCE(SUM(pg_column_size(r.definition)), 0)::bigint AS bytes
        FROM "GameRevision" r JOIN "Game" g ON g.id = r."gameId"
        WHERE g."serverId" = ${CASUAL_SERVER_ID} AND g."createdById" = ${LIMITED}`;
      return Number(bytes);
    };
    const sessionOn = async (gameId: string, revision = 1) =>
      prisma.gameSession.create({
        data: {
          gameId,
          serverId: CASUAL_SERVER_ID,
          creatorId: LIMITED,
          name: "Pinning",
          gameRevisionId: (
            await prisma.gameRevision.findFirstOrThrow({ where: { gameId, revision } })
          ).id,
        },
      });

    beforeEach(async () => {
      const where = { createdById: LIMITED };
      await prisma.gameSession.deleteMany({ where: { game: where } });
      await prisma.game.updateMany({ where, data: { currentRevisionId: null } });
      await prisma.game.deleteMany({ where });
    });

    afterAll(() => {
      Object.assign(CASUAL_LIMITS, { games: saved.games, bytes: saved.bytes });
      Object.assign(WRITE_LIMIT, {
        requests: saved.requests,
        inFlightPerUser: saved.inFlightPerUser,
        inFlightTotal: saved.inFlightTotal,
      });
    });

    test("the game cap refuses a new game, on the preview too, but not an update or a deleted game's place", async () => {
      CASUAL_LIMITS.games = 2;
      try {
        const first = await create("a");
        await create("b");
        for (const query of ["?dryRun=true", ""]) {
          const res = await importAs(LIMITED, definition(limitedKey("c"), "C"), query);
          expect(res.statusCode).toBe(409);
          expect(res.json()).toMatchObject({
            code: "CASUAL_GAME_LIMIT",
            message: "You already have 2 Casual games. Delete one to upload another.",
          });
        }
        const update = await importAs(
          LIMITED,
          definition(limitedKey("a"), "A v2"),
          "?allowUpdate=true",
        );
        expect(update.statusCode).toBe(200);

        // A deleted game stops counting, also while a session keeps it.
        await sessionOn(first, 2);
        expect(
          (await app.inject({ method: "DELETE", url: `/games/${first}`, headers: as(LIMITED) }))
            .statusCode,
        ).toBe(204);
        const [c, d] = await Promise.all(
          ["c", "d"].map((suffix) =>
            importAs(LIMITED, definition(limitedKey(suffix), suffix.toUpperCase())),
          ),
        );
        expect([c.statusCode, d.statusCode].sort()).toEqual([201, 409]);
        expect(await prisma.game.count({ where: { createdById: LIMITED, archivedAt: null } })).toBe(
          2,
        );
      } finally {
        CASUAL_LIMITS.games = saved.games;
      }
    });

    test("the storage cap counts deleted games' revisions sessions still use, and refuses with nothing written", async () => {
      const doomed = await create("doomed");
      const session = await sessionOn(doomed);
      await app.inject({ method: "DELETE", url: `/games/${doomed}`, headers: as(LIMITED) });
      const kept = await create("kept");
      CASUAL_LIMITS.bytes = await storedBytes();
      try {
        const writes = [
          () => importAs(LIMITED, definition(limitedKey("new"), "New")),
          () => replaceAs(LIMITED, kept, sized(limitedKey("kept"), "Kept", 50)),
          async () =>
            app.inject({
              method: "PATCH",
              url: `/games/${kept}/settings`,
              headers: as(LIMITED),
              payload: {
                baseRevisionId: (await prisma.game.findUniqueOrThrow({ where: { id: kept } }))
                  .currentRevisionId,
                name: "Kept, with a longer name",
              },
            }),
        ];
        for (const write of writes) {
          const res = await write();
          expect(res.statusCode).toBe(413);
          expect(res.json().code).toBe("CASUAL_STORAGE_LIMIT");
          expect(res.json().message).toMatch(
            /^This would bring your Casual games to \d+ MB, over the \d+ MB allowed\. Versions that existing sessions still use count toward it\./,
          );
        }
        expect(await prisma.game.count({ where: { createdById: LIMITED } })).toBe(2);
        expect(await prisma.gameRevision.count({ where: { gameId: kept } })).toBe(1);
        expect(
          await prisma.auditLog.count({ where: { targetId: kept, action: "game.revision" } }),
        ).toBe(0);

        // Global admins aren't capped.
        const byAdmin = await replaceAs(ADMIN, kept, sized(limitedKey("kept"), "Kept", 50));
        expect(byAdmin.statusCode).toBe(200);

        // The session's end frees the deleted game's bytes.
        expect(
          (
            await app.inject({
              method: "DELETE",
              url: `/sessions/${session.id}`,
              headers: as(LIMITED),
            })
          ).statusCode,
        ).toBe(204);
        expect(await prisma.game.findUnique({ where: { id: doomed } })).toBeNull();
        CASUAL_LIMITS.bytes = (await storedBytes()) + 1024;
        await create("new");
      } finally {
        CASUAL_LIMITS.bytes = saved.bytes;
      }
    });

    test("a revision no session uses any more is freed when the cap would refuse another game", async () => {
      const first = await create("stale", sized(limitedKey("stale"), "Stale", 200));
      const session = await sessionOn(first);
      await importAs(LIMITED, definition(limitedKey("stale"), "Stale v2"), "?allowUpdate=true");
      // Its session went without a prune (e.g. that prune failed).
      await prisma.gameSession.delete({ where: { id: session.id } });
      expect(await prisma.gameRevision.count({ where: { gameId: first } })).toBe(2);

      CASUAL_LIMITS.bytes = await storedBytes();
      try {
        await create("other");
      } finally {
        CASUAL_LIMITS.bytes = saved.bytes;
      }
      const left = await prisma.gameRevision.findMany({ where: { gameId: first } });
      expect(left.map((r) => r.revision)).toEqual([2]);
    });

    test("global admins have no game cap", async () => {
      CASUAL_LIMITS.games = 0;
      try {
        const res = await importAs(ADMIN, definition(limitedKey("admin"), "Admin"), "?dryRun=true");
        expect(res.statusCode).toBe(201);
      } finally {
        CASUAL_LIMITS.games = saved.games;
      }
    });

    test("uploads, previews, renames and link changes share a rate limit; global admins have none", async () => {
      const gameIdOfLimited = await create("rated");
      WRITE_LIMIT.requests = 2;
      try {
        const preview = () =>
          importAs(LIMITED, definition(limitedKey("rated-2"), "Rated"), "?dryRun=true");
        expect((await preview()).statusCode).toBe(201);
        const refused = [
          await preview(),
          await app.inject({
            method: "POST",
            url: `/games/${gameIdOfLimited}/links`,
            headers: as(LIMITED),
          }),
          await app.inject({
            method: "PATCH",
            url: `/games/${gameIdOfLimited}/settings`,
            headers: as(LIMITED),
            payload: { baseRevisionId: "any", name: "Renamed" },
          }),
          await app.inject({
            method: "DELETE",
            url: `/games/${gameIdOfLimited}/links/any`,
            headers: as(LIMITED),
          }),
        ];
        for (const res of refused) {
          expect(res.statusCode).toBe(429);
          expect(res.json()).toMatchObject({
            code: "RATE_LIMITED",
            message: "Too many uploads or changes in a short time. Try again in 10 minutes.",
          });
        }
        for (let i = 0; i < 3; i++) {
          const res = await importAs(ADMIN, definition(limitedKey("admin"), "A"), "?dryRun=true");
          expect(res.statusCode).toBe(201);
        }
      } finally {
        WRITE_LIMIT.requests = saved.requests;
      }
    });

    test("an upload in progress holds a slot until it ends, also by a parse error or an abort", async () => {
      WRITE_LIMIT.inFlightPerUser = 1;
      try {
        const preview = () =>
          importAs(LIMITED, definition(limitedKey("slot"), "Slot"), "?dryRun=true");
        const broken = await app.inject({
          method: "POST",
          url: "/games/import?dryRun=true",
          headers: { ...as(LIMITED), "content-type": "application/json" },
          payload: "{ not json",
        });
        expect(broken.statusCode).toBe(400);
        expect((await preview()).statusCode).toBe(201);

        await app.listen({ port: 0, host: "127.0.0.1" });
        const { port } = app.server.address() as { port: number };
        // Headers sent, body still coming.
        const slow = request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/games/import?dryRun=true",
          headers: {
            ...as(LIMITED),
            "content-type": "application/json",
            "content-length": "100000",
          },
        });
        slow.on("error", () => {});
        slow.write("{");
        // Synchronous, so it can't take the slot from the request.
        const slotTaken = () => {
          try {
            acquireUploadSlot(LIMITED)();
            return false;
          } catch {
            return true;
          }
        };
        await vi.waitFor(() => expect(slotTaken()).toBe(true));
        const res = await preview();
        expect(res.statusCode).toBe(429);
        expect(res.json()).toMatchObject({
          code: "RATE_LIMITED",
          message: "Another upload is still being processed. Wait for it to finish and try again.",
        });
        slow.destroy();
        await vi.waitFor(() => expect(slotTaken()).toBe(false));
        expect((await preview()).statusCode).toBe(201);
      } finally {
        WRITE_LIMIT.inFlightPerUser = saved.inFlightPerUser;
      }
    });
  });

  describe("servers", () => {
    const listServers = async (userId: string) => {
      const res = await app.inject({ method: "GET", url: "/servers", headers: as(userId) });
      expect(res.statusCode).toBe(200);
      return res.json().servers as { id: string; permissions: string[]; isMember: boolean }[];
    };

    test("Casual is listed for anyone in a server, with games.create only", async () => {
      const casual = (await listServers(RIVAL)).find((s) => s.id === CASUAL_SERVER_ID);
      expect(casual).toEqual(
        expect.objectContaining({ permissions: ["games.create"], isMember: true }),
      );
    });

    test("Casual stays listed for a creator of Casual games who left every server", async () => {
      await setEuMember(CREATOR, false);
      const casual = (await listServers(CREATOR)).find((s) => s.id === CASUAL_SERVER_ID);
      expect(casual).toEqual(
        expect.objectContaining({ permissions: [], isMember: true, hasOwnGames: true }),
      );
    });

    test("Casual is hidden from someone in no server without sessions or games there", async () => {
      expect((await listServers(OUTSIDER)).map((s) => s.id)).not.toContain(CASUAL_SERVER_ID);
    });

    test("the role routes use the management guild's roles, for global admins only", async () => {
      mockGetGuildRoles.mockClear();
      const res = await app.inject({
        method: "GET",
        url: `/servers/${CASUAL_SERVER_ID}/roles`,
        headers: as(ADMIN),
      });
      expect(res.statusCode).toBe(200);
      expect(mockGetGuildRoles).toHaveBeenCalledWith(
        EU_SERVER_ID,
        expect.anything(),
        expect.anything(),
      );
      expect(res.json().roles.map((r: { id: string }) => r.id)).toEqual([
        CREATOR_ROLE,
        MAPPED_ROLE,
      ]);

      const creator = await app.inject({
        method: "GET",
        url: `/servers/${CASUAL_SERVER_ID}/roles`,
        headers: as(CREATOR),
      });
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
