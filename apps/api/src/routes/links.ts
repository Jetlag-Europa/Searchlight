import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { forbidden, notFound } from "../lib/http-errors.js";

export async function linkRoutes(app: FastifyInstance) {
  // GET /links/:token — public, no auth required
  app.get(
    "/:token",
    { schema: { params: Type.Object({ token: Type.String() }) } },
    async (req) => {
      const { token } = req.params as { token: string };
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

      const link = await prisma.sessionLink.findUnique({
        where: { token },
        include: { session: true, snapshot: true },
      });
      if (!link || link.revokedAt) throw notFound("Link is invalid or has been revoked");
      if (link.session.creatorId === user.discordId) {
        // The creator is already in the session; opening their own join
        // link just takes them there.
        if (link.linkType === "join") {
          return reply.status(200).send({ sessionId: link.session.id, linkType: "join" });
        }
        throw forbidden("Cannot redeem your own link");
      }

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
