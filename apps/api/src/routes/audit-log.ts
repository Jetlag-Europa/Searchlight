import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { AuditAction, AuditLogResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, isAdmin } from "../lib/permissions.js";
import { badRequest, forbidden } from "../lib/http-errors.js";

export async function auditLogRoutes(app: FastifyInstance) {
  // GET /audit-log — newest first: a server's entries for its server admins,
  // every server's (no serverId) for global admins. Nobody holds server.admin
  // on Casual Games (virtual-servers.ts), so only global admins see its entries.
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.Optional(Type.String({ minLength: 1 })),
          // The id of the last entry of the previous page.
          before: Type.Optional(Type.String({ minLength: 1 })),
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
        }),
      },
    },
    async (req): Promise<AuditLogResponse> => {
      const { user } = await resolveSession(req);
      const { serverId, before, limit } = req.query as {
        serverId?: string;
        before?: string;
        limit: number;
      };
      const allowed =
        isAdmin(user.discordId) ||
        (serverId !== undefined &&
          // An unregistered server has no roles to look up.
          (await prisma.server.count({ where: { id: serverId } })) > 0 &&
          (await getUserPermissions(user.discordId, serverId, true, req.log)).has("server.admin"));
      if (!allowed) throw forbidden();

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
}
