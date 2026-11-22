import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { AuditAction, AuditLogFilters, AuditLogResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, isAdmin } from "../lib/permissions.js";
import { badRequest, forbidden } from "../lib/http-errors.js";

// A server's log is for its server admins, every server's (no serverId) for
// global admins. Nobody holds server.admin on Casual Games (virtual-servers.ts),
// so only global admins see its entries.
async function assertCanRead(req: FastifyRequest, serverId: string | undefined) {
  const { user } = await resolveSession(req);
  const allowed =
    isAdmin(user.discordId) ||
    (serverId !== undefined &&
      // An unregistered server has no roles to look up.
      (await prisma.server.count({ where: { id: serverId } })) > 0 &&
      (await getUserPermissions(user.discordId, serverId, true, req.log)).has("server.admin"));
  if (!allowed) throw forbidden();
}

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-log — newest first, optionally only one action, actor or target
  // (a game's or role's id).
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.Optional(Type.String({ minLength: 1 })),
          action: Type.Optional(Type.String({ minLength: 1 })),
          actorId: Type.Optional(Type.String({ minLength: 1 })),
          targetId: Type.Optional(Type.String({ minLength: 1 })),
          // The id of the last entry of the previous page.
          before: Type.Optional(Type.String({ minLength: 1 })),
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
        }),
      },
    },
    async (req): Promise<AuditLogResponse> => {
      const { serverId, action, actorId, targetId, before, limit } = req.query as {
        serverId?: string;
        action?: string;
        actorId?: string;
        targetId?: string;
        before?: string;
        limit: number;
      };
      await assertCanRead(req, serverId);

      const cursor = before
        ? await prisma.auditLog.findUnique({
            where: { id: before, serverId },
            select: { id: true, createdAt: true },
          })
        : null;
      if (before && !cursor) throw badRequest("Unknown cursor");

      const rows = await prisma.auditLog.findMany({
        where: {
          serverId,
          action,
          actorId,
          targetId,
          ...(cursor && {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // One more tells whether there is a next page.
        take: limit + 1,
      });
      const page = rows.slice(0, limit);

      const [users, servers] = await Promise.all([
        prisma.user.findMany({
          where: { discordId: { in: page.flatMap((e) => e.actorId ?? []) } },
          select: { discordId: true, displayName: true },
        }),
        prisma.server.findMany({
          where: { id: { in: page.map((e) => e.serverId) } },
          select: { id: true, name: true },
        }),
      ]);
      const userNames = new Map(users.map((u) => [u.discordId, u.displayName]));
      const serverNames = new Map(servers.map((s) => [s.id, s.name]));

      return {
        entries: page.map((e) => ({
          ...e,
          createdAt: e.createdAt.toISOString(),
          serverName: serverNames.get(e.serverId) ?? null,
          actorName: (e.actorId && userNames.get(e.actorId)) ?? null,
          action: e.action as AuditAction,
          details: e.details as Record<string, unknown>,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      };
    },
  );

  // GET /audit-log/filters — the servers, actors and games the log has entries
  // for, to filter it by.
  app.get(
    "/filters",
    {
      schema: {
        querystring: Type.Object({ serverId: Type.Optional(Type.String({ minLength: 1 })) }),
      },
    },
    async (req): Promise<AuditLogFilters> => {
      const { serverId } = req.query as { serverId?: string };
      await assertCanRead(req, serverId);

      const [serverIds, actorIds, games] = await Promise.all([
        prisma.auditLog.findMany({
          where: { serverId },
          distinct: ["serverId"],
          select: { serverId: true },
        }),
        prisma.auditLog.findMany({
          where: { serverId, actorId: { not: null } },
          distinct: ["actorId"],
          select: { actorId: true },
        }),
        // Newest first, so each game comes with its latest name.
        prisma.auditLog.findMany({
          where: {
            serverId,
            OR: [{ action: { startsWith: "game." } }, { action: { startsWith: "link." } }],
          },
          distinct: ["targetId"],
          orderBy: { createdAt: "desc" },
          select: { targetId: true, targetName: true, serverId: true },
        }),
      ]);
      const [servers, users] = await Promise.all([
        prisma.server.findMany({
          where: { id: { in: serverIds.map((s) => s.serverId) } },
          select: { id: true, name: true },
        }),
        prisma.user.findMany({
          where: { discordId: { in: actorIds.flatMap((a) => a.actorId ?? []) } },
          select: { discordId: true, displayName: true },
        }),
      ]);
      const serverNames = new Map(servers.map((s) => [s.id, s.name]));
      const userNames = new Map(users.map((u) => [u.discordId, u.displayName]));

      return {
        servers: serverIds.map(({ serverId: id }) => ({ id, name: serverNames.get(id) ?? null })),
        actors: actorIds.flatMap(({ actorId: id }) =>
          id ? [{ id, name: userNames.get(id) ?? null }] : [],
        ),
        games: games.map((g) => ({ id: g.targetId, name: g.targetName, serverId: g.serverId })),
      };
    },
  );
}
