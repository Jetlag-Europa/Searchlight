import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { assertCanManageGame, findActiveLink } from "../lib/game-access.js";
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
  // Responses holding link tokens are left uncompressed, so their length
  // can't give anything away about the tokens (BREACH).

  // GET /games/:gameId/links — active links
  app.get(
    "/:gameId/links",
    { compress: false, schema: { params: Type.Object({ gameId: Type.String() }) } },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const game = await prisma.game.findUnique({ where: { id: gameId } });
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
    { compress: false, schema: { params: Type.Object({ gameId: Type.String() }) } },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const game = await prisma.game.findUnique({ where: { id: gameId } });
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
      const game = await prisma.game.findUnique({ where: { id: gameId } });
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

// A proxy that compresses or recompresses responses weakens ETags (W/"..."),
// and If-None-Match may list several tags.
function matchesETag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .some((tag) => tag.trim().replace(/^W\//, "") === etag);
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

  // GET /game-links/:token/definition — public, no auth required.
  // Lets a player open the linked game locally in their browser without
  // signing in or creating a server-backed session. Revoking the link stops
  // new loads immediately (Cache-Control: no-cache still allows ETag 304).
  app.get(
    "/:token/definition",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const link = await findActiveLink(token);
      const revision = link?.game.currentRevision;
      if (!link || !revision) {
        throw notFound("Link is invalid or has been revoked");
      }

      const etag = `"${revision.checksum}"`;
      if (matchesETag(req.headers["if-none-match"], etag)) {
        return reply
          .header("ETag", etag)
          .header("Cache-Control", "no-cache")
          .status(304)
          .send();
      }

      const rev = await prisma.gameRevision.findUnique({
        where: { id: revision.id },
        select: { definition: true },
      });
      if (!rev) {
        throw notFound("Game definition not found");
      }

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("ETag", etag)
        .header("Cache-Control", "no-cache")
        .send(JSON.stringify(rev.definition));
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
