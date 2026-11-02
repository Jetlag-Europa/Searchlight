import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameRoutes } from "./games.js";
import { importGameDefinition, updateGameSettings } from "../games/import-service.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const EDITOR_ID = "test-gsettings-editor"; // games.edit
const CREATOR_ID = "test-gsettings-creator"; // games.create only
const MEMBER_ID = "test-gsettings-member"; // no game permissions
const ADMIN_ID = "test-gsettings-admin"; // server.admin
const USERS = [EDITOR_ID, CREATOR_ID, MEMBER_ID, ADMIN_ID];
const SERVER_ID = "test-gsettings-server";
const EDIT_ROLE_ID = "test-gsettings-edit-role";
const CREATE_ROLE_ID = "test-gsettings-create-role";
const ADMIN_ROLE_ID = "test-gsettings-admin-role";
// Games are named "Test GSettings …", so their derived keys start with this.
const KEY_PREFIX = "test-gsettings-";

// No `id`: the gameKey is derived from the name, as in many uploaded games.
function definition(name: string, size?: "small" | "medium" | "large") {
  return {
    name,
    serverId: SERVER_ID,
    ...(size ? { size } : {}),
    map: {
      center: [0.5, 0.5],
      playArea: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
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

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
  await app.register(gameRoutes, { prefix: "/games" });
  await app.ready();
  return app;
}

async function cleanup() {
  const games = { gameKey: { startsWith: KEY_PREFIX } };
  await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { game: games } });
  await prisma.game.deleteMany({ where: games });
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

async function createGame(name: string, size?: "small" | "medium" | "large") {
  const result = await importGameDefinition({ raw: definition(name, size) });
  return prisma.game.findUniqueOrThrow({ where: { id: result.gameId } });
}

async function revisionsOf(gameId: string) {
  return prisma.gameRevision.findMany({
    where: { gameId },
    orderBy: { revision: "asc" },
    select: { id: true, revision: true, checksum: true, definition: true },
  });
}

describe("PATCH /games/:gameId/settings", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  const patch = (userId: string | null, gameId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/games/${gameId}/settings`,
      headers: userId ? { cookie: cookies[userId] } : {},
      payload,
    });

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

    await prisma.server.create({ data: { id: SERVER_ID, name: "Game Settings Server" } });
    await prisma.rolePermission.createMany({
      data: [
        { serverId: SERVER_ID, discordRoleId: EDIT_ROLE_ID, permission: "games.edit" },
        { serverId: SERVER_ID, discordRoleId: CREATE_ROLE_ID, permission: "games.create" },
        { serverId: SERVER_ID, discordRoleId: ADMIN_ROLE_ID, permission: "server.admin" },
      ],
    });
  });

  // Fresh membership caches, so no request reaches Discord.
  beforeEach(async () => {
    await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.serverMembershipCache.createMany({
      data: [
        { userId: EDITOR_ID, serverId: SERVER_ID, isMember: true, roles: [EDIT_ROLE_ID], cachedAt: new Date() },
        { userId: CREATOR_ID, serverId: SERVER_ID, isMember: true, roles: [CREATE_ROLE_ID], cachedAt: new Date() },
        { userId: MEMBER_ID, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
        { userId: ADMIN_ID, serverId: SERVER_ID, isMember: true, roles: [ADMIN_ROLE_ID], cachedAt: new Date() },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  test("needs a session and games.edit on the game's server", async () => {
    const game = await createGame("Test GSettings Auth");
    const payload = { baseRevisionId: game.currentRevisionId, name: "Test GSettings Auth 2" };

    expect((await patch(null, game.id, payload)).statusCode).toBe(401);
    for (const userId of [MEMBER_ID, CREATOR_ID]) {
      const res = await patch(userId, game.id, payload);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ message: "Forbidden" });
    }
    expect((await revisionsOf(game.id)).length).toBe(1);

    const res = await patch(EDITOR_ID, game.gameKey, payload);
    expect(res.statusCode).toBe(200);
    const admin = await patch(ADMIN_ID, game.id, {
      baseRevisionId: res.json().game.currentRevisionId,
      size: "large",
    });
    expect(admin.statusCode).toBe(200);
  });

  test("a rename keeps the gameKey and adds a revision", async () => {
    const game = await createGame("Test GSettings Rename");
    expect(game.gameKey).toBe(`${KEY_PREFIX}rename`);

    const res = await patch(EDITOR_ID, game.id, {
      baseRevisionId: game.currentRevisionId,
      name: "  Brand New Name  ",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: "updated",
      revision: 2,
      game: { id: game.id, gameKey: game.gameKey, name: "Brand New Name" },
    });

    const revisions = await revisionsOf(game.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(body.game.currentRevisionId).toBe(revisions[1].id);
    expect(revisions[1].definition).toMatchObject({
      id: game.gameKey,
      name: "Brand New Name",
      serverId: SERVER_ID,
    });
    expect(await prisma.game.count({ where: { gameKey: { startsWith: `${KEY_PREFIX}rename` } } })).toBe(1);
    expect(await prisma.game.count({ where: { gameKey: "brand-new-name" } })).toBe(0);
  });

  test("a size change updates the definition and the game", async () => {
    const game = await createGame("Test GSettings Size");
    const res = await patch(EDITOR_ID, game.id, { baseRevisionId: game.currentRevisionId, size: "large" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "updated", revision: 2, game: { size: "large" } });
    const [, rev2] = await revisionsOf(game.id);
    expect(rev2.definition).toMatchObject({ size: "large", name: "Test GSettings Size" });
  });

  test("unchanged settings add no revision", async () => {
    const game = await createGame("Test GSettings Noop", "small");
    const res = await patch(EDITOR_ID, game.id, {
      baseRevisionId: game.currentRevisionId,
      name: "Test GSettings Noop",
      size: "small",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "unchanged",
      revision: 1,
      game: { id: game.id, currentRevisionId: game.currentRevisionId },
    });
    expect((await revisionsOf(game.id)).length).toBe(1);
  });

  test("medium on a definition without a size is unchanged", async () => {
    const game = await createGame("Test GSettings Default Size");
    const res = await patch(EDITOR_ID, game.id, { baseRevisionId: game.currentRevisionId, size: "medium" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "unchanged", revision: 1 });
  });

  test("a name's length is checked once trimmed", async () => {
    const game = await createGame("Test GSettings Padded");
    const name = "x".repeat(120);
    const res = await patch(EDITOR_ID, game.id, { baseRevisionId: game.currentRevisionId, name: `  ${name}  ` });
    expect(res.statusCode).toBe(200);
    expect(res.json().game.name).toBe(name);
  });

  test("an edit started from an older revision is refused", async () => {
    const game = await createGame("Test GSettings Stale");
    const base = game.currentRevisionId;
    await patch(EDITOR_ID, game.id, { baseRevisionId: base, size: "small" });

    const res = await patch(EDITOR_ID, game.id, { baseRevisionId: base, name: "Other" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      statusCode: 409,
      code: "GAME_CHANGED",
      message: expect.stringContaining("Reload the page"),
    });
    const after = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect([after.name, after.size]).toEqual(["Test GSettings Stale", "small"]);
    expect((await revisionsOf(game.id)).length).toBe(2);
  });

  test("rejects a blank name, unknown fields and unknown games", async () => {
    const game = await createGame("Test GSettings Invalid");
    const base = game.currentRevisionId;

    const blank = await patch(EDITOR_ID, game.id, { baseRevisionId: base, name: "   " });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().message).toMatch(/name/i);
    expect((await patch(EDITOR_ID, game.id, { baseRevisionId: base, unlisted: true })).statusCode).toBe(400);
    expect((await patch(EDITOR_ID, game.id, { baseRevisionId: base, size: "huge" })).statusCode).toBe(400);
    expect((await patch(EDITOR_ID, game.id, { baseRevisionId: base, name: "x".repeat(121) })).statusCode).toBe(400);
    expect((await patch(EDITOR_ID, game.id, { name: "No Base" })).statusCode).toBe(400);
    expect((await revisionsOf(game.id)).length).toBe(1);

    const missing = await patch(EDITOR_ID, `${KEY_PREFIX}does-not-exist`, { baseRevisionId: base });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ message: "Game not found" });
  });

  test("keeps the game archived and its preload checksum", async () => {
    const game = await createGame("Test GSettings Archived");
    const archivedAt = new Date("2026-01-02T03:04:05.000Z");
    await prisma.game.update({
      where: { id: game.id },
      data: { archivedAt, preloadChecksum: "preloaded-file-checksum" },
    });

    const res = await patch(EDITOR_ID, game.id, { baseRevisionId: game.currentRevisionId, size: "large" });
    expect(res.statusCode).toBe(200);
    expect(res.json().game.archivedAt).toBe(archivedAt.toISOString());
    const after = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    expect(after.archivedAt).toEqual(archivedAt);
    expect(after.preloadChecksum).toBe("preloaded-file-checksum");
  });

  test("reverting an edit re-activates the old revision", async () => {
    const game = await createGame("Test GSettings Revert");
    const [rev1] = await revisionsOf(game.id);

    const renamed = await patch(EDITOR_ID, game.id, { baseRevisionId: rev1.id, name: "Renamed" });
    expect(renamed.json()).toMatchObject({ status: "updated", revision: 2 });

    const reverted = await patch(EDITOR_ID, game.id, {
      baseRevisionId: renamed.json().game.currentRevisionId,
      name: "Test GSettings Revert",
    });
    expect(reverted.statusCode).toBe(200);
    // Pinning the derived id doesn't change the checksum, so it matches rev 1.
    expect(reverted.json()).toMatchObject({
      status: "updated",
      revision: 1,
      game: { currentRevisionId: rev1.id, name: "Test GSettings Revert" },
    });
    expect((await revisionsOf(game.id)).map((r) => r.revision)).toEqual([1, 2]);
  });

  test("an import committed during the edit is not undone", async () => {
    const game = await createGame("Test GSettings Race");
    const base = game.currentRevisionId!;
    // The upload commits after the edit read the game, before it is saved.
    const upload = await importGameDefinition({
      raw: definition("Test GSettings Race", "large"),
      allowUpdate: true,
    });
    expect(upload).toMatchObject({ status: "updated", revision: 2 });

    await expect(
      updateGameSettings({
        game: { ...game, currentRevisionId: base },
        baseRevisionId: base,
        name: "Edited",
        actor: {
          userId: EDITOR_ID,
          type: "cookie",
          canCreateGames: () => false,
          canEditGames: () => true,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "GAME_CHANGED" });

    const after = await prisma.game.findUniqueOrThrow({ where: { id: game.id } });
    const revisions = await revisionsOf(game.id);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(after.currentRevisionId).toBe(revisions[1].id);
    expect([after.name, after.size]).toEqual(["Test GSettings Race", "large"]);
  });
});
