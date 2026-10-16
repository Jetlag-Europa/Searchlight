import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "@prisma/client";
import prisma from "./prisma.js";
import { assertServerMembership, getUserPermissions, userPassesDiscordRoleGate } from "./permissions.js";
import { VIRTUAL_SERVER_IDS } from "./virtual-servers.js";

// Routes address a game by id or gameKey. Ids are generated here but gameKeys
// are chosen by importers, so a gameKey can equal another game's id: match the
// id first, so an import can't capture lookups of an existing game.
export async function findGameByIdOrKey<I extends Prisma.GameInclude = {}>(
  idOrKey: string,
  include?: I,
): Promise<Prisma.GameGetPayload<{ include: I }> | null> {
  const game =
    (await prisma.game.findUnique({ where: { id: idOrKey }, include })) ??
    (await prisma.game.findUnique({ where: { gameKey: idOrKey }, include }));
  return game as Prisma.GameGetPayload<{ include: I }> | null;
}

// Any of these on a game's server lets a user see and use its unlisted games,
// change its listing and manage its links.
const GAME_MANAGER_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];

export function canManageGames(permissions: ReadonlySet<string>): boolean {
  return GAME_MANAGER_PERMISSIONS.some((p) => permissions.has(p));
}

/** Throws 403 unless the user may change the game's listing and links. */
export async function assertCanManageGame(
  userId: string,
  game: { serverId: string },
  logger?: FastifyBaseLogger,
): Promise<void> {
  const perms = await getUserPermissions(userId, game.serverId, true, logger);
  if (!canManageGames(perms)) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

function getDiscordRoleGate(visibility: unknown): { guildId: string; roleId: string } | null {
  if (typeof visibility !== "object" || visibility === null) return null;
  const visObj = visibility as Record<string, unknown>;
  if (
    visObj.kind === "discord-role" &&
    typeof visObj.guildId === "string" &&
    typeof visObj.roleId === "string"
  ) {
    return { guildId: visObj.guildId, roleId: visObj.roleId };
  }
  return null;
}

// Access checks only need each definition's `visibility`. Definitions embed
// multi-MB GeoJSON, so read just that field instead of the whole document.
async function revisionVisibilities(revisionIds: (string | null | undefined)[]): Promise<unknown[]> {
  const ids = [...new Set(revisionIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const rows = await prisma.$queryRaw<{ visibility: unknown }[]>`
    SELECT definition->'visibility' AS visibility
    FROM "GameRevision"
    WHERE id IN (${Prisma.join(ids)})
  `;
  return rows.map((row) => row.visibility);
}

/**
 * Throws 403 unless the user may use the game: membership of its server
 * (virtual servers have no guild to check), game management permissions if
 * the game is unlisted, and the role gate of every given revision. Every way
 * of reaching a game's definitions or pinning a session to one of its
 * revisions goes through this check. Exceptions: a session's participants may
 * read the revision it is pinned to, forks copy their source's revision, and
 * a game link stands in for this check (see game-links.ts).
 */
export async function assertGameAccess(
  userId: string,
  game: { serverId: string; unlisted: boolean },
  revisionIds: (string | null | undefined)[],
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (!VIRTUAL_SERVER_IDS.has(game.serverId)) {
    await assertServerMembership(userId, game.serverId, logger);
  }

  if (game.unlisted) {
    const perms = await getUserPermissions(userId, game.serverId, true, logger);
    if (!canManageGames(perms)) {
      throw Object.assign(new Error("This game is unlisted"), { statusCode: 403 });
    }
  }

  for (const visibility of await revisionVisibilities(revisionIds)) {
    const gate = getDiscordRoleGate(visibility);
    if (gate) {
      const passes = await userPassesDiscordRoleGate(userId, gate.guildId, gate.roleId, logger);
      if (!passes) {
        throw Object.assign(new Error("Forbidden by role gate"), { statusCode: 403 });
      }
    }
  }
}
