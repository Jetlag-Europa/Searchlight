import type { FastifyInstance, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import type { AuditAction, AuditLogFilters, AuditLogResponse } from "@searchlight/shared";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, isAdmin } from "../lib/permissions.js";
import { canManageGame } from "../lib/game-access.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { badRequest, forbidden } from "../lib/http-errors.js";

// What a game's history (GET /games' History) shows.
const GAME_ACTIONS: AuditAction[] = [
  "game.create",
  "game.revision",
  "game.listing",
  "game.delete",
  "link.create",
  "link.revoke",
];

/**
 * Every server's log (no serverId) is for global admins, a server's for its
 * server admins: null then, the request's own filters apply. A game's
 * managers (e.g. a Casual game's creator) read that game's entries, given its
 * targetId: the returned filter then applies to the cursor and the rows alike.
 */
async function readableEntries(
  req: FastifyRequest,
  serverId: string | undefined,
  targetId?: string,
  action?: string,
): Promise<Prisma.AuditLogWhereInput | null> {
  const { user } = await resolveSession(req);
  if (isAdmin(user.discordId)) return null;
  if (
    serverId !== undefined &&
    // Nobody but global admins holds server.admin there (virtual-servers.ts).
    !VIRTUAL_SERVER_IDS.has(serverId) &&
    // An unregistered server has no roles to look up.
    (await prisma.server.count({ where: { id: serverId } })) > 0 &&
    (await getUserPermissions(user.discordId, serverId, true, req.log)).has("server.admin")
  ) {
    return null;
  }
  if (targetId !== undefined) {
    const game = await prisma.game.findUnique({
      where: { id: targetId },
      select: { id: true, serverId: true, createdById: true },
    });
    if (
      game &&
      (serverId === undefined || serverId === game.serverId) &&
      (await canManageGame(user.discordId, game, req.log))
    ) {
      return {
        serverId: game.serverId,
        targetId: game.id,
        // Role entries could share the id: AuditLog targets are untyped.
        action: { in: GAME_ACTIONS.filter((a) => action === undefined || a === action) },
      };
    }
  }
  throw forbidden();
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
      const scope = await readableEntries(req, serverId, targetId, action);

      const cursor = before
        ? await prisma.auditLog.findFirst({
            where: { id: before, ...(scope ?? { serverId }) },
            select: { id: true, createdAt: true },
          })
        : null;
      if (before && !cursor) throw badRequest("Unknown cursor");

      const rows = await prisma.auditLog.findMany({
        where: {
          ...(scope ?? { serverId, action, targetId }),
          actorId,
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
      await readableEntries(req, serverId);

      // Grouped in the database: the log is kept forever.
      const [serverIds, actorIds, games] = await Promise.all([
        // Only the global log lets you pick a server.
        serverId ? [] : prisma.auditLog.groupBy({ by: ["serverId"] }),
        prisma.auditLog.groupBy({ by: ["actorId"], where: { serverId, actorId: { not: null } } }),
        // Each game by the name of its latest entry.
        prisma.$queryRaw<AuditLogFilters["games"]>`
          SELECT DISTINCT ON ("targetId") "targetId" AS id, "targetName" AS name, "serverId"
          FROM "AuditLog"
          WHERE (action LIKE 'game.%' OR action LIKE 'link.%')
            ${serverId ? Prisma.sql`AND "serverId" = ${serverId}` : Prisma.empty}
          ORDER BY "targetId", "createdAt" DESC, id DESC
        `,
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
        games,
      };
    },
  );
}
