import type { FastifyBaseLogger } from "fastify";
import { type GameListing, Prisma } from "@prisma/client";
import prisma from "./prisma.js";
import {
  assertServerMembership,
  getUserPermissions,
  userPassesDiscordRoleGate,
} from "./permissions.js";
import { VIRTUAL_SERVER_IDS } from "./virtual-servers.js";

type AccessedGame = { serverId: string; listing: GameListing; ownerId: string | null };

/**
 * Whether a user with these permissions on the game's server manages the game:
 * its editors and admins do, and so does its owner while they may still import
 * games there.
 */
export function managesGame(
  perms: ReadonlySet<string>,
  userId: string,
  game: Pick<AccessedGame, "ownerId">,
): boolean {
  if (perms.has("games.edit") || perms.has("server.admin")) return true;
  return (
    game.ownerId === userId &&
    (perms.has("games.create") || perms.has("games.create-unlisted"))
  );
}

export async function canManageGame(
  userId: string,
  game: Pick<AccessedGame, "serverId" | "ownerId">,
  logger?: FastifyBaseLogger,
): Promise<boolean> {
  const perms = await getUserPermissions(userId, game.serverId, true, logger);
  return managesGame(perms, userId, game);
}

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
 * Throws unless the user may use the game: membership of its server (virtual
 * servers have no guild to check) and the role gate of every given revision.
 * An unlisted game is also limited to the people who manage it (404 for
 * everyone else); others start it from a game link. Every way of reaching a
 * game's definitions or pinning a session to one of its revisions goes through
 * this check.
 */
export async function assertGameAccess(
  userId: string,
  game: AccessedGame,
  revisionIds: (string | null | undefined)[],
  logger?: FastifyBaseLogger,
): Promise<void> {
  if (game.listing === "unlisted" && !(await canManageGame(userId, game, logger))) {
    throw Object.assign(new Error("Game not found"), { statusCode: 404 });
  }

  if (!VIRTUAL_SERVER_IDS.has(game.serverId)) {
    await assertServerMembership(userId, game.serverId, logger);
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
