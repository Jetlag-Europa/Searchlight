import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { usageRoutes } from "./usage.js";

const ADMIN_ID = "test-usage-admin";
const USER_ID = "test-usage-user";
const USERS = [ADMIN_ID, USER_ID];
const DAY = 86_400_000;

async function cleanup() {
  await prisma.usageCount.deleteMany();
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
    app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
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
        },
      });
      const auth = await prisma.authSession.create({
        data: { id: `${discordId}-auth`, userId: discordId, expiresAt: new Date(Date.now() + DAY) },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }
  });

  afterAll(async () => {
    env.ADMIN_DISCORD_IDS = previousAdmins;
    await app.close();
    await cleanup();
  });

  const count = (event: string) =>
    app.inject({ method: "POST", url: "/usage", payload: { event } });

  test("counts known events per day without a login", async () => {
    expect((await count("creator:opened")).statusCode).toBe(204);
    expect((await count("creator:opened")).statusCode).toBe(204);
    expect((await count("local-session:file")).statusCode).toBe(204);
    // Days before the last 30 count toward the total only.
    await prisma.usageCount.create({
      data: { day: new Date(Date.now() - 40 * DAY), event: "creator:opened", count: 5 },
    });

    const res = await app.inject({ url: "/usage", headers: { cookie: cookies[ADMIN_ID] } });
    expect(res.statusCode).toBe(200);
    const counts = res.json().counts as { event: string }[];
    expect(counts.sort((a, b) => a.event.localeCompare(b.event))).toEqual([
      { event: "creator:opened", last7d: 2, last30d: 2, total: 7 },
      { event: "local-session:file", last7d: 1, last30d: 1, total: 1 },
    ]);
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
