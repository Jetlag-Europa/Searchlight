import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { subscribe } from "../lib/broadcaster.js";
import { env } from "../lib/env.js";

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

  // GET /sessions/:sessionId/stream — SSE push channel
  app.get(
    "/:sessionId/stream",
    {
      schema: { params: Type.Object({ sessionId: Type.String() }) },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      req.log.info({ sessionId, userId: user.discordId }, "[sse] client connected");

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
        "Access-Control-Allow-Credentials": "true",
      });
      reply.raw.write("retry: 3000\n\n");
      req.log.info({ sessionId, userId: user.discordId }, "[sse] headers sent, stream open");

      const unsubscribe = subscribe(sessionId, (event) => {
        req.log.info({ sessionId, eventType: event.type, clientUuid: event.clientUuid }, "[sse] pushing event to client");
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      });

      const keepAlive = setInterval(() => {
        req.log.debug({ sessionId }, "[sse] ping");
        reply.raw.write(": ping\n\n");
      }, 25_000);

      req.raw.on("close", () => {
        req.log.info({ sessionId, userId: user.discordId }, "[sse] client disconnected");
        unsubscribe();
        clearInterval(keepAlive);
      });

      await reply.hijack();
    },
  );
}
