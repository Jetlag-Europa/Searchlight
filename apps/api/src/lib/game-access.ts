import type { FastifyBaseLogger } from "fastify";
import { Prisma } from "@prisma/client";
import prisma from "./prisma.js";
import { assertServerMembership, userPassesDiscordRoleGate } from "./permissions.js";
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
 * (virtual servers have no guild to check) and the role gate of every given
 * revision. Every way of reaching a game's definitions or pinning a session to
 * one of its revisions goes through this check.
 */
export async function assertGameAccess(
  userId: string,
  game: { serverId: string },
  revisionIds: (string | null | undefined)[],
  logger?: FastifyBaseLogger,
): Promise<void> {
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
