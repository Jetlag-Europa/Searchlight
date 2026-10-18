import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameCatalogRoutes } from "./game-catalog.js";
import { serverRoutes } from "./servers.js";

// Rechecking membership asks Discord; each test says what Discord answers.
const { getGuildMember } = vi.hoisted(() => ({
  getGuildMember: vi.fn<(guildId: string, userId: string) => Promise<{ roles: string[] } | null>>(),
}));
vi.mock("../lib/discord-client.js", () => ({ discord: { getGuildMember } }));

// The catalog checks membership of every server, including other suites'
// (created and deleted while this runs). Caching memberships there would block
// their cleanup and asking Discord would leave the machine: for the catalog,
// this suite's users belong to no server but its own.
vi.mock("../lib/permissions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/permissions.js")>();
  return {
    ...original,
    isServerMember: async (...args: Parameters<typeof original.isServerMember>) =>
      args[1].startsWith("test-catalog-") ? original.isServerMember(...args) : false,
  };
});

// ── IDs scoped to this test suite ───────────────────────────────────────────
const PLAYER_ID = "test-catalog-player"; // member of SERVER_ID with the gate and admin roles
const OTHER_ID = "test-catalog-other"; // member of SERVER_ID without roles
const OUTSIDER_ID = "test-catalog-outsider"; // member of no server
const USERS = [PLAYER_ID, OTHER_ID, OUTSIDER_ID];
const SERVER_ID = "test-catalog-server";
const OTHER_SERVER_ID = "test-catalog-other-server"; // nobody here is a member
const GATE_ROLE_ID = "test-catalog-gate-role";
const ADMIN_ROLE_ID = "test-catalog-admin-role";
const OTHER_INVITE = "https://discord.gg/testcatalog";

const MANCHESTER = "test-catalog-manchester";
const BERN = "test-catalog-bern";
const GATED = "test-catalog-gated";
const UNLISTED = "test-catalog-unlisted";
const UNPUBLISHED = "test-catalog-unpublished"; // no revision yet
const ARCHIVED = "test-catalog-archived";
const ELSEWHERE = "test-catalog-elsewhere"; // on OTHER_SERVER_ID
const GAMES = [MANCHESTER, BERN, GATED, UNLISTED, UNPUBLISHED, ARCHIVED, ELSEWHERE];

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  await app.register(gameCatalogRoutes, { prefix: "/games" });
  await app.register(serverRoutes, { prefix: "/servers" });
  await app.ready();
  return app;
}

async function cleanup() {
  await prisma.game.updateMany({ where: { id: { in: GAMES } }, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.deleteMany({ where: { id: { in: GAMES } } });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

async function publish(
  gameId: string,
  serverId: string,
  { center, bounds, zones = 0, visibility }: {
    center: [number, number];
    bounds?: [number, number, number, number];
    zones?: number;
    visibility?: object;
  },
) {
  const rev = await prisma.gameRevision.create({
    data: {
      gameId,
      revision: 1,
      checksum: `${gameId}-r1`,
      definition: {
        id: gameId,
        name: gameId,
        serverId,
        ...(visibility ? { visibility } : {}),
        map: { center, ...(bounds ? { bounds } : {}), playArea: { type: "FeatureCollection", features: [] } },
        hidingZones: {
          features: {
            type: "FeatureCollection",
            features: Array.from({ length: zones }, (_, i) => ({
              type: "Feature",
              id: `zone-${i}`,
              geometry: { type: "Point", coordinates: center },
              properties: { name: `Zone ${i}` },
            })),
          },
        },
      },
    },
  });
  await prisma.game.update({ where: { id: gameId }, data: { currentRevisionId: rev.id } });
}

type CatalogGame = {
  id: string;
  name: string;
  serverName: string;
  center: [number, number];
  bounds: [number, number, number, number] | null;
  zoneCount: number;
  locked: boolean;
  joinUrl: string | null;
};

describe("game catalog", () => {
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

    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Catalog Server" },
        { id: OTHER_SERVER_ID, name: "Other Server", inviteUrl: OTHER_INVITE },
      ],
    });
    await prisma.rolePermission.create({
      data: { serverId: SERVER_ID, discordRoleId: ADMIN_ROLE_ID, permission: "server.admin" },
    });
    await prisma.game.createMany({
      data: [
        { id: MANCHESTER, gameKey: MANCHESTER, serverId: SERVER_ID, name: "Greater Manchester", size: "large" },
        { id: BERN, gameKey: BERN, serverId: SERVER_ID, name: "Espace Mittelland" },
        { id: GATED, gameKey: GATED, serverId: SERVER_ID, name: "Role-gated" },
        { id: UNLISTED, gameKey: UNLISTED, serverId: SERVER_ID, name: "Unlisted", unlisted: true },
        { id: UNPUBLISHED, gameKey: UNPUBLISHED, serverId: SERVER_ID, name: "Unpublished" },
        { id: ARCHIVED, gameKey: ARCHIVED, serverId: SERVER_ID, name: "Archived", archivedAt: new Date() },
        { id: ELSEWHERE, gameKey: ELSEWHERE, serverId: OTHER_SERVER_ID, name: "Elsewhere" },
      ],
    });
    await publish(MANCHESTER, SERVER_ID, {
      center: [-2.24, 53.48],
      bounds: [-2.73, 53.33, -1.91, 53.69],
      zones: 3,
    });
    await publish(BERN, SERVER_ID, { center: [7.44, 46.92], zones: 2 });
    await publish(GATED, SERVER_ID, {
      center: [4.48, 51.92],
      visibility: { kind: "discord-role", guildId: SERVER_ID, roleId: GATE_ROLE_ID },
    });
    await publish(UNLISTED, SERVER_ID, { center: [0, 0] });
    await publish(ARCHIVED, SERVER_ID, { center: [0, 0] });
    await publish(ELSEWHERE, OTHER_SERVER_ID, { center: [0, 0] });
  });

  // Fresh membership caches (as old as `age`), so no request reaches Discord.
  const cacheMemberships = async (age = 0) => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.serverMembershipCache.createMany({
      data: USERS.flatMap((userId) =>
        [SERVER_ID, OTHER_SERVER_ID].map((serverId) => ({
          userId,
          serverId,
          isMember: serverId === SERVER_ID && userId !== OUTSIDER_ID,
          roles: serverId === SERVER_ID && userId === PLAYER_ID ? [GATE_ROLE_ID, ADMIN_ROLE_ID] : [],
          cachedAt: new Date(Date.now() - age),
        })),
      ),
    });
  };
  beforeEach(async () => {
    await cacheMemberships();
    getGuildMember.mockReset();
    getGuildMember.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  // Other suites share the database; look only at this suite's games.
  const catalog = async (userId: string) => {
    const res = await app.inject({ method: "GET", url: "/games/catalog", headers: as(userId) });
    expect(res.statusCode).toBe(200);
    return (res.json().games as CatalogGame[]).filter((g) => GAMES.includes(g.id));
  };
  test("lists the playable games of the user's servers with where they are", async () => {
    const games = await catalog(PLAYER_ID);
    const playable = games.filter((g) => !g.locked);
    expect(playable.map((g) => g.id).sort()).toEqual([BERN, GATED, MANCHESTER].sort());

    const manchester = games.find((g) => g.id === MANCHESTER)!;
    expect(manchester).toMatchObject({
      name: "Greater Manchester",
      serverName: "Catalog Server",
      center: [-2.24, 53.48],
      bounds: [-2.73, 53.33, -1.91, 53.69],
      zoneCount: 3,
      locked: false,
      joinUrl: null,
    });
    expect(games.find((g) => g.id === BERN)).toMatchObject({ bounds: null, zoneCount: 2 });
  });

  test("leaves out role-gated games the user can't pass", async () => {
    const games = await catalog(OTHER_ID);
    expect(games.filter((g) => !g.locked).map((g) => g.id).sort()).toEqual([BERN, MANCHESTER].sort());
  });

  test("leaves out archived games", async () => {
    expect((await catalog(PLAYER_ID)).map((g) => g.id)).not.toContain(ARCHIVED);
  });

  test("lists the games of servers the user hasn't joined, locked, only where the server offers an invite", async () => {
    const games = await catalog(OTHER_ID);
    expect(games.at(-1)).toMatchObject({ id: ELSEWHERE, locked: true, joinUrl: OTHER_INVITE });

    // Catalog Server has no invite set, so it shows non-members nothing.
    expect((await catalog(OUTSIDER_ID)).map((g) => g.id)).toEqual([ELSEWHERE]);
  });

  test("a membership recheck unlocks a server the user just joined", async () => {
    expect((await catalog(OUTSIDER_ID)).map((g) => g.id)).not.toContain(MANCHESTER);

    // Joined just now: the cache, written moments ago, still says otherwise.
    getGuildMember.mockResolvedValue({ roles: [] });
    const res = await app.inject({
      method: "POST",
      url: `/servers/${SERVER_ID}/membership`,
      headers: as(OUTSIDER_ID),
    });
    expect(res.json()).toEqual({ isMember: true });
    expect(getGuildMember).toHaveBeenCalledWith(SERVER_ID, OUTSIDER_ID, expect.anything());

    expect((await catalog(OUTSIDER_ID)).find((g) => g.id === MANCHESTER)?.locked).toBe(false);
  });

  test("trusts a cached non-member for 10 minutes, so loading the catalog rarely asks Discord", async () => {
    await cacheMemberships(5 * 60 * 1000);
    await catalog(OUTSIDER_ID);
    expect(getGuildMember).not.toHaveBeenCalled();

    await cacheMemberships(11 * 60 * 1000);
    await catalog(OUTSIDER_ID);
    expect(getGuildMember).toHaveBeenCalledWith(SERVER_ID, OUTSIDER_ID, expect.anything());
  });

  test("leaves out the games of a server Discord can't answer for, and says so", async () => {
    await cacheMemberships(61 * 60 * 1000);
    getGuildMember.mockRejectedValue(new Error("Discord unavailable"));
    const res = await app.inject({ method: "GET", url: "/games/catalog", headers: as(OTHER_ID) });
    expect(res.json().unavailableServers).toEqual(expect.arrayContaining(["Catalog Server", "Other Server"]));
    expect((res.json().games as CatalogGame[]).filter((g) => GAMES.includes(g.id))).toEqual([]);
  });

  test("rechecks ask Discord at most every 10 s and report Discord failures plainly", async () => {
    const recheck = () =>
      app.inject({ method: "POST", url: `/servers/${OTHER_SERVER_ID}/membership`, headers: as(OTHER_ID) });

    getGuildMember.mockRejectedValue(new Error(`Discord /guilds/${OTHER_SERVER_ID}/members/x failed: 503`));
    const failed = await recheck();
    expect(failed.statusCode).toBe(503);
    expect(failed.json().message).not.toMatch(/guilds/);

    const again = await recheck();
    expect(again.statusCode).toBe(429);
    expect(getGuildMember).toHaveBeenCalledTimes(1);
  });

  test("server admins set a Discord invite, and only a Discord invite", async () => {
    const patch = (userId: string, inviteUrl: string | null) =>
      app.inject({
        method: "PATCH",
        url: `/servers/${SERVER_ID}`,
        headers: as(userId),
        payload: { inviteUrl },
      });

    expect((await patch(OTHER_ID, "https://discord.gg/abc")).statusCode).toBe(403);
    expect((await patch(PLAYER_ID, "https://evil.example/discord.gg/abc")).statusCode).toBe(400);
    expect((await patch(PLAYER_ID, "https://discord.com/invite/abc-123")).json()).toEqual({
      id: SERVER_ID,
      inviteUrl: "https://discord.com/invite/abc-123",
    });
    // Setting an invite shows the server's games to non-members; clearing it hides them again.
    expect((await catalog(OUTSIDER_ID)).find((g) => g.id === MANCHESTER)).toMatchObject({
      locked: true,
      joinUrl: "https://discord.com/invite/abc-123",
    });
    expect((await patch(PLAYER_ID, null)).json().inviteUrl).toBeNull();
    expect((await catalog(OUTSIDER_ID)).map((g) => g.id)).not.toContain(MANCHESTER);
  });

  test("reports no unavailable servers when every membership could be checked", async () => {
    const res = await app.inject({ method: "GET", url: "/games/catalog", headers: as(PLAYER_ID) });
    expect(res.json().unavailableServers).toEqual([]);
  });
});
