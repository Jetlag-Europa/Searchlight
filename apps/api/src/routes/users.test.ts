import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../lib/discord-client.js", () => ({
  discord: {
    getGuildMember: vi.fn().mockResolvedValue(null),
  },
}));
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { userRoutes } from "./users.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SERVER_ID = "test-users-search-server";
// All names contain QUERY, so only membership decides who is found.
const QUERY = "searchtarget";
const CALLER = "test-users-search-caller";
const MEMBER = "test-users-search-member";
const FORMER_MEMBER = "test-users-search-former";
const OUTSIDER = "test-users-search-outsider";
const USERS = [CALLER, MEMBER, FORMER_MEMBER, OUTSIDER];
const AUTH_CALLER = "test-users-search-auth-caller";
const AUTH_OUTSIDER = "test-users-search-auth-outsider";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(userRoutes, { prefix: "/users" });
  await app.ready();
  return app;
}

function signedCookie(app: Awaited<ReturnType<typeof buildTestApp>>, value: string) {
  return `session=${app.signCookie(value)}`;
}

async function cleanup() {
  await prisma.serverMembershipCache.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("GET /users/search", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    await cleanup();
    await prisma.server.create({ data: { id: SERVER_ID, name: "Users Search Server" } });
    await prisma.user.createMany({
      data: USERS.map((discordId) => ({
        discordId,
        username: `${QUERY}-${discordId}`,
        displayName: `${QUERY} ${discordId}`,
        avatarUrl: "https://example.com/avatar.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await prisma.authSession.createMany({
      data: [
        { id: AUTH_CALLER, userId: CALLER, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH_OUTSIDER, userId: OUTSIDER, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });
    // FORMER_MEMBER and OUTSIDER were looked up and found not to be in the server.
    await prisma.serverMembershipCache.createMany({
      data: [
        { userId: CALLER, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
        { userId: MEMBER, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
        { userId: FORMER_MEMBER, serverId: SERVER_ID, isMember: false, roles: [], cachedAt: new Date() },
        { userId: OUTSIDER, serverId: SERVER_ID, isMember: false, roles: [], cachedAt: new Date() },
      ],
    });
    app = await buildTestApp();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  test("finds the server's members only", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/users/search?serverId=${SERVER_ID}&q=${QUERY}`,
      headers: { cookie: signedCookie(app, AUTH_CALLER) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((u: { discordId: string }) => u.discordId)).toEqual([MEMBER]);
  });

  test("returns 403 to a caller who isn't in the server", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/users/search?serverId=${SERVER_ID}&q=${QUERY}`,
      headers: { cookie: signedCookie(app, AUTH_OUTSIDER) },
    });
    expect(res.statusCode).toBe(403);
  });

  test("returns 404 for an unknown server", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/users/search?serverId=test-users-search-unknown&q=${QUERY}`,
      headers: { cookie: signedCookie(app, AUTH_CALLER) },
    });
    expect(res.statusCode).toBe(404);
  });
});
