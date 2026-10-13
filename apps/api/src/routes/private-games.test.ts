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
import { gameRoutes } from "./games.js";
import { gameImportRoutes } from "./game-imports.js";
import { sessionRoutes } from "./sessions.js";
import { linkRoutes } from "./links.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SERVER = "test-server-private-games";
const ROLE_EDIT = "test-private-role-edit";
const ROLE_CREATE = "test-private-role-create";
const ROLE_UPLOAD = "test-private-role-upload";

const USERS = {
  editor: { id: "test-private-editor", roles: [ROLE_EDIT], isMember: true },
  creator: { id: "test-private-creator", roles: [ROLE_CREATE], isMember: true },
  uploader: { id: "test-private-uploader", roles: [ROLE_UPLOAD], isMember: true },
  member: { id: "test-private-member", roles: [], isMember: true },
  outsider: { id: "test-private-outsider", roles: [], isMember: false },
  stranger: { id: "test-private-stranger", roles: [], isMember: false },
} as const;
type UserName = keyof typeof USERS;
const USER_IDS = Object.values(USERS).map((u) => u.id);
const auth = (name: UserName) => `test-private-auth-${name}`;

const KEY_PREFIX = "test-private-game-";
const PRIVATE_KEY = `${KEY_PREFIX}uploaded`;
const LISTED_KEY = `${KEY_PREFIX}listed`;

function definition(id: string, name = "Private Game") {
  return {
    id,
    name,
    serverId: SERVER,
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

async function cleanup() {
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USER_IDS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USER_IDS } } });
  await prisma.gameSession.deleteMany({ where: { creatorId: { in: USER_IDS } } });
  await prisma.game.deleteMany({ where: { gameKey: { startsWith: KEY_PREFIX } } });
  await prisma.rolePermission.deleteMany({ where: { serverId: SERVER } });
  await prisma.server.deleteMany({ where: { id: SERVER } });
  await prisma.user.deleteMany({ where: { discordId: { in: USER_IDS } } });
}

describe("Private (unlisted) games and game links", () => {
  let app: FastifyInstance;
  // The outsider's session from a game link, and a stranger's fork of it.
  let linkSessionId: string;
  let forkedSessionId: string;

  const request = (
    name: UserName | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      payload,
      headers: name ? { cookie: `session=${app.signCookie(auth(name))}` } : {},
    });
  const importAs = (name: UserName, def: object, query = "") =>
    request(name, "POST", `/games/import${query}`, def);
  const gameKeysFor = async (name: UserName, query = "") =>
    ((await request(name, "GET", `/games?serverId=${SERVER}${query}`)).json().games as {
      gameKey: string;
    }[]).map((g) => g.gameKey);
  const privateGame = () => prisma.game.findUniqueOrThrow({ where: { gameKey: PRIVATE_KEY } });

  beforeAll(async () => {
    await cleanup();
    await prisma.server.create({ data: { id: SERVER, name: "Private Games Server" } });
    await prisma.rolePermission.createMany({
      data: [
        { serverId: SERVER, discordRoleId: ROLE_EDIT, permission: "games.edit" },
        { serverId: SERVER, discordRoleId: ROLE_CREATE, permission: "games.create" },
        { serverId: SERVER, discordRoleId: ROLE_UPLOAD, permission: "games.create-unlisted" },
      ],
    });
    for (const [name, user] of Object.entries(USERS) as [UserName, (typeof USERS)[UserName]][]) {
      await prisma.user.create({
        data: {
          discordId: user.id,
          username: name,
          displayName: name,
          avatarUrl: "https://example.com/avatar.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.authSession.create({
        data: { id: auth(name), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      // Fresh cache entries, so no lookup reaches Discord.
      await prisma.serverMembershipCache.create({
        data: {
          userId: user.id,
          serverId: SERVER,
          isMember: user.isMember,
          roles: [...user.roles],
          cachedAt: new Date(Date.now() + 3_600_000),
        },
      });
    }

    app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(gameRoutes, { prefix: "/games" });
    await app.register(gameImportRoutes, { prefix: "/games" });
    await app.register(sessionRoutes, { prefix: "/sessions" });
    await app.register(linkRoutes, { prefix: "/links" });
    await app.ready();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  describe("uploading", () => {
    test("an uploader's new game is unlisted and owned by them", async () => {
      const res = await importAs("uploader", definition(PRIVATE_KEY));
      expect(res.statusCode).toBe(201);
      expect(res.json().listing).toBe("unlisted");

      const game = await privateGame();
      expect(game.listing).toBe("unlisted");
      expect(game.ownerId).toBe(USERS.uploader.id);
    });

    test("an uploader cannot create a listed game", async () => {
      const res = await importAs("uploader", definition(`${KEY_PREFIX}wants-listed`), "?listing=listed");
      expect(res.statusCode).toBe(403);
    });

    test("a game creator's game is listed unless they ask for unlisted", async () => {
      expect((await importAs("creator", definition(LISTED_KEY, "Listed Game"))).json().listing).toBe(
        "listed",
      );
      const unlisted = await importAs(
        "creator",
        definition(`${KEY_PREFIX}creator-private`),
        "?listing=unlisted",
      );
      expect(unlisted.statusCode).toBe(201);
      expect(unlisted.json().listing).toBe("unlisted");
    });

    test("an uploader cannot update someone else's game", async () => {
      const res = await importAs("uploader", definition(LISTED_KEY, "Hijacked"), "?allowUpdate=true");
      expect(res.statusCode).toBe(403);
    });

    test("a member without game permissions cannot upload", async () => {
      const res = await importAs("member", definition(`${KEY_PREFIX}member`));
      expect(res.statusCode).toBe(403);
    });
  });

  describe("game picker and direct access", () => {
    test("members don't see the unlisted game; its owner does", async () => {
      expect(await gameKeysFor("member")).not.toContain(PRIVATE_KEY);
      expect(await gameKeysFor("member")).toContain(LISTED_KEY);

      const res = await request("uploader", "GET", `/games?serverId=${SERVER}`);
      const own = res.json().games.find((g: { gameKey: string }) => g.gameKey === PRIVATE_KEY);
      expect(own).toMatchObject({ listing: "unlisted", isOwner: true, canManage: true });
    });

    test("editors see unlisted games only when managing", async () => {
      expect(await gameKeysFor("editor")).not.toContain(PRIVATE_KEY);
      expect(await gameKeysFor("editor", "&manage=true")).toContain(PRIVATE_KEY);
      expect(await gameKeysFor("member", "&manage=true")).not.toContain(PRIVATE_KEY);
    });

    test("only managers start sessions of an unlisted game directly", async () => {
      const body = { gameId: PRIVATE_KEY, name: "Direct", visibility: "private" };
      expect((await request("member", "POST", "/sessions", body)).statusCode).toBe(404);
      expect((await request("outsider", "POST", "/sessions", body)).statusCode).toBe(404);
      expect((await request("uploader", "POST", "/sessions", body)).statusCode).toBe(201);
      expect((await request("editor", "POST", "/sessions", body)).statusCode).toBe(201);
    });

    test("only managers export an unlisted game", async () => {
      expect((await request("member", "GET", `/games/${PRIVATE_KEY}/export`)).statusCode).toBe(404);
      expect((await request("uploader", "GET", `/games/${PRIVATE_KEY}/export`)).statusCode).toBe(200);
    });
  });

  describe("game links", () => {
    let token: string;
    let linkId: string;

    test("only managers create links, and only for unlisted games", async () => {
      expect((await request("member", "POST", `/games/${PRIVATE_KEY}/links`, {})).statusCode).toBe(404);
      expect((await request("editor", "POST", `/games/${LISTED_KEY}/links`, {})).statusCode).toBe(409);

      const res = await request("uploader", "POST", `/games/${PRIVATE_KEY}/links`, {
        label: "Friends",
      });
      expect(res.statusCode).toBe(201);
      ({ token, id: linkId } = res.json());
      expect(token.startsWith("g_")).toBe(true);
      expect(res.json().label).toBe("Friends");

      const list = await request("uploader", "GET", `/games/${PRIVATE_KEY}/links`);
      expect(list.json().links.map((l: { id: string }) => l.id)).toContain(linkId);
    });

    test("the link previews the game without signing in", async () => {
      const res = await request(null, "GET", `/links/${token}`);
      expect(res.json()).toEqual({ valid: true, gameName: "Private Game", linkType: "game" });
    });

    test("every redemption starts a new private session, even for non-members", async () => {
      const first = await request("outsider", "POST", `/links/${token}/redeem`);
      const second = await request("outsider", "POST", `/links/${token}/redeem`);
      expect(first.statusCode).toBe(200);
      expect(first.json().linkType).toBe("game");
      expect(second.json().sessionId).not.toBe(first.json().sessionId);
      linkSessionId = first.json().sessionId;

      const game = await privateGame();
      const session = await request("outsider", "GET", `/sessions/${linkSessionId}`);
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        gameId: game.id,
        gameName: "Private Game",
        gameKey: PRIVATE_KEY,
        gameSize: "medium",
        visibility: "private",
        role: "creator",
        gameRevisionId: game.currentRevisionId,
      });
    });

    test("the session's own revision loads, but nothing beyond it", async () => {
      const game = await privateGame();
      const pinned = await request(
        "outsider",
        "GET",
        `/games/revisions/${game.currentRevisionId}?sessionId=${linkSessionId}`,
      );
      expect(pinned.statusCode).toBe(200);
      expect((await request("outsider", "GET", `/games/${PRIVATE_KEY}/export`)).statusCode).toBe(404);
    });

    test("an owner's update keeps the game unlisted, and link sessions can upgrade to it", async () => {
      const update = await importAs(
        "uploader",
        definition(PRIVATE_KEY, "Private Game v2"),
        "?allowUpdate=true",
      );
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({ status: "updated", listing: "unlisted" });
      expect((await privateGame()).listing).toBe("unlisted");

      const upgrade = await request("outsider", "POST", `/sessions/${linkSessionId}/upgrade-revision`);
      expect(upgrade.statusCode).toBe(200);
      expect(upgrade.json().status).toBe("upgraded");
    });

    test("forks of a link session are granted the game too", async () => {
      const forkLink = await request("outsider", "POST", `/sessions/${linkSessionId}/links`, {
        linkType: "fork",
      });
      expect(forkLink.statusCode).toBe(201);
      const fork = await request("stranger", "POST", `/links/${forkLink.json().token}/redeem`);
      expect(fork.statusCode).toBe(200);
      forkedSessionId = fork.json().sessionId;
      const forked = await prisma.gameSession.findUniqueOrThrow({ where: { id: forkedSessionId } });
      expect(forked.followsGame).toBe(true);
    });

    test("a revoked link stops starting sessions; its sessions keep working", async () => {
      expect(
        (await request("member", "DELETE", `/games/${PRIVATE_KEY}/links/${linkId}`)).statusCode,
      ).toBe(404);
      expect(
        (await request("uploader", "DELETE", `/games/${PRIVATE_KEY}/links/${linkId}`)).statusCode,
      ).toBe(204);

      expect((await request(null, "GET", `/links/${token}`)).json()).toEqual({ valid: false });
      expect((await request("member", "POST", `/links/${token}/redeem`)).statusCode).toBe(404);
      expect((await request("outsider", "GET", `/sessions/${linkSessionId}`)).statusCode).toBe(200);
    });
  });

  describe("listing", () => {
    test("an uploader cannot make their game public", async () => {
      const res = await request("uploader", "PATCH", `/games/${PRIVATE_KEY}`, { listing: "listed" });
      expect(res.statusCode).toBe(403);
    });

    test("making a game public revokes its links and opens it to members", async () => {
      const { token } = (
        await request("uploader", "POST", `/games/${PRIVATE_KEY}/links`, {})
      ).json();

      const res = await request("editor", "PATCH", `/games/${PRIVATE_KEY}`, { listing: "listed" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ listing: "listed", canManage: true });

      expect((await request(null, "GET", `/links/${token}`)).json()).toEqual({ valid: false });
      expect(await gameKeysFor("member")).toContain(PRIVATE_KEY);
      const session = await request("member", "POST", "/sessions", {
        gameId: PRIVATE_KEY,
        name: "Now public",
        visibility: "private",
      });
      expect(session.statusCode).toBe(201);
    });

    test("re-importing never changes a game's listing", async () => {
      const res = await importAs(
        "uploader",
        definition(PRIVATE_KEY, "Private Game v3"),
        "?allowUpdate=true&listing=unlisted",
      );
      expect(res.statusCode).toBe(200);
      expect((await privateGame()).listing).toBe("listed");
    });

    test("sessions granted through a link keep following the game once it is public", async () => {
      // Neither creator is a member of the game's server.
      for (const [name, sessionId] of [
        ["outsider", linkSessionId],
        ["stranger", forkedSessionId],
      ] as const) {
        const res = await request(name, "POST", `/sessions/${sessionId}/upgrade-revision`);
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("upgraded");
      }
    });

    test("a non-member's session without the grant cannot follow a public game", async () => {
      const game = await privateGame();
      const firstRevision = await prisma.gameRevision.findFirstOrThrow({
        where: { gameId: game.id, revision: 1 },
      });
      const session = await prisma.gameSession.create({
        data: {
          gameId: game.id,
          serverId: SERVER,
          creatorId: USERS.stranger.id,
          name: "Fork of a public session",
          visibility: "private",
          gameRevisionId: firstRevision.id,
        },
      });
      const res = await request("stranger", "POST", `/sessions/${session.id}/upgrade-revision`);
      expect(res.statusCode).toBe(403);
    });
  });

  describe("deleting", () => {
    test("owners delete their own games; members can't see unlisted ones", async () => {
      const key = `${KEY_PREFIX}to-delete`;
      expect((await importAs("uploader", definition(key))).statusCode).toBe(201);

      expect((await request("member", "DELETE", `/games/${key}`)).statusCode).toBe(404);
      expect((await request("uploader", "DELETE", `/games/${key}`)).statusCode).toBe(204);
      expect(await prisma.game.findUnique({ where: { gameKey: key } })).toBeNull();
    });
  });
});
