import type { FastifyBaseLogger } from "fastify";
import { discord } from "./discord-client.js";
import prisma from "./prisma.js";
import type { GameVisibilityGate } from "./game-gates.js";

// Discord roles are cached per (user, server). Normal reads tolerate a stale
// cache for up to DEFAULT_TTL_MS. Permission-gated requests (`privileged`) use
// the much shorter PRIVILEGED_TTL_MS so role/permission changes take effect
// within ~1 minute, without forcing a Discord call on every such request.
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRIVILEGED_TTL_MS = 60 * 1000; // 1 minute

export async function getUserPermissions(
  userId: string,
  serverId: string,
  privileged = false,
  logger?: FastifyBaseLogger,
): Promise<Set<string>> {
  const roleIds = await getUserRoleIds(userId, serverId, privileged, logger);

  if (roleIds.length === 0) return new Set();

  const rows = await prisma.rolePermission.findMany({
    where: { serverId, discordRoleId: { in: roleIds } },
    select: { permission: true },
  });

  return new Set(rows.map((r) => r.permission));
}

// TEMPORARY (see game-gates.ts): returns true if the user holds the gate's
// required role in the gate's guild. Delete when the invite system lands.
export async function userPassesGameGate(
  userId: string,
  gate: GameVisibilityGate,
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  // Visibility is permission-gated, so use the short (privileged) TTL — role
  // changes propagate within ~1 minute.
  const roles = await getUserRoleIds(userId, gate.requireGuildId, true, logger);
  const passed = roles.includes(gate.requireRoleId);
  logger?.info(
    { userId, sentinel: gate.sentinelValue, passed },
    `[taibled:game-gate] ${passed ? "pass" : "deny"} ${gate.sentinelValue}`,
  );
  return passed;
}

export async function getUserRoleIds(
  userId: string,
  serverId: string,
  privileged: boolean,
  logger?: FastifyBaseLogger,
): Promise<string[]> {
  const ttl = privileged ? PRIVILEGED_TTL_MS : DEFAULT_TTL_MS;
  const cached = await prisma.serverMembershipCache.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  if (cached && Date.now() - cached.cachedAt.getTime() < ttl) {
    return cached.roles;
  }
  return fetchAndCacheRoles(userId, serverId, logger);
}

async function fetchAndCacheRoles(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<string[]> {
  const member = await discord.getGuildMember(serverId, userId, logger);
  const roles = member?.roles ?? [];

  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { roles, cachedAt: new Date() },
    create: { userId, serverId, roles, cachedAt: new Date() },
  });

  return roles;
}
