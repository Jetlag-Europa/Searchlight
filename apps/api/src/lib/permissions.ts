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

// locations.view: see Google Maps live locations in the server's sessions (tracker stack).
const ALL_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin", "locations.view"];

function isAdmin(userId: string): boolean {
  return env.ADMIN_DISCORD_IDS.split(",").some((id) => id.trim() === userId);
}

export async function getUserPermissions(
  userId: string,
  serverId: string,
  privileged = false,
  logger?: FastifyBaseLogger,
): Promise<Set<string>> {
  if (isAdmin(userId)) {
    return new Set(ALL_PERMISSIONS);
  }
  // Virtual servers have no Discord guild to look roles up in.
  if (VIRTUAL_SERVER_IDS.has(serverId)) return new Set();

  return permissionsForRoles(serverId, await getUserRoleIds(userId, serverId, privileged, logger));
}

async function permissionsForRoles(serverId: string, roleIds: string[]): Promise<Set<string>> {
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
  if (isAdmin(userId)) {
    return true;
  }

  // Others only get permissions through role mappings, on servers they are in.
  // Only servers with a cached membership are checked (GET /servers caches
  // every server): the user's, and those where a "not a member" has expired
  // as in assertServerMembership, so someone who just joined isn't refused
  // for an hour. Roles are refreshed as for any permission-gated request.
  const memberships = await prisma.serverMembershipCache.findMany({
    where: {
      userId,
      OR: [{ isMember: true }, { cachedAt: { lt: new Date(Date.now() - PRIVILEGED_TTL_MS) } }],
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
  if (isAdmin(userId)) {
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

interface Membership {
  isMember: boolean;
  roles: string[];
}

// Lookups of the same membership that overlap share one Discord call: a page
// load asks several routes about the same user and server at once.
const pendingLookups = new Map<string, Promise<Membership>>();

// Non-members are cached too (no roles, isMember false), so permission lookups
// for every listed server don't hit Discord on each request.
function fetchAndCacheMembership(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<Membership> {
  const key = `${userId}:${serverId}`;
  let pending = pendingLookups.get(key);
  if (!pending) {
    pending = lookUpAndCacheMembership(userId, serverId, logger).finally(() => pendingLookups.delete(key));
    pendingLookups.set(key, pending);
  }
  return pending;
}

async function lookUpAndCacheMembership(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<Membership> {
  const member = await discord.getGuildMember(serverId, userId, logger);
  const membership = { isMember: member !== null, roles: member?.roles ?? [] };

  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { ...membership, cachedAt: new Date() },
    create: { userId, serverId, ...membership, cachedAt: new Date() },
  });

  return membership;
}

export async function isServerMember(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  if (isAdmin(userId)) {
    return true;
  }

  // Membership is cached like roles for normal reads, but a cached "not a
  // member" expires after a minute so someone who just joined the server
  // isn't locked out for an hour.
  const cached = await prisma.serverMembershipCache.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  const ttl = cached?.isMember ? DEFAULT_TTL_MS : PRIVILEGED_TTL_MS;
  return cached && Date.now() - cached.cachedAt.getTime() < ttl
    ? cached.isMember
    : (await fetchAndCacheMembership(userId, serverId, logger)).isMember;
}

// Listing servers asks about every server, and most users are in only a few,
// so it re-checks a cached "not a member" rarely. GET /servers?recheck=true
// re-checks them sooner for someone who just joined a server.
const LISTING_NON_MEMBER_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Membership and permissions for GET /servers. The listing only decides what
 * to show (the routes behind it check access again), so it answers from the
 * cache whenever there is an entry and refreshes an expired one in the
 * background: it waits on Discord only for a server it has never checked.
 * With `recheck`, it waits for a fresh answer for each "not a member" cached
 * over a minute ago.
 */
export async function getListingAccess(
  userId: string,
  serverId: string,
  recheck: boolean,
  logger?: FastifyBaseLogger,
): Promise<{ isMember: boolean; permissions: Set<string> }> {
  if (isAdmin(userId)) return { isMember: true, permissions: new Set(ALL_PERMISSIONS) };
  if (VIRTUAL_SERVER_IDS.has(serverId)) return { isMember: true, permissions: new Set() };

  const { isMember, roles } = await getListingMembership(userId, serverId, recheck, logger);
  return { isMember, permissions: isMember ? await permissionsForRoles(serverId, roles) : new Set() };
}

async function getListingMembership(
  userId: string,
  serverId: string,
  recheck: boolean,
  logger?: FastifyBaseLogger,
): Promise<Membership> {
  const cached = await prisma.serverMembershipCache.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  if (!cached) return fetchAndCacheMembership(userId, serverId, logger);

  const age = Date.now() - cached.cachedAt.getTime();
  if (recheck && !cached.isMember && age >= PRIVILEGED_TTL_MS) {
    return fetchAndCacheMembership(userId, serverId, logger);
  }
  if (age >= (cached.isMember ? DEFAULT_TTL_MS : LISTING_NON_MEMBER_TTL_MS)) {
    fetchAndCacheMembership(userId, serverId, logger).catch((err: unknown) => {
      logger?.warn({ userId, serverId, err }, "Could not refresh a cached server membership");
    });
  }
  return { isMember: cached.isMember, roles: cached.roles };
}

export async function assertServerMembership(
  userId: string,
  serverId: string,
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (!(await isServerMember(userId, serverId, logger))) {
    throw Object.assign(new Error("Not a member of this server"), { statusCode: 403 });
  }
}
