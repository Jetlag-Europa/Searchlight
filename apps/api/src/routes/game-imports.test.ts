import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../lib/discord-client.js", () => ({
  discord: {
    getGuildMember: vi.fn().mockResolvedValue(null),
  },
}));
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { discord } from "../lib/discord-client.js";
import { gameImportRoutes } from "./game-imports.js";
import { sessionRoutes } from "./sessions.js";
import { linkRoutes } from "./links.js";
import {
  importGameDefinition,
  ImportForbiddenError,
} from "../games/import-service.js";

// ── Test Constants & IDs ───────────────────────────────────────────────────

const TEST_SERVER_A = "test-server-imports-a";
const TEST_SERVER_B = "test-server-imports-b";
const ROLE_GATE_ID = "test-role-gate-123";
const ROLE_GAME_CREATOR_ID = "test-role-game-creator";

const USER_MEMBER = "test-user-imports-member";
const USER_NO_ROLE = "test-user-imports-norole";
const USER_NONMEMBER = "test-user-imports-nonmember";
const USER_CREATOR = "test-user-imports-creator";

const AUTH_MEMBER = "test-auth-imports-member";
const AUTH_NO_ROLE = "test-auth-imports-norole";
const AUTH_NONMEMBER = "test-auth-imports-nonmember";
const AUTH_CREATOR = "test-auth-imports-creator";

const GAME_A_KEY = "test-game-imports-a";
const GAME_NO_DEF_KEY = "test-game-imports-nodef";
const GAME_UNICODE_KEY = "test-game-imports-東京";
const GAME_OWNER_KEY = "test-game-imports-owner";
// Shaped like a generated id; used as one game's id and another game's key.
const CUID_LIKE = "ctestgameimportsshadow001";

const FIXTURE_USERS = [USER_MEMBER, USER_NO_ROLE, USER_NONMEMBER, USER_CREATOR];
const FIXTURE_AUTHS = [AUTH_MEMBER, AUTH_NO_ROLE, AUTH_NONMEMBER, AUTH_CREATOR];
const FIXTURE_GAMES = [GAME_A_KEY, GAME_NO_DEF_KEY, GAME_UNICODE_KEY, GAME_OWNER_KEY, CUID_LIKE];
const FIXTURE_SERVERS = [TEST_SERVER_A, TEST_SERVER_B];

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"] ?? "test-secret-at-least-32-chars-long",
  });
  await app.register(gameImportRoutes, { prefix: "/games" });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.register(linkRoutes, { prefix: "/links" });
  await app.ready();
  return app;
}

function signedCookie(app: FastifyInstance, sessionToken: string): string {
  return `session=${app.signCookie(sessionToken)}`;
}

function importableDefinition(serverId: string) {
  return {
    id: "test-game-imports-new",
    name: "Imported Game",
    serverId,
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
        features: [
          { type: "Feature", geometry: { type: "Point", coordinates: [0.5, 0.5] } } as object,
        ],
      },
    },
  };
}

async function cleanupFixtures(): Promise<void> {
  await prisma.serverMembershipCache.deleteMany({
    where: { userId: { in: FIXTURE_USERS } },
  });
  await prisma.authSession.deleteMany({
    where: { id: { in: FIXTURE_AUTHS } },
  });
  await prisma.sessionQuestion.deleteMany({
    where: { session: { creatorId: { in: FIXTURE_USERS } } },
  });

  const fixtureSessions = await prisma.gameSession.findMany({
    where: { creatorId: { in: FIXTURE_USERS } },
    select: { id: true },
  });
  const fixtureSessionIds = fixtureSessions.map((s) => s.id);

  if (fixtureSessionIds.length > 0) {
    await prisma.linkSnapshot.deleteMany({
      where: { link: { sessionId: { in: fixtureSessionIds } } },
    });
  }

  await prisma.sessionLink.deleteMany({
    where: { createdById: { in: FIXTURE_USERS } },
  });
  await prisma.sessionParticipant.deleteMany({
    where: { userId: { in: FIXTURE_USERS } },
  });
  await prisma.gameSession.deleteMany({
    where: { creatorId: { in: FIXTURE_USERS } },
  });
  await prisma.gameRevision.deleteMany({
    where: { game: { gameKey: { in: FIXTURE_GAMES } } },
  });
  await prisma.game.deleteMany({
    where: { gameKey: { in: FIXTURE_GAMES } },
  });
  await prisma.rolePermission.deleteMany({
    where: { serverId: { in: FIXTURE_SERVERS } },
  });
  await prisma.server.deleteMany({
    where: { id: { in: FIXTURE_SERVERS } },
  });
  await prisma.user.deleteMany({
    where: { discordId: { in: FIXTURE_USERS } },
  });
}

describe("Game Definition Access & Revision Security", () => {
  let app: FastifyInstance;
  let gameAId: string;
  let gameARev1Id: string;
  let gameARev2Id: string;
  let gameNoDefId: string;
  let sharedSessionId: string;

  beforeAll(async () => {
    app = await buildTestApp();

    // Clean previous test fixtures with strictly scoped IDs
    await cleanupFixtures();

    // Create servers
    await prisma.server.createMany({
      data: [
        { id: TEST_SERVER_A, name: "Test Server A" },
        { id: TEST_SERVER_B, name: "Test Server B" },
      ],
    });

    // Create users & auth sessions
    await prisma.user.createMany({
      data: [
        {
          discordId: USER_MEMBER,
          username: "member",
          displayName: "Server Member",
          avatarUrl: "https://example.com/avatar1.png",
          discordAccessToken: "tok1",
          discordRefreshToken: "ref1",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          discordId: USER_NO_ROLE,
          username: "norole",
          displayName: "Member Without Role",
          avatarUrl: "https://example.com/avatar4.png",
          discordAccessToken: "tok4",
          discordRefreshToken: "ref4",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          discordId: USER_NONMEMBER,
          username: "nonmember",
          displayName: "External User",
          avatarUrl: "https://example.com/avatar2.png",
          discordAccessToken: "tok2",
          discordRefreshToken: "ref2",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
        {
          discordId: USER_CREATOR,
          username: "creator",
          displayName: "Game Creator",
          avatarUrl: "https://example.com/avatar3.png",
          discordAccessToken: "tok3",
          discordRefreshToken: "ref3",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    await prisma.authSession.createMany({
      data: [
        { id: AUTH_MEMBER, userId: USER_MEMBER, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH_NO_ROLE, userId: USER_NO_ROLE, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH_NONMEMBER, userId: USER_NONMEMBER, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH_CREATOR, userId: USER_CREATOR, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    // Seed server membership cache for TEST_SERVER_A
    await prisma.serverMembershipCache.createMany({
      data: [
        {
          userId: USER_MEMBER,
          serverId: TEST_SERVER_A,
          isMember: true,
          roles: [ROLE_GATE_ID],
          cachedAt: new Date(),
        },
        {
          userId: USER_NO_ROLE,
          serverId: TEST_SERVER_A,
          isMember: true,
          roles: [], // In server, but lacks the role gate
          cachedAt: new Date(),
        },
        {
          userId: USER_CREATOR,
          serverId: TEST_SERVER_A,
          isMember: true,
          roles: [ROLE_GAME_CREATOR_ID],
          cachedAt: new Date(),
        },
      ],
    });
    await prisma.rolePermission.create({
      data: {
        serverId: TEST_SERVER_A,
        discordRoleId: ROLE_GAME_CREATOR_ID,
        permission: "games.create",
      },
    });

    // Create Game A with 2 revisions: R1 (role-gated) and R2 (current, role-gated)
    const gameA = await prisma.game.create({
      data: {
        gameKey: GAME_A_KEY,
        serverId: TEST_SERVER_A,
        name: "Test Game A",
        size: "medium",
      },
    });
    gameAId = gameA.id;

    const rev1 = await prisma.gameRevision.create({
      data: {
        gameId: gameA.id,
        revision: 1,
        checksum: "test-rev1-checksum",
        definition: {
          id: GAME_A_KEY,
          name: "Test Game A",
          serverId: TEST_SERVER_A,
          visibility: {
            kind: "discord-role",
            guildId: TEST_SERVER_A,
            roleId: ROLE_GATE_ID,
          },
        },
      },
    });
    gameARev1Id = rev1.id;

    const rev2 = await prisma.gameRevision.create({
      data: {
        gameId: gameA.id,
        revision: 2,
        checksum: "test-rev2-checksum",
        definition: {
          id: GAME_A_KEY,
          name: "Test Game A v2",
          serverId: TEST_SERVER_A,
          visibility: {
            kind: "discord-role",
            guildId: TEST_SERVER_A,
            roleId: ROLE_GATE_ID,
          },
        },
      },
    });
    gameARev2Id = rev2.id;

    await prisma.game.update({
      where: { id: gameA.id },
      data: { currentRevisionId: rev2.id },
    });

    // Create a revisionless game (no DB definition)
    const gameNoDef = await prisma.game.create({
      data: {
        gameKey: GAME_NO_DEF_KEY,
        serverId: TEST_SERVER_A,
        name: "Game Without Definition",
        size: "medium",
      },
    });
    gameNoDefId = gameNoDef.id;

    // Create a shared session where USER_NONMEMBER is a participant
    const session = await prisma.gameSession.create({
      data: {
        gameId: gameA.id,
        serverId: TEST_SERVER_A,
        creatorId: USER_CREATOR,
        name: "Shared Session",
        visibility: "shared",
        gameRevisionId: rev1.id,
      },
    });
    sharedSessionId = session.id;

    await prisma.sessionParticipant.create({
      data: {
        sessionId: session.id,
        userId: USER_NONMEMBER,
        role: "member",
        acceptedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await cleanupFixtures();
    await app.close();
  });

  describe("POST /games/import authentication and limits", () => {
    test("accepts bodies larger than Fastify's 1 MiB default", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }),
      });
      // Reaches the auth check instead of being rejected as 413 by the body parser.
      expect(res.statusCode).toBe(401);
    });

    test("authenticates before parsing the body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { "content-type": "application/json" },
        payload: "{ not json",
      });
      expect(res.statusCode).toBe(401);
    });

    test("rejects users who can't import on any server before parsing the body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_MEMBER), "content-type": "application/json" },
        payload: "{ not json",
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("FORBIDDEN");
    });

    test("parses the body of a user who can import on some server", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_CREATOR), "content-type": "application/json" },
        payload: "{ not json",
      });
      expect(res.statusCode).toBe(400);
    });

    test("rejects callers without import permission on the target server before validating", async () => {
      // USER_CREATOR may import on server A only.
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_CREATOR) },
        payload: { ...importableDefinition(TEST_SERVER_B), map: "invalid" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().errors).toBeUndefined();
    });

    test("caps the validation errors it returns", async () => {
      const def = importableDefinition(TEST_SERVER_A);
      const openRing = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
      def.hidingZones.features.features = Array.from({ length: 150 }, () => ({
        type: "Feature",
        geometry: openRing,
      }));
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_CREATOR) },
        payload: def,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors).toHaveLength(100);
      expect(res.json().message).toMatch(/150 error/);
    });

    test("reports an unregistered target server as SERVER_NOT_FOUND, not a server error", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_CREATOR) },
        payload: importableDefinition("unregistered-server-id"),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().errors[0].code).toBe("SERVER_NOT_FOUND");
    });

    test("returns 403 for a user without a Casual Games role importing there, without looking up its id", async () => {
      await prisma.server.createMany({
        data: [{ id: "home-games", name: "Casual Games" }],
        skipDuplicates: true,
      });
      const getGuildMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;
      getGuildMember.mockClear();
      // Its roles come from its management guild, if it has role mappings.
      getGuildMember.mockRejectedValueOnce(new Error("Discord guild lookup failed: 400"));

      const res = await app.inject({
        method: "POST",
        url: "/games/import?dryRun=true",
        headers: { cookie: signedCookie(app, AUTH_CREATOR) },
        payload: importableDefinition("home-games"),
      });
      expect(res.statusCode).toBe(403);
      // The virtual server's id is no Discord guild id.
      expect(getGuildMember).not.toHaveBeenCalledWith("home-games", expect.anything(), expect.anything());
      getGuildMember.mockReset();
      getGuildMember.mockResolvedValue(null);
    });
  });

  // ── 1. Definition Access Checks (Review Item 1) ───────────────────────────

  describe("Item 1: Definition access checks & shared-session legitimacy", () => {
    test("GET /games/:gameId/export returns 401 when anonymous", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export`,
      });
      expect(res.statusCode).toBe(401);
    });

    test("GET /games/:gameId/export returns 403 for non-member without sessionId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/export returns 403 for non-member with invalid sessionId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export?sessionId=invalid-session-id`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/export returns 403 for server member lacking required Discord role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export`,
        headers: {
          cookie: signedCookie(app, AUTH_NO_ROLE),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/export returns 200 for authorized server member with role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.id).toBe(GAME_A_KEY);
    });

    test("GET /games/:gameId/export returns 304 for a matching strong or proxy-weakened ETag", async () => {
      const cookie = signedCookie(app, AUTH_MEMBER);
      const first = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export`,
        headers: { cookie },
      });
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^".+"$/);

      for (const ifNoneMatch of [etag, `W/${etag}`, `"other", W/${etag}`]) {
        const res = await app.inject({
          method: "GET",
          url: `/games/${gameAId}/export`,
          headers: { cookie, "if-none-match": ifNoneMatch },
        });
        expect(res.statusCode).toBe(304);
      }
    });

    test("GET /games/:gameId/export returns 403 for external user even with a valid shared sessionId", async () => {
      // A session shares only its pinned revision, never the current export.
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/export?sessionId=${sharedSessionId}`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions returns 401 for anonymous caller", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions`,
      });
      expect(res.statusCode).toBe(401);
    });

    test("GET /games/:gameId/revisions returns 403 for non-member without sessionId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions returns 403 for server member lacking required Discord role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions`,
        headers: {
          cookie: signedCookie(app, AUTH_NO_ROLE),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions returns 200 for authorized user", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.revisions).toHaveLength(2);
    });

    test("GET /games/:gameId/revisions returns 403 for external user even with a shared sessionId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions?sessionId=${sharedSessionId}`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions/:revision returns 401 for anonymous caller", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/1`,
      });
      expect(res.statusCode).toBe(401);
    });

    test("GET /games/:gameId/revisions/:revision returns 403 for member lacking required Discord role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/1`,
        headers: {
          cookie: signedCookie(app, AUTH_NO_ROLE),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions/:revision returns 403 for non-member without sessionId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/1`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/:gameId/revisions/:revision returns revision by integer number for authorized member", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/1`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Test Game A");
    });

    test("GET /games/:gameId/revisions/:revision returns 404 for a revision number too large for the column", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/2147483648`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(404);
    });

    test("GET /games/:gameId/revisions/:revision returns revision by revision UUID for authorized member", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/${gameARev1Id}`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Test Game A");
    });

    test("GET /games/:gameId/revisions/:revision returns 200 for external user via sessionId query", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameAId}/revisions/${gameARev1Id}?sessionId=${sharedSessionId}`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Test Game A");
    });

    test("GET /games/revisions/:revisionId returns 401 for anonymous caller", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/revisions/${gameARev2Id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    test("GET /games/revisions/:revisionId returns 403 for member lacking required Discord role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/revisions/${gameARev2Id}`,
        headers: {
          cookie: signedCookie(app, AUTH_NO_ROLE),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("GET /games/revisions/:revisionId returns revision directly by UUID for authorized member", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/revisions/${gameARev2Id}`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Test Game A v2");
    });

    test("GET /games/revisions/:revisionId returns revision directly by UUID for external user via sessionId query", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/revisions/${gameARev1Id}?sessionId=${sharedSessionId}`,
        headers: {
          cookie: signedCookie(app, AUTH_NONMEMBER),
        },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Test Game A");
    });

    test("a sessionId does not grant revisions other than the one the session is pinned to", async () => {
      // sharedSessionId is pinned to rev1; rev2 is the game's current revision.
      for (const url of [
        `/games/revisions/${gameARev2Id}?sessionId=${sharedSessionId}`,
        `/games/${gameAId}/revisions/2?sessionId=${sharedSessionId}`,
        `/games/${gameAId}/revisions/${gameARev2Id}?sessionId=${sharedSessionId}`,
      ]) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { cookie: signedCookie(app, AUTH_NONMEMBER) },
        });
        expect(res.statusCode, url).toBe(403);
      }
    });
  });

  describe("Game lookup and export file names", () => {
    async function createGame(data: { id?: string; gameKey: string; name: string }) {
      const game = await prisma.game.create({
        data: { ...data, serverId: TEST_SERVER_A, size: "medium" },
      });
      const rev = await prisma.gameRevision.create({
        data: {
          gameId: game.id,
          revision: 1,
          checksum: `checksum-${encodeURIComponent(data.gameKey)}`,
          definition: { id: data.gameKey, name: data.name, serverId: TEST_SERVER_A },
        },
      });
      await prisma.game.update({ where: { id: game.id }, data: { currentRevisionId: rev.id } });
      return game;
    }

    test("export names a non-ASCII game key with an RFC 5987 file name", async () => {
      const game = await createGame({ gameKey: GAME_UNICODE_KEY, name: "Tokyo" });
      const res = await app.inject({
        method: "GET",
        url: `/games/${game.id}/export`,
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-disposition"]).toContain(
        `filename*=UTF-8''${encodeURIComponent(GAME_UNICODE_KEY)}.game.json`,
      );
    });

    test("a game's id is matched before another game's identical key", async () => {
      await createGame({ gameKey: CUID_LIKE, name: "Shadow" });
      await createGame({ id: CUID_LIKE, gameKey: GAME_OWNER_KEY, name: "Owner" });

      const res = await app.inject({
        method: "GET",
        url: `/games/${CUID_LIKE}/export`,
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("Owner");
    });
  });

  // ── 2. Cross-Server Update Prohibition (Review Item 2) ───────────────────

  describe("Item 2: Prohibit cross-server updates", () => {
    test("importGameDefinition rejects moving existing game to a different server", async () => {
      await expect(
        importGameDefinition({
          raw: {
            id: GAME_A_KEY,
            name: "Test Game A Move Attempt",
            serverId: TEST_SERVER_B, // target server is B, but game exists on server A
            map: {
              center: [0, 0],
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
                features: [
                  {
                    type: "Feature",
                    geometry: {
                      type: "Point",
                      coordinates: [0.5, 0.5],
                    },
                  },
                ],
              },
            },
          },
          allowUpdate: true,
        }),
      ).rejects.toThrow(ImportForbiddenError);
    });
  });

  // ── 7. No Request-Time Disk Fallback (Review Item 7) ──────────────────────

  describe("Item 7: Entirely remove request-time disk fallback", () => {
    test("GET /games/:gameId/export returns 404 for game without DB definition", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/games/${gameNoDefId}/export`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(res.statusCode).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error).toBe("Game definition not found");
    });
  });

  // ── 8. Fork Snapshots Retain Revision (Review Item 8) ────────────────────

  describe("Item 8: Fork link snapshots capture revision", () => {
    test("fork link captures revision and redeems with that captured revision", async () => {
      // 1. Creator creates fork link on session (currently at rev1)
      const linkRes = await app.inject({
        method: "POST",
        url: `/sessions/${sharedSessionId}/links`,
        headers: {
          cookie: signedCookie(app, AUTH_CREATOR),
        },
        payload: { linkType: "fork" },
      });
      expect(linkRes.statusCode).toBe(201);
      const { token } = JSON.parse(linkRes.body);

      // Verify snapshot has gameRevisionId saved
      const savedLink = await prisma.sessionLink.findUnique({
        where: { token },
        include: { snapshot: true },
      });
      expect(savedLink?.snapshot?.gameRevisionId).toBe(gameARev1Id);

      // 2. Simulate session upgrade to rev2
      await prisma.gameSession.update({
        where: { id: sharedSessionId },
        data: { gameRevisionId: gameARev2Id },
      });

      // 3. Member redeems the fork link
      const redeemRes = await app.inject({
        method: "POST",
        url: `/links/${token}/redeem`,
        headers: {
          cookie: signedCookie(app, AUTH_MEMBER),
        },
      });
      expect(redeemRes.statusCode).toBe(200);
      const { sessionId: newSessionId } = JSON.parse(redeemRes.body);

      // 4. Verify the new session has captured rev1, NOT the upgraded rev2!
      const newSession = await prisma.gameSession.findUnique({
        where: { id: newSessionId },
      });
      expect(newSession?.gameRevisionId).toBe(gameARev1Id);
    });
  });

  describe("Session creation pins game revision", () => {
    test("POST /sessions pins current revision by default", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
        payload: {
          gameId: gameAId,
          name: "Test Pinning Session",
          visibility: "private",
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.gameRevisionId).toBe(gameARev2Id);
      expect(data.sessionRevision).toBe(2);

      const dbSession = await prisma.gameSession.findUnique({
        where: { id: data.id },
      });
      expect(dbSession?.gameRevisionId).toBe(gameARev2Id);
    });

    test("POST /sessions pins explicit valid revision when provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
        payload: {
          gameId: gameAId,
          name: "Test Explicit Pinning Session",
          visibility: "private",
          gameRevisionId: gameARev1Id,
        },
      });
      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.gameRevisionId).toBe(gameARev1Id);
      expect(data.sessionRevision).toBe(1);
      expect(data.currentRevision).toBe(2);
      expect(data.hasNewerRevision).toBe(true);

      const dbSession = await prisma.gameSession.findUnique({
        where: { id: data.id },
      });
      expect(dbSession?.gameRevisionId).toBe(gameARev1Id);
    });

    test("POST /sessions returns 403 for a non-member of the game's server", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_NONMEMBER) },
        payload: {
          gameId: GAME_A_KEY,
          name: "Non-member Attempt",
          visibility: "private",
          gameRevisionId: gameARev2Id,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("POST /sessions returns 403 for a member lacking the game's Discord role", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_NO_ROLE) },
        payload: {
          gameId: gameAId,
          name: "No-role Attempt",
          visibility: "private",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    test("upgrade-revision moves an authorized creator's session to the current revision", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
        payload: {
          gameId: gameAId,
          name: "Upgrade Me",
          visibility: "private",
          gameRevisionId: gameARev1Id,
        },
      });
      expect(created.statusCode).toBe(201);

      const res = await app.inject({
        method: "POST",
        url: `/sessions/${created.json().id}/upgrade-revision`,
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "upgraded", newRevision: 2, gameRevisionId: gameARev2Id });
    });

    test("upgrade-revision returns 403 when the creator cannot access the current revision", async () => {
      // e.g. a non-member who received a fork of a session pinned to rev1.
      const forked = await prisma.gameSession.create({
        data: {
          gameId: gameAId,
          serverId: TEST_SERVER_A,
          creatorId: USER_NONMEMBER,
          name: "Forked Copy",
          visibility: "private",
          gameRevisionId: gameARev1Id,
        },
      });
      await prisma.sessionParticipant.create({
        data: {
          sessionId: forked.id,
          userId: USER_NONMEMBER,
          role: "creator",
          acceptedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/sessions/${forked.id}/upgrade-revision`,
        headers: { cookie: signedCookie(app, AUTH_NONMEMBER) },
      });
      expect(res.statusCode).toBe(403);
      const after = await prisma.gameSession.findUnique({ where: { id: forked.id } });
      expect(after?.gameRevisionId).toBe(gameARev1Id);
    });

    test("POST /sessions rejects revisionless games", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { cookie: signedCookie(app, AUTH_MEMBER) },
        payload: {
          gameId: gameNoDefId,
          name: "Test Revisionless Attempt",
          visibility: "private",
        },
      });
      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.message).toMatch(/revision/i);
    });
  });
});
