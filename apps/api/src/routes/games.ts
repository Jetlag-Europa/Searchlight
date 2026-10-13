import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { type Game, type GameListing, Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, userPassesDiscordRoleGate, assertServerMembership } from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { findGameByIdOrKey, managesGame } from "../lib/game-access.js";
import { GAME_LINK_PREFIX } from "../lib/game-sessions.js";

const MAX_LINK_LABEL_LENGTH = 100;

const listingShape = Type.Union([Type.Literal("listed"), Type.Literal("unlisted")]);

const gameShape = Type.Object({
  id: Type.String(),
  gameKey: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  size: Type.String(),
  currentRevisionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  archivedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  listing: listingShape,
  isOwner: Type.Boolean(),
  canManage: Type.Boolean(),
});

const gameLinkShape = Type.Object({
  id: Type.String(),
  token: Type.String(),
  label: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

function notFound(msg = "Game not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}

function serializeGame(game: Game, userId: string, perms: ReadonlySet<string>) {
  return {
    ...game,
    isOwner: game.ownerId === userId,
    canManage: managesGame(perms, userId, game),
  };
}

function serializeLink(link: { id: string; token: string; label: string | null; createdAt: Date }) {
  return {
    id: link.id,
    token: link.token,
    label: link.label,
    createdAt: link.createdAt.toISOString(),
  };
}

/**
 * Resolves a game the user manages, or throws. An unlisted game the user does
 * not manage is reported as missing, as everywhere else.
 */
async function resolveManagedGame(
  gameId: string,
  userId: string,
  log: FastifyBaseLogger,
): Promise<{ game: Game; perms: Set<string> }> {
  const game = await findGameByIdOrKey(gameId);
  if (!game) throw notFound();
  const perms = await getUserPermissions(userId, game.serverId, true, log);
  if (!managesGame(perms, userId, game)) {
    throw game.listing === "unlisted" ? notFound() : forbidden();
  }
  return { game, perms };
}

export async function gameRoutes(app: FastifyInstance) {
  // GET /games?serverId=[&manage=true] — list games for a server (must be a
  // guild member). Unlisted games are left out except for the caller's own;
  // with `manage`, every unlisted game the caller manages is included.
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.String({ minLength: 1 }),
          manage: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({ games: Type.Array(gameShape) }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId, manage = false } = req.query as { serverId: string; manage?: boolean };

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      // Virtual servers (e.g. Home Games) have no Discord guild — skip the
      // membership check; their games are gated individually below.
      if (!VIRTUAL_SERVER_IDS.has(serverId)) {
        await assertServerMembership(user.discordId, serverId, req.log);
      }

      // Only shapes the listing; every action re-checks with fresh roles.
      const perms = await getUserPermissions(user.discordId, serverId, false, req.log).catch(
        (err) => {
          req.log.warn({ serverId, err }, "Could not resolve game permissions for the game list");
          return new Set<string>();
        },
      );

      const games = (
        await prisma.game.findMany({
          where: { serverId },
          orderBy: { name: "asc" },
        })
      ).filter(
        (game) =>
          game.listing === "listed" ||
          (managesGame(perms, user.discordId, game) &&
            (manage || game.ownerId === user.discordId)),
      );

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
        visible.push(serializeGame(game, user.discordId, perms));
      }
      return { games: visible };
    },
  );

  // PATCH /games/:gameId — change a game's listing. Managers may unlist a game;
  // listing one needs games.create or games.edit. Listing revokes the game's
  // links: a listed game is for its server's members.
  app.patch(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Object({ listing: listingShape }),
        response: { 200: gameShape },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const { listing } = req.body as { listing: GameListing };

      const { game, perms } = await resolveManagedGame(gameId, user.discordId, req.log);
      if (
        listing === "listed" &&
        !perms.has("games.create") &&
        !perms.has("games.edit") &&
        !perms.has("server.admin")
      ) {
        throw forbidden("You can only keep games private on this server");
      }

      const updated = await prisma.$transaction(async (tx) => {
        if (listing === "listed") {
          await tx.gameLink.updateMany({
            where: { gameId: game.id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
        return tx.game.update({ where: { id: game.id }, data: { listing } });
      });
      return serializeGame(updated, user.discordId, perms);
    },
  );

  // DELETE /games/:gameId — delete a game (requires games.delete in the game's
  // server, or owning it while still allowed to import games there)
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
      if (!game) throw notFound();

      const perms = await getUserPermissions(
        user.discordId,
        game.serverId,
        true,
        req.log,
      );
      const manages = managesGame(perms, user.discordId, game);
      if (!perms.has("games.delete") && !(manages && game.ownerId === user.discordId)) {
        // As elsewhere, an unlisted game is missing to those who don't manage it.
        throw game.listing === "unlisted" && !manages ? notFound() : forbidden();
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

  // GET /games/:gameId/links — active game links (managers only)
  app.get(
    "/:gameId/links",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        response: { 200: Type.Object({ links: Type.Array(gameLinkShape) }) },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const { game } = await resolveManagedGame(gameId, user.discordId, req.log);

      const links = await prisma.gameLink.findMany({
        where: { gameId: game.id, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return { links: links.map(serializeLink) };
    },
  );

  // POST /games/:gameId/links — create a game link (managers only). Each
  // redemption starts a new session; only unlisted games have links.
  app.post(
    "/:gameId/links",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Optional(
          Type.Object({
            label: Type.Optional(Type.String({ maxLength: MAX_LINK_LABEL_LENGTH })),
          }),
        ),
        response: { 201: gameLinkShape },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const label = (req.body as { label?: string } | undefined)?.label?.trim() || null;
      const { game } = await resolveManagedGame(gameId, user.discordId, req.log);
      if (game.listing !== "unlisted") {
        throw Object.assign(new Error("Only private games have game links"), { statusCode: 409 });
      }

      const link = await prisma.gameLink.create({
        data: {
          token: `${GAME_LINK_PREFIX}${randomBytes(16).toString("hex")}`,
          gameId: game.id,
          createdById: user.discordId,
          label,
        },
      });
      req.log.info({ gameId: game.id, linkId: link.id }, "[links] game link created");
      return reply.status(201).send(serializeLink(link));
    },
  );

  // DELETE /games/:gameId/links/:linkId — revoke a game link (managers only).
  // Sessions already started from it keep working.
  app.delete(
    "/:gameId/links/:linkId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String(), linkId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId, linkId } = req.params as { gameId: string; linkId: string };
      const { game } = await resolveManagedGame(gameId, user.discordId, req.log);

      const { count } = await prisma.gameLink.updateMany({
        where: { id: linkId, gameId: game.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw notFound("Link not found");
      return reply.status(204).send();
    },
  );
}
