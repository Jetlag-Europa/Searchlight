import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions } from "../lib/permissions.js";
import { requirePermission } from "../lib/require-permission.js";
import { discord, type DiscordRole } from "../lib/discord-client.js";
import { env } from "../lib/env.js";

const KNOWN_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];

export async function serverRoutes(app: FastifyInstance) {
  // GET /servers — list seeded servers with the authed user's permissions for each
  app.get(
    "/",
    {
      schema: {
        response: {
          200: Type.Object({
            servers: Type.Array(
              Type.Object({
                id: Type.String(),
                name: Type.String(),
                iconUrl: Type.Union([Type.String(), Type.Null()]),
                permissions: Type.Array(Type.String()),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const servers = await prisma.server.findMany({ orderBy: { name: "asc" } });

      const settled = await Promise.allSettled(
        servers.map(async (server) => {
          const perms = await getUserPermissions(user.discordId, server.id, false, req.log);
          return {
            id: server.id,
            name: server.name,
            iconUrl: server.iconUrl,
            permissions: [...perms],
          };
        }),
      );

      const result = settled
        .filter((r) => {
          if (r.status === "rejected") {
            req.log.warn({ reason: String(r.reason) }, "Failed to resolve permissions for a server — skipping");
          }
          return r.status === "fulfilled";
        })
        .map((r) => (r as PromiseFulfilledResult<{ id: string; name: string; iconUrl: string | null; permissions: string[] }>).value);

      return { servers: result };
    },
  );

  // GET /servers/:serverId/roles — Discord roles + permission mappings (server.admin only)
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

      const [mappings, roles] = await Promise.all([
        prisma.rolePermission.findMany({
          where: { serverId },
          select: { discordRoleId: true, permission: true },
        }),
        env.DISCORD_BOT_TOKEN
          ? discord.getGuildRoles(serverId, env.DISCORD_BOT_TOKEN, req.log)
          : Promise.resolve([] as DiscordRole[]),
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
