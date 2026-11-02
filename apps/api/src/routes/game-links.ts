import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { assertCanManageGame, findActiveLink, findGameByIdOrKey } from "../lib/game-access.js";
import { notFound } from "../lib/http-errors.js";
import { createSession } from "./sessions.js";

// A game link lets whoever holds it start sessions of the game: it stands in
// for server membership, the game's role gate and its listing. Links are
// independent of whether the game is listed and only end when revoked.

function serializeLink(link: {
  id: string;
  token: string;
  createdAt: Date;
  createdBy: { displayName: string };
}) {
  return {
    id: link.id,
    token: link.token,
    createdAt: link.createdAt.toISOString(),
    createdByDisplayName: link.createdBy.displayName,
  };
}

// Under /games: managing a game's links (game managers of its server).
export async function gameLinkManagementRoutes(app: FastifyInstance) {
  // GET /games/:gameId/links — active links
  app.get(
    "/:gameId/links",
    { schema: { params: Type.Object({ gameId: Type.String() }) } },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const game = await findGameByIdOrKey(gameId);
      if (!game) throw notFound("Game not found");
      await assertCanManageGame(user.discordId, game, req.log);

      const links = await prisma.gameLink.findMany({
        where: { gameId: game.id, revokedAt: null },
        include: { createdBy: { select: { displayName: true } } },
        orderBy: { createdAt: "desc" },
      });
      return { links: links.map(serializeLink) };
    },
  );

  // POST /games/:gameId/links — create a link
  app.post(
    "/:gameId/links",
    { schema: { params: Type.Object({ gameId: Type.String() }) } },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const game = await findGameByIdOrKey(gameId);
      if (!game) throw notFound("Game not found");
      await assertCanManageGame(user.discordId, game, req.log);

      const link = await prisma.gameLink.create({
        data: {
          token: randomBytes(16).toString("hex"),
          gameId: game.id,
          createdById: user.discordId,
        },
        include: { createdBy: { select: { displayName: true } } },
      });
      req.log.info({ gameId: game.id, linkId: link.id, userId: user.discordId }, "[game-links] created");
      return reply.status(201).send(serializeLink(link));
    },
  );

  // DELETE /games/:gameId/links/:linkId — revoke a link. Sessions started
  // from it remain; they just can't follow the game to newer revisions unless
  // their creator has access to the game.
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
      const game = await findGameByIdOrKey(gameId);
      if (!game) throw notFound("Game not found");
      await assertCanManageGame(user.discordId, game, req.log);

      const { count } = await prisma.gameLink.updateMany({
        where: { id: linkId, gameId: game.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw notFound("Link not found");
      req.log.info({ gameId: game.id, linkId, userId: user.discordId }, "[game-links] revoked");
      return reply.status(204).send();
    },
  );
}

// Under /game-links: using a link.
export async function gameLinkRoutes(app: FastifyInstance) {
  // GET /game-links/:token — public, no auth required
  app.get(
    "/:token",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req) => {
      const { token } = req.params as { token: string };
      const link = await findActiveLink(token);
      if (!link?.game.currentRevision) return { valid: false };
      return {
        valid: true,
        gameName: link.game.name,
        serverName: link.game.server.name,
      };
    },
  );

  // POST /game-links/:token/sessions — start a session of the linked game,
  // pinned to its current revision.
  app.post(
    "/:token/sessions",
    {
      schema: {
        params: Type.Object({ token: Type.String() }),
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          visibility: Type.Union([Type.Literal("private"), Type.Literal("shared")]),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { token } = req.params as { token: string };
      const { name, visibility } = req.body as { name: string; visibility: "private" | "shared" };

      const link = await findActiveLink(token);
      if (!link) throw notFound("Link is invalid or has been revoked");
      const { game } = link;
      if (!game.currentRevision) {
        throw notFound("This game has no published revision");
      }

      const session = await createSession({
        game,
        revision: game.currentRevision,
        creatorId: user.discordId,
        name,
        visibility,
        gameLinkId: link.id,
      });
      req.log.info(
        { linkId: link.id, gameId: game.id, sessionId: session.id, userId: user.discordId },
        "[game-links] session started",
      );
      return reply.status(201).send(session);
    },
  );
}
