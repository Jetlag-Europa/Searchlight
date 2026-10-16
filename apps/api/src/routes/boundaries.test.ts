import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../lib/overpass.js", () => ({
  overpassFetch: vi.fn(),
}));
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { overpassFetch } from "../lib/overpass.js";
import { boundaryRoutes } from "./boundaries.js";

const mockOverpassFetch = overpassFetch as unknown as ReturnType<typeof vi.fn>;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-boundaries-route-user";
const AUTH_SESSION_ID = "test-boundaries-route-auth";
// Far above any real OSM id so these rows can't collide with real cache entries.
const OSM_ID = "9999999990001";
const EMPTY_OSM_ID = "9999999990002";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(boundaryRoutes, { prefix: "/boundaries" });
  await app.ready();
  return app;
}

function overpassResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function deleteCacheRows() {
  await prisma.boundaryCache.deleteMany({ where: { osmId: { in: [OSM_ID, EMPTY_OSM_ID] } } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("GET /boundaries/:osmType/:osmId", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let cookie: string;

  beforeAll(async () => {
    await deleteCacheRows();
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });

    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "testuser-boundaries",
        displayName: "Test Boundaries User",
        avatarUrl: "https://example.com/avatar.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.authSession.create({
      data: {
        id: AUTH_SESSION_ID,
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    app = await buildTestApp();
    cookie = `session=${app.signCookie(AUTH_SESSION_ID)}`;
  });

  afterAll(async () => {
    await deleteCacheRows();
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await app.close();
  });

  beforeEach(() => {
    mockOverpassFetch.mockReset();
  });

  function get(osmType: string, osmId: string) {
    return app.inject({
      method: "GET",
      url: `/boundaries/${osmType}/${encodeURIComponent(osmId)}`,
      headers: { cookie },
    });
  }

  test.each([
    ["an Overpass QL injection", "1);node(45,5,48,11);out geom;("],
    ["a non-numeric id", "abc"],
    ["a leading zero", "01"],
    ["zero", "0"],
    ["a negative id", "-1"],
    ["a trailing newline", "1\n"],
    ["an id longer than 16 digits", "12345678901234567"],
  ])("rejects %s with 400 before querying Overpass", async (_label, osmId) => {
    const res = await get("R", osmId);

    expect(res.statusCode).toBe(400);
    expect(mockOverpassFetch).not.toHaveBeenCalled();
  });

  test("a valid id queries Overpass for that object and caches the result", async () => {
    const body = { elements: [{ type: "relation", id: Number(OSM_ID), members: [] }] };
    mockOverpassFetch.mockResolvedValueOnce(overpassResponse(body));

    const res = await get("R", OSM_ID);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(mockOverpassFetch).toHaveBeenCalledOnce();
    expect(mockOverpassFetch).toHaveBeenCalledWith(`[out:json];relation(${OSM_ID});out geom;`);

    // Second request is served from the cache.
    const again = await get("R", OSM_ID);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(body);
    expect(mockOverpassFetch).toHaveBeenCalledOnce();
  });

  test("an empty Overpass result is returned but not cached", async () => {
    mockOverpassFetch.mockResolvedValueOnce(overpassResponse({ elements: [] }));

    const res = await get("W", EMPTY_OSM_ID);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ elements: [] });
    expect(mockOverpassFetch).toHaveBeenCalledWith(`[out:json];way(${EMPTY_OSM_ID});out geom;`);
    const row = await prisma.boundaryCache.findUnique({
      where: { osmId_osmType: { osmId: EMPTY_OSM_ID, osmType: "W" } },
    });
    expect(row).toBeNull();
  });
});
