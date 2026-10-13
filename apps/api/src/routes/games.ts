import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, userPassesDiscordRoleGate, assertServerMembership } from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { findGameByIdOrKey } from "../lib/game-access.js";

const gameShape = Type.Object({
  id: Type.String(),
  gameKey: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  size: Type.String(),
  currentRevisionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  archivedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});


export async function gameRoutes(app: FastifyInstance) {
  // GET /games?serverId= — list games for a server (must be a guild member)
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({ serverId: Type.String({ minLength: 1 }) }),
        response: {
          200: Type.Object({ games: Type.Array(gameShape) }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.query as { serverId: string };

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      // Virtual servers (e.g. Home Games) have no Discord guild — skip the
      // membership check; their games are gated individually below.
      if (!VIRTUAL_SERVER_IDS.has(serverId)) {
        await assertServerMembership(user.discordId, serverId, req.log);
      }

      const games = await prisma.game.findMany({
        where: { serverId },
        orderBy: { name: "asc" },
      });

      // Only `visibility` is needed here; loading every multi-MB definition
      // made listing a server's games pull its whole game catalogue.
      const revisionIds = games
        .map((game) => game.currentRevisionId)
        .filter((id): id is string => Boolean(id));
      const visibilityByRevision = new Map<string, any>();
      if (revisionIds.length > 0) {
        const rows = await prisma.$queryRaw<{ id: string; visibility: any }[]>`
          SELECT id, definition->'visibility' AS visibility
          FROM "GameRevision"
          WHERE id IN (${Prisma.join(revisionIds)})
        `;
        for (const row of rows) visibilityByRevision.set(row.id, row.visibility);
      }

      const visible = [];
      for (const game of games) {
        const visibility = game.currentRevisionId
          ? visibilityByRevision.get(game.currentRevisionId)
          : undefined;
        if (visibility?.kind === "discord-role") {
          const passes = await userPassesDiscordRoleGate(
            user.discordId,
            visibility.guildId,
            visibility.roleId,
            req.log,
          );
          if (!passes) {
            continue;
          }
        }
        visible.push(game);
      }
      return { games: visible };
    },
  );

  // DELETE /games/:gameId — delete a game (requires games.delete in the game's server)
  app.delete(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };

      const game = await findGameByIdOrKey(gameId);
      if (!game) throw Object.assign(new Error("Game not found"), { statusCode: 404 });

      const perms = await getUserPermissions(
        user.discordId,
        game.serverId,
        true,
        req.log,
      );
      if (!perms.has("games.delete")) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }

      const sessionCount = await prisma.gameSession.count({ where: { gameId: game.id } });
      if (sessionCount > 0) {
        throw Object.assign(
          new Error("Cannot delete a game that has sessions. Delete all sessions first."),
          { statusCode: 409 },
        );
      }

      await prisma.game.delete({ where: { id: game.id } });
      return reply.status(204).send();
    },
  );
}
