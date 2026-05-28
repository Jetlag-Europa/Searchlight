import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";

async function assertParticipant(sessionId: string, userId: string) {
  const session = await prisma.gameSession.findUnique({ where: { id: sessionId } });
  if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });
  if (session.creatorId === userId) return;
  const participant = await prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });
  if (!participant || participant.acceptedAt === null || participant.revokedAt !== null) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
}

export async function eventRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/events?since=<ISO timestamp>
  app.get(
    "/:sessionId/events",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        querystring: Type.Object({
          since: Type.Optional(Type.String()),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const { since } = req.query as { since?: string };
      const sinceDate = since ? new Date(since) : new Date(0);

      const events = await prisma.event.findMany({
        where: {
          sessionId,
          serverReceivedAt: { gt: sinceDate },
        },
        orderBy: { serverReceivedAt: "asc" },
      });

      return {
        events: events.map((e: typeof events[number]) => ({
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        })),
      };
    },
  );
}
