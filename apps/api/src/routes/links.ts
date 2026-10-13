import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { createGameSession, forkFollowsGame, GAME_LINK_PREFIX } from "../lib/game-sessions.js";

function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}

// A game link works while it is unrevoked and its game has a revision to
// start a session on.
async function findRedeemableGameLink(token: string) {
  const link = await prisma.gameLink.findUnique({
    where: { token },
    include: { game: true },
  });
  if (!link || link.revokedAt) return null;
  const gameRevisionId = link.game.currentRevisionId;
  return gameRevisionId ? { ...link, gameRevisionId } : null;
}

export async function linkRoutes(app: FastifyInstance) {
  // GET /links/:token — public, no auth required
  app.get(
    "/:token",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req) => {
      const { token } = req.params as { token: string };
      if (token.startsWith(GAME_LINK_PREFIX)) {
        const gameLink = await findRedeemableGameLink(token);
        if (!gameLink) return { valid: false };
        return { valid: true, gameName: gameLink.game.name, linkType: "game" as const };
      }
      const link = await prisma.sessionLink.findUnique({
        where: { token },
        include: { session: { include: { game: { select: { name: true } } } } },
      });
      if (!link || link.revokedAt) return { valid: false };
      return {
        valid: true,
        sessionName: link.session.name,
        gameName: link.session.game.name,
        linkType: link.linkType as "join" | "fork",
      };
    },
  );

  // POST /links/:token/redeem — authenticated
  app.post(
    "/:token/redeem",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { token } = req.params as { token: string };

      // game: start a new session of the game. The link is the grant, so
      // neither server membership nor a role gate is checked.
      if (token.startsWith(GAME_LINK_PREFIX)) {
        const gameLink = await findRedeemableGameLink(token);
        if (!gameLink) throw notFound("Link is invalid or has been revoked");
        const session = await createGameSession({
          gameId: gameLink.game.id,
          serverId: gameLink.game.serverId,
          creatorId: user.discordId,
          name: gameLink.game.name,
          visibility: "private",
          gameRevisionId: gameLink.gameRevisionId,
          followsGame: true,
        });
        req.log.info(
          { linkId: gameLink.id, sessionId: session.id, userId: user.discordId },
          "[links] game link redeemed",
        );
        return reply.status(200).send({ sessionId: session.id, linkType: "game" });
      }

      const link = await prisma.sessionLink.findUnique({
        where: { token },
        include: { session: { include: { game: { select: { listing: true } } } }, snapshot: true },
      });
      if (!link || link.revokedAt) throw notFound("Link is invalid or has been revoked");
      if (link.session.creatorId === user.discordId) throw forbidden("Cannot redeem your own link");

      if (link.linkType === "fork") {
        const questions = (link.snapshot?.questions ?? []) as Array<{
          payloadJson: object;
          ordinal: number;
          clientUuid: string;
        }>;
        const targetRevisionId = link.snapshot?.gameRevisionId ?? link.session.gameRevisionId;
        const newSession = await prisma.$transaction(async (tx) => {
          const created = await tx.gameSession.create({
            data: {
              gameId: link.session.gameId,
              serverId: link.session.serverId,
              creatorId: user.discordId,
              name: `Copy of ${link.session.name}`,
              visibility: "private",
              gameRevisionId: targetRevisionId,
              followsGame: forkFollowsGame(link.session),
            },
          });
          await tx.sessionParticipant.create({
            data: {
              sessionId: created.id,
              userId: user.discordId,
              role: "creator",
              acceptedAt: new Date(),
            },
          });
          if (questions.length > 0) {
            await tx.sessionQuestion.createMany({
              data: questions.map((q) => ({
                sessionId: created.id,
                payloadJson: q.payloadJson,
                ordinal: q.ordinal,
                clientUuid: `link-${created.id}-${q.clientUuid}`,
              })),
            });
          }
          return created;
        });
        req.log.info({ token, newSessionId: newSession.id, userId: user.discordId }, "[links] fork link redeemed");
        return reply.status(200).send({ sessionId: newSession.id, linkType: "fork" });
      }

      // join: promote to shared if private
      if (link.session.visibility === "private") {
        await prisma.gameSession.update({
          where: { id: link.session.id },
          data: { visibility: "shared" },
        });
      }
      await prisma.sessionParticipant.upsert({
        where: { sessionId_userId: { sessionId: link.session.id, userId: user.discordId } },
        update: { acceptedAt: new Date(), revokedAt: null },
        create: { sessionId: link.session.id, userId: user.discordId, role: "member", acceptedAt: new Date() },
      });
      req.log.info({ token, sessionId: link.session.id, userId: user.discordId }, "[links] join link redeemed");
      return reply.status(200).send({ sessionId: link.session.id, linkType: "join" });
    },
  );
}
