import type { FastifyBaseLogger } from "fastify";
import { discord } from "./discord-client.js";
import prisma from "./prisma.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getUserPermissions(
  userId: string,
  serverId: string,
  accessToken: string,
  forceRefresh = false,
  logger?: FastifyBaseLogger,
): Promise<Set<string>> {
  const roleIds = await resolveRoleIds(userId, serverId, accessToken, forceRefresh, logger);

  if (roleIds.length === 0) return new Set();

  const rows = await prisma.rolePermission.findMany({
    where: { serverId, discordRoleId: { in: roleIds } },
    select: { permission: true },
  });

  return new Set(rows.map((r) => r.permission));
}

async function resolveRoleIds(
  userId: string,
  serverId: string,
  accessToken: string,
  forceRefresh: boolean,
  logger?: FastifyBaseLogger,
): Promise<string[]> {
  if (!forceRefresh) {
    const cached = await prisma.serverMembershipCache.findUnique({
      where: { userId_serverId: { userId, serverId } },
    });
    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      return cached.roles;
    }
  }
  return fetchAndCacheRoles(userId, serverId, accessToken, logger);
}

async function fetchAndCacheRoles(
  userId: string,
  serverId: string,
  accessToken: string,
  logger?: FastifyBaseLogger,
): Promise<string[]> {
  const member = await discord.getGuildMember(serverId, accessToken, logger);
  const roles = member?.roles ?? [];

  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { roles, cachedAt: new Date() },
    create: { userId, serverId, roles, cachedAt: new Date() },
  });

  return roles;
}
