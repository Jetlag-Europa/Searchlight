import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameMapPng, gameMapSvg } from "../lib/og-map.js";
import { ogRoutes } from "./og.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const USER_ID = "test-og-user";
const SERVER_ID = "test-og-server";
const GAME_ID = "test-og-game";
const EMPTY_GAME_ID = "test-og-empty";
const GAMES = [GAME_ID, EMPTY_GAME_ID];
const TOKEN = "0123456789abcdef0123456789abcdef";
const REVOKED_TOKEN = "fedcba9876543210fedcba9876543210";
const EMPTY_TOKEN = "00000000000000000000000000000000";

const square = (west: number, south: number, east: number, north: number) => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];

const definition = {
  id: GAME_ID,
  name: "Test <Game> & Co",
  serverId: SERVER_ID,
  map: {
    center: [4.4, 50.85],
    playArea: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [square(4.2, 50.7, 4.6, 51.0), square(4.35, 50.8, 4.45, 50.9)],
          },
        },
      ],
    },
  },
  hidingZones: {
    features: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [4.3, 50.75] } },
        { type: "Feature", geometry: { type: "Point", coordinates: [4.5, 50.95] } },
        { type: "Feature", geometry: { type: "Polygon", coordinates: [square(4.25, 50.72, 4.3, 50.76)] } },
      ],
    },
  },
};

async function cleanup() {
  await prisma.gameLink.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.updateMany({ where: { id: { in: GAMES } }, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { gameId: { in: GAMES } } });
  await prisma.game.deleteMany({ where: { id: { in: GAMES } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: USER_ID } });
}

async function publishRevision(gameId: string, def: object) {
  const rev = await prisma.gameRevision.create({
    data: { gameId, revision: 1, checksum: `${gameId}-r1`, definition: def },
  });
  await prisma.game.update({ where: { id: gameId }, data: { currentRevisionId: rev.id } });
  return rev;
}

const meta = (html: string, key: string) =>
  html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)" />`))?.[1];

describe("link previews", () => {
  let app: FastifyInstance;
  let revisionId: string;

  beforeAll(async () => {
    await cleanup();
    app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(ogRoutes, { prefix: "/og" });
    await app.ready();

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: USER_ID,
        displayName: USER_ID,
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.server.create({ data: { id: SERVER_ID, name: "OG Server" } });
    await prisma.game.createMany({
      data: [
        { id: GAME_ID, gameKey: GAME_ID, serverId: SERVER_ID, name: definition.name },
        { id: EMPTY_GAME_ID, gameKey: EMPTY_GAME_ID, serverId: SERVER_ID, name: "Empty" },
      ],
    });
    revisionId = (await publishRevision(GAME_ID, definition)).id;
    await publishRevision(EMPTY_GAME_ID, { id: EMPTY_GAME_ID, name: "Empty", serverId: SERVER_ID });
    await prisma.gameLink.createMany({
      data: [
        { token: TOKEN, gameId: GAME_ID, createdById: USER_ID },
        { token: REVOKED_TOKEN, gameId: GAME_ID, createdById: USER_ID, revokedAt: new Date() },
        { token: EMPTY_TOKEN, gameId: EMPTY_GAME_ID, createdById: USER_ID },
      ],
    });
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
  });

  test("a game link's page names the game and points at its map", async () => {
    const res = await app.inject({ method: "GET", url: `/og/play?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["x-robots-tag"]).toBe("noindex");

    const html = res.body;
    expect(html).toContain("<title>Test &lt;Game&gt; &amp; Co</title>");
    expect(meta(html, "og:title")).toBe("Test &lt;Game&gt; &amp; Co");
    expect(meta(html, "og:description")).toContain("OG Server");
    expect(meta(html, "og:url")).toBe(`http://localhost/play?token=${TOKEN}`);
    expect(meta(html, "og:image")).toBe(
      `http://localhost/og/game-links/${TOKEN}/map.png?v=${revisionId}`,
    );
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
  });

  test.each([
    ["a revoked link", `?token=${REVOKED_TOKEN}`],
    ["an unknown link", "?token=nope"],
    ["no token", ""],
  ])("%s gets a page that says so, with no image", async (_, query) => {
    const res = await app.inject({ method: "GET", url: `/og/play${query}` });
    expect(res.statusCode).toBe(200);
    expect(meta(res.body, "og:title")).toBe("Link no longer active");
    expect(meta(res.body, "og:image")).toBeUndefined();
    expect(meta(res.body, "twitter:card")).toBe("summary");
  });

  test("the token is escaped where the page repeats it", async () => {
    const res = await app.inject({ method: "GET", url: `/og/play?token=${encodeURIComponent('"><script>')}` });
    expect(res.body).not.toContain("<script>");
    expect(meta(res.body, "og:url")).toBe("http://localhost/play?token=%22%3E%3Cscript%3E");
  });

  test("the map is a 1200×630 PNG", async () => {
    const res = await app.inject({ method: "GET", url: `/og/game-links/${TOKEN}/map.png?v=${revisionId}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    const png = res.rawPayload;
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  test("there is no map for a revoked link or a game without a play area", async () => {
    for (const token of [REVOKED_TOKEN, "nope", EMPTY_TOKEN]) {
      const res = await app.inject({ method: "GET", url: `/og/game-links/${token}/map.png` });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("gameMapSvg", () => {
  test("draws the play area with its hole, the zone areas and the stations", () => {
    const svg = gameMapSvg(definition)!;
    const paths = svg.match(/<path d="[^"]*"/g) ?? [];
    expect(paths).toHaveLength(2);
    // The play area's outline and its hole, in one path.
    expect(paths[0]!.match(/M/g)).toHaveLength(2);
    expect(svg.match(/<circle /g)).toHaveLength(2);
  });

  test("fits the play area inside the image", () => {
    const svg = gameMapSvg(definition)!;
    const numbers = [...svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
    for (const [x, y] of numbers) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1200);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(630);
    }
  });

  test("returns null without a play area", () => {
    expect(gameMapSvg({ name: "x" })).toBeNull();
    expect(gameMapSvg({ map: { playArea: { features: [] } } })).toBeNull();
    expect(gameMapSvg(null)).toBeNull();
  });
});

describe("gameMapPng", () => {
  test("renders a revision once, and again after a failure", async () => {
    const load = vi.fn(async () => definition);
    const first = await gameMapPng("test-og-cache", load);
    expect(await gameMapPng("test-og-cache", load)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(definition);
    await expect(gameMapPng("test-og-retry", failing)).rejects.toThrow("db down");
    expect(await gameMapPng("test-og-retry", failing)).toBeInstanceOf(Buffer);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
