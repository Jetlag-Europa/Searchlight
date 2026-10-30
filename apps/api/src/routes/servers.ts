import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getListingAccess } from "../lib/permissions.js";
import { requirePermission } from "../lib/require-permission.js";
import { discord } from "../lib/discord-client.js";
import { env } from "../lib/env.js";
import { VIRTUAL_SERVER_IDS, VIRTUAL_SERVER_PERMISSIONS } from "../lib/virtual-servers.js";

const KNOWN_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];

export async function serverRoutes(app: FastifyInstance) {
  // GET /servers — the servers the authed user is in, plus servers where they
  // have sessions without being in the guild, e.g. sessions started from a
  // game link. Each comes with the user's permissions there. Virtual servers
  // (Casual Games) are listed for those with sessions, games they created
  // (which they keep without the role) or permissions there.
  // `recheck=true` asks Discord again about the servers the user wasn't in a
  // minute or more ago, for someone who just joined one.
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          recheck: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({
            servers: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                iconUrl: Type.Union([Type.String(), Type.Null()]),
                permissions: Type.Array(Type.String()),
                isMember: Type.Boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { recheck = false } = req.query as { recheck?: boolean };
      const [servers, sessionServers, ownGameServers] = await Promise.all([
        prisma.server.findMany({ orderBy: { name: "asc" } }),
        // The sessions GET /sessions lists: created, or shared and accepted.
        prisma.gameSession.findMany({
          where: {
            OR: [
              { creatorId: user.discordId },
              {
                visibility: "shared",
                participants: {
                  some: { userId: user.discordId, acceptedAt: { not: null }, revokedAt: null },
                },
              },
            ],
          },
          select: { serverId: true },
          distinct: ["serverId"],
        }),
        prisma.game.findMany({
          where: { serverId: { in: [...VIRTUAL_SERVER_IDS] }, createdById: user.discordId },
          select: { serverId: true },
          distinct: ["serverId"],
        }),
      ]);
      const hasSessions = new Set(sessionServers.map((s) => s.serverId));
      const hasOwnGames = new Set(ownGameServers.map((g) => g.serverId));

      const settled = await Promise.allSettled(
        servers.map(async (server) => {
          let access: { isMember: boolean; permissions: Set<string> };
          try {
            access = await getListingAccess(user.discordId, server.id, recheck, req.log);
          } catch (err) {
            // Sessions don't need Discord, so keep them reachable.
            if (!hasSessions.has(server.id)) throw err;
            req.log.warn({ serverId: server.id, err }, "Could not check server membership — listing for sessions only");
            access = { isMember: false, permissions: new Set() };
          }
          const { isMember, permissions: perms } = access;
          if (!isMember && !hasSessions.has(server.id)) return null;
          if (
            VIRTUAL_SERVER_IDS.has(server.id) &&
            perms.size === 0 &&
            !hasSessions.has(server.id) &&
            !hasOwnGames.has(server.id)
          ) {
            return null;
          }
          return {
            id: server.id,
            name: server.name,
            iconUrl: server.iconUrl,
            permissions: [...perms],
            isMember,
          };
        }),
      );

      const result = settled.flatMap((r) => {
        if (r.status === "rejected") {
          req.log.warn({ reason: String(r.reason) }, "Failed to resolve membership for a server — skipping");
          return [];
        }
        return r.value ? [r.value] : [];
      });

      return { servers: result };
    },
  );

  // GET /servers/:serverId/roles — Discord roles + permission mappings (server.admin only).
  // A virtual server's roles are its management guild's.
  app.get(
    "/:serverId/roles",
    {
      preHandler: requirePermission(
        "server.admin",
        (req) => (req.params as { serverId: string }).serverId,
      ),
      schema: {
        response: {
          200: Type.Object({
            roles: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                color: Type.Number(),
                position: Type.Number(),
              }),
            ),
            mappings: Type.Array(
              Type.Object({
                discordRoleId: Type.String(),
                permission: Type.String(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const { serverId } = req.params as { serverId: string };

      let guildId = serverId;
      if (VIRTUAL_SERVER_IDS.has(serverId)) {
        const server = await prisma.server.findUnique({
          where: { id: serverId },
          select: { managementGuildId: true },
        });
        if (!server?.managementGuildId) {
          throw Object.assign(new Error("This server has no Discord roles"), { statusCode: 400 });
        }
        guildId = server.managementGuildId;
      }

      const [mappings, roles] = await Promise.all([
        prisma.rolePermission.findMany({
          where: { serverId },
          select: { discordRoleId: true, permission: true },
        }),
        discord.getGuildRoles(guildId, env.DISCORD_BOT_TOKEN, req.log),
      ]);

      return { roles, mappings };
    },
  );

  // POST /servers/:serverId/roles — add a role-permission mapping (server.admin, forceRefresh)
  app.post(
    "/:serverId/roles",
    {
      preHandler: requirePermission(
        "server.admin",
        (req) => (req.params as { serverId: string }).serverId,
        true,
      ),
      schema: {
        body: Type.Object({
          discordRoleId: Type.String({ minLength: 1 }),
          permission: Type.String({ minLength: 1 }),
        }),
        response: {
          200: Type.Object({
            id: Type.Number(),
            serverId: Type.String(),
            discordRoleId: Type.String(),
            permission: Type.String(),
          }),
        },
      },
    },
    async (req) => {
      const { serverId } = req.params as { serverId: string };
      const { discordRoleId, permission } = req.body as { discordRoleId: string; permission: string };

      if (!KNOWN_PERMISSIONS.includes(permission)) {
        throw Object.assign(new Error(`Unknown permission: ${permission}`), { statusCode: 400 });
      }
      if (VIRTUAL_SERVER_IDS.has(serverId) && !VIRTUAL_SERVER_PERMISSIONS.includes(permission)) {
        throw Object.assign(
          new Error(`Only ${VIRTUAL_SERVER_PERMISSIONS.join(", ")} can be granted on this server`),
          { statusCode: 400 },
        );
      }

      return prisma.rolePermission.upsert({
        where: { serverId_discordRoleId_permission: { serverId, discordRoleId, permission } },
        update: {},
        create: { serverId, discordRoleId, permission },
      });
    },
  );

  // DELETE /servers/:serverId/roles/:discordRoleId/permissions/:permission
  app.delete(
    "/:serverId/roles/:discordRoleId/permissions/:permission",
    {
      preHandler: requirePermission(
        "server.admin",
        (req) => (req.params as { serverId: string }).serverId,
        true,
      ),
    },
    async (req, reply) => {
      const { serverId, discordRoleId, permission } = req.params as {
        serverId: string;
        discordRoleId: string;
        permission: string;
      };

      await prisma.rolePermission.deleteMany({ where: { serverId, discordRoleId, permission } });
      return reply.status(204).send();
    },
  );
}
