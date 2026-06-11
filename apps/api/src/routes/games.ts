import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, userPassesGameGate } from "../lib/permissions.js";
import { requirePermission } from "../lib/require-permission.js";
import { discord } from "../lib/discord-client.js";
import { VIRTUAL_SERVER_IDS, gateForSentinel } from "../lib/game-gates.js";

const gameShape = Type.Object({
  id: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  sentinelValue: Type.String(),
  kmlPath: Type.String(),
  mapLocationJson: Type.Unknown(),
  hidingRadius: Type.Number(),
  hidingRadiusUnits: Type.String(),
  tierRadiusOverrides: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Number()), Type.Null()])),
  size: Type.String(),
  hidingZoneGeoJsonPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

async function assertServerMembership(
  userId: string,
  serverId: string,
  logger: import("fastify").FastifyBaseLogger,
): Promise<void> {
  const cached = await prisma.serverMembershipCache.findUnique({
    where: { userId_serverId: { userId, serverId } },
  });
  if (cached) return; // any cache entry (even empty roles) means we fetched membership

  const member = await discord.getGuildMember(serverId, userId, logger);
  if (!member) {
    throw Object.assign(new Error("Not a member of this server"), { statusCode: 403 });
  }
  // Cache the result so subsequent calls are fast
  await prisma.serverMembershipCache.upsert({
    where: { userId_serverId: { userId, serverId } },
    update: { roles: member.roles, cachedAt: new Date() },
    create: { userId, serverId, roles: member.roles, cachedAt: new Date() },
  });
}

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

      // TEMPORARY per-game visibility gate (see lib/game-gates.ts): drop any
      // gated game the user isn't allowed to see.
      const visible = [];
      for (const game of games) {
        const gate = gateForSentinel(game.sentinelValue);
        if (gate && !(await userPassesGameGate(user.discordId, gate, req.log))) {
          continue;
        }
        visible.push(game);
      }

      return { games: visible };
    },
  );

  // POST /games — create a game (requires games.create in the target server)
  app.post(
    "/",
    {
      schema: {
        body: Type.Object({
          serverId: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          sentinelValue: Type.String({ minLength: 1 }),
          kmlPath: Type.String({ minLength: 1 }),
          mapLocationJson: Type.Unknown(),
          hidingRadius: Type.Number({ minimum: 0 }),
          hidingRadiusUnits: Type.Union([Type.Literal("miles"), Type.Literal("kilometers")]),
          size: Type.Optional(Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")])),
        }),
        response: { 201: gameShape },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const body = req.body as {
        serverId: string;
        name: string;
        sentinelValue: string;
        kmlPath: string;
        mapLocationJson: unknown;
        hidingRadius: number;
        hidingRadiusUnits: "miles" | "kilometers";
        size?: "small" | "medium" | "large";
      };

      const server = await prisma.server.findUnique({ where: { id: body.serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      const perms = await getUserPermissions(
        user.discordId,
        body.serverId,
        true,
        req.log,
      );
      if (!perms.has("games.create")) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }

      const game = await prisma.game.create({
        data: { ...body, mapLocationJson: body.mapLocationJson as object },
      });
      return reply.status(201).send(game);
    },
  );

  // PATCH /games/:gameId — update a game (requires games.edit in the game's server)
  app.patch(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          hidingRadius: Type.Optional(Type.Number({ minimum: 0 })),
          hidingRadiusUnits: Type.Optional(
            Type.Union([Type.Literal("miles"), Type.Literal("kilometers")]),
          ),
          size: Type.Optional(Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")])),
        }),
        response: { 200: gameShape },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) throw Object.assign(new Error("Game not found"), { statusCode: 404 });

      const perms = await getUserPermissions(
        user.discordId,
        game.serverId,
        true,
        req.log,
      );
      if (!perms.has("games.edit")) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }

      const body = req.body as { name?: string; hidingRadius?: number; hidingRadiusUnits?: string; size?: string };
      return prisma.game.update({ where: { id: gameId }, data: body });
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

      const game = await prisma.game.findUnique({ where: { id: gameId } });
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

      const sessionCount = await prisma.gameSession.count({ where: { gameId } });
      if (sessionCount > 0) {
        throw Object.assign(
          new Error("Cannot delete a game that has sessions. Delete all sessions first."),
          { statusCode: 409 },
        );
      }

      await prisma.game.delete({ where: { id: gameId } });
      return reply.status(204).send();
    },
  );
}
