import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import {
  getUserPermissions,
  isServerMember,
  LISTING_NON_MEMBER_TTL_MS,
  recheckServerMembership,
} from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { requirePermission } from "../lib/require-permission.js";
import { discord } from "../lib/discord-client.js";
import { env } from "../lib/env.js";

const KNOWN_PERMISSIONS = ["games.create", "games.edit", "games.delete", "server.admin"];

// Only Discord invites: the link is shown to everyone browsing the server's games.
const DISCORD_INVITE = /^https:\/\/(discord\.gg|(www\.)?discord\.com\/invite)\/[A-Za-z0-9-]+\/?$/;

export async function serverRoutes(app: FastifyInstance) {
  // GET /servers — the servers the authed user is in (and virtual ones), plus
  // servers where they have sessions without being in the guild, e.g. sessions
  // started from a game link. Each comes with the user's permissions there.
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
                inviteUrl: Type.Union([Type.String(), Type.Null()]),
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
      const [servers, sessionServers] = await Promise.all([
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
      ]);
      const hasSessions = new Set(sessionServers.map((s) => s.serverId));

      const settled = await Promise.allSettled(
        servers.map(async (server) => {
          let isMember: boolean;
          try {
            isMember =
              VIRTUAL_SERVER_IDS.has(server.id) ||
              (await isServerMember(user.discordId, server.id, req.log, LISTING_NON_MEMBER_TTL_MS));
          } catch (err) {
            // Sessions don't need Discord, so keep them reachable.
            if (!hasSessions.has(server.id)) throw err;
            req.log.warn({ serverId: server.id, err }, "Could not check server membership — listing for sessions only");
            isMember = false;
          }
          if (!isMember && !hasSessions.has(server.id)) return null;
          const perms = isMember
            ? await getUserPermissions(user.discordId, server.id, false, req.log)
            : new Set<string>();
          return {
            id: server.id,
            name: server.name,
            iconUrl: server.iconUrl,
            inviteUrl: server.inviteUrl,
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

  // PATCH /servers/:serverId — set or clear the server's Discord invite (server.admin)
  app.patch(
    "/:serverId",
    {
      preHandler: requirePermission(
        "server.admin",
        (req) => (req.params as { serverId: string }).serverId,
        true,
      ),
      schema: {
        params: Type.Object({ serverId: Type.String() }),
        body: Type.Object(
          { inviteUrl: Type.Union([Type.String(), Type.Null()]) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ id: Type.String(), inviteUrl: Type.Union([Type.String(), Type.Null()]) }),
        },
      },
    },
    async (req) => {
      const { serverId } = req.params as { serverId: string };
      const inviteUrl = (req.body as { inviteUrl: string | null }).inviteUrl?.trim() || null;
      if (VIRTUAL_SERVER_IDS.has(serverId)) {
        throw Object.assign(new Error("This server has no Discord server to invite to"), { statusCode: 400 });
      }
      if (inviteUrl && !DISCORD_INVITE.test(inviteUrl)) {
        throw Object.assign(
          new Error("Use a Discord invite link, like https://discord.gg/abc123"),
          { statusCode: 400 },
        );
      }
      const server = await prisma.server.update({ where: { id: serverId }, data: { inviteUrl } });
      return { id: server.id, inviteUrl: server.inviteUrl };
    },
  );

  // POST /servers/:serverId/membership — ask Discord again whether the user is
  // in the server, so someone who just joined can play its games right away.
  app.post(
    "/:serverId/membership",
    {
      schema: {
        params: Type.Object({ serverId: Type.String() }),
        response: { 200: Type.Object({ isMember: Type.Boolean() }) },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.params as { serverId: string };
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      return { isMember: await recheckServerMembership(user.discordId, serverId, req.log) };
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
        discord.getGuildRoles(serverId, env.DISCORD_BOT_TOKEN, req.log),
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
