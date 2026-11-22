import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { UsageResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { usageRoutes } from "./usage.js";

const ADMIN_ID = "test-usage-admin";
const USER_ID = "test-usage-user";
const USERS = [ADMIN_ID, USER_ID];
const DAY = 86_400_000;
// The test's own day, so the counts already in the database stay.
const OLD_DAY = new Date("2000-01-01");

async function cleanup() {
  await prisma.usageCount.deleteMany({ where: { day: OLD_DAY } });
  await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

describe("/usage", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const previousAdmins = env.ADMIN_DISCORD_IDS;

  beforeAll(async () => {
    await cleanup();
    env.ADMIN_DISCORD_IDS = ADMIN_ID;
    app = Fastify({ logger: false });
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(usageRoutes, { prefix: "/usage" });
    await app.ready();

    for (const discordId of USERS) {
      await prisma.user.create({
        data: {
          discordId,
          username: discordId,
          displayName: discordId,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + DAY),
          sessions: { create: { id: `${discordId}-auth`, expiresAt: new Date(Date.now() + DAY) } },
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

  const count = (event: string) =>
    app.inject({ method: "POST", url: "/usage", payload: { event } });
  const read = async () => {
    const res = await app.inject({ url: "/usage", headers: { cookie: cookies[ADMIN_ID] } });
    expect(res.statusCode).toBe(200);
    const { counts } = res.json() as UsageResponse;
    return counts.find((c) => c.event === "creator:opened") ?? { last7d: 0, last30d: 0, total: 0 };
  };

  test("counts known events per day without a login", async () => {
    const before = await read();
    expect((await count("creator:opened")).statusCode).toBe(204);
    expect((await count("creator:opened")).statusCode).toBe(204);
    // Days before the last 30 count toward the total only.
    await prisma.usageCount.create({ data: { day: OLD_DAY, event: "creator:opened", count: 5 } });

    expect(await read()).toEqual({
      event: "creator:opened",
      last7d: before.last7d + 2,
      last30d: before.last30d + 2,
      total: before.total + 7,
    });
  });

  test("rejects unknown events", async () => {
    expect((await count("anything-else")).statusCode).toBe(400);
  });

  test("only global admins read the counts", async () => {
    const res = await app.inject({ url: "/usage", headers: { cookie: cookies[USER_ID] } });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ url: "/usage" })).statusCode).toBe(401);
  });
});
