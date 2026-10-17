import type { FastifyBaseLogger } from "fastify";
import { discord } from "./discord-client.js";
import prisma from "./prisma.js";
import { env } from "./env.js";
import { VIRTUAL_SERVER_IDS } from "./virtual-servers.js";
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
  const adminIds = env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.includes(userId)) {
    return new Set(["games.create", "games.edit", "games.delete", "server.admin"]);
  }
  // Virtual servers have no Discord guild to look roles up in.
  if (VIRTUAL_SERVER_IDS.has(serverId)) return new Set();

  const roleIds = await getUserRoleIds(userId, serverId, privileged, logger);
  if (roleIds.length === 0) return new Set();

  const rows = await prisma.rolePermission.findMany({
    where: { serverId, discordRoleId: { in: roleIds } },
    select: { permission: true },
  });

  return new Set(rows.map((r) => r.permission));
}

// Whether the user holds any of `permissions` on at least one server.
export async function hasPermissionOnSomeServer(
  userId: string,
  permissions: string[],
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  const adminIds = env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.includes(userId)) {
    return true;
  }

  // Others only get permissions through role mappings, on servers they are in.
  // Only servers the user is cached as a member of are checked (GET /servers
  // caches every server), and their roles are refreshed as for any
  // permission-gated request.
  const memberships = await prisma.serverMembershipCache.findMany({
    where: {
      userId,
      isMember: true,
      server: { rolePermissions: { some: { permission: { in: permissions } } } },
    },
    select: { serverId: true },
  });

  for (const { serverId } of memberships) {
    try {
      const perms = await getUserPermissions(userId, serverId, true, logger);
      if (permissions.some((permission) => perms.has(permission))) return true;
    } catch (error) {
      logger?.warn({ serverId, userId, err: error }, "Could not check permissions on a server");
    }
  }
  return false;
}

export async function userPassesDiscordRoleGate(
  userId: string,
  guildId: string,
  roleId: string,
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  const adminIds = env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.includes(userId)) {
    return true;
  }

  // Visibility is permission-gated, so use the short (privileged) TTL — role
  // changes propagate within ~1 minute.
  let roles: string[];
  try {
    roles = await getUserRoleIds(userId, guildId, true, logger);
  } catch (error) {
    // Fail closed for this game without taking down the whole public catalog.
    logger?.warn({ guildId, userId, err: error }, "Could not verify game visibility role");
    return false;
  }
  const passed = roles.includes(roleId);
  logger?.info(
    { userId, guildId, roleId, passed },
    `[searchlight:game-gate] ${passed ? "pass" : "deny"} role ${roleId} in ${guildId}`,
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
  return (await fetchAndCacheMembership(userId, serverId, logger)).roles;
}

// Non-members are cached too (no roles, isMember false), so permission lookups
// for every listed server don't hit Discord on each request.
async function fetchAndCacheMembership(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<{ isMember: boolean; roles: string[] }> {
  const member = await discord.getGuildMember(serverId, userId, logger);
  const membership = { isMember: member !== null, roles: member?.roles ?? [] };

  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { ...membership, cachedAt: new Date() },
    create: { userId, serverId, ...membership, cachedAt: new Date() },
  });

  return membership;
}

export async function assertServerMembership(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  const adminIds = env.ADMIN_DISCORD_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (adminIds.includes(userId)) {
    return;
  }

  // Membership is cached like roles for normal reads, but a cached "not a
  // member" expires after PRIVILEGED_TTL_MS so someone who just joined the
  // server isn't locked out for an hour.
  const cached = await prisma.serverMembershipCache.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  const ttl = cached?.isMember ? DEFAULT_TTL_MS : PRIVILEGED_TTL_MS;
  const isMember =
    cached && Date.now() - cached.cachedAt.getTime() < ttl
      ? cached.isMember
      : (await fetchAndCacheMembership(userId, serverId, logger)).isMember;
  if (!isMember) {
    throw Object.assign(new Error("Not a member of this server"), { statusCode: 403 });
  }
}
