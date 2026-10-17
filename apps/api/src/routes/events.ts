import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { subscribe, addPresence, removePresence, getPresence, registerUserStream } from "../lib/broadcaster.js";
import type { PresenceUser } from "@searchlight/shared";
import { env } from "../lib/env.js";

// Unsent bytes a stream may hold before its client counts as stalled.
const MAX_BUFFERED_BYTES = 1024 * 1024;

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
  // GET /sessions/:sessionId/events/cursor — returns { sequence: number }
  app.get(
    "/:sessionId/events/cursor",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        response: {
          200: Type.Object({ sequence: Type.Integer() }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const session = await prisma.gameSession.findUnique({
        where: { id: sessionId },
        select: { eventSequence: true },
      });
      if (!session) throw Object.assign(new Error("Session not found"), { statusCode: 404 });

      return {
        sequence: session.eventSequence ?? 0,
      };
    },
  );

  // GET /sessions/:sessionId/events?after=<nonnegative integer>&limit=<1..250>
  app.get(
    "/:sessionId/events",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        querystring: Type.Object({
          after: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 250 })),
        }),
        response: {
          200: Type.Object({
            events: Type.Array(
              Type.Object({
                id: Type.String(),
                sessionId: Type.String(),
                userId: Type.String(),
                sequence: Type.Integer(),
                type: Type.String(),
                payloadJson: Type.Unknown(),
                clientUuid: Type.String(),
                clientCreatedAt: Type.String(),
                serverReceivedAt: Type.String(),
              }),
            ),
            nextAfter: Type.Union([Type.Integer(), Type.Null()]),
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const query = req.query as { after?: number; limit?: number };
      const after = query.after ?? 0;
      const limit = query.limit ?? 50;

      const rows = await prisma.event.findMany({
        where: {
          sessionId,
          sequence: { gt: after },
        },
        orderBy: {
          sequence: "asc",
        },
        take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;
      const nextAfter = hasMore && events.length > 0 ? events[events.length - 1].sequence : null;

      return {
        events: events.map((e) => ({
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          sequence: e.sequence,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        })),
        nextAfter,
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

      const userRecord = await prisma.user.findUnique({
        where: { discordId: user.discordId },
        select: { displayName: true, avatarUrl: true },
      });
      const presenceUser: PresenceUser = {
        userId: user.discordId,
        displayName: userRecord?.displayName ?? user.discordId,
        avatarUrl: userRecord?.avatarUrl ?? "",
      };

      req.log.info({ sessionId, userId: user.discordId, displayName: presenceUser.displayName }, "[sse] client connected");

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

      let isClosed = false;
      let keepAlive: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      let unregisterStream: (() => void) | null = null;

      const doClose = () => {
        if (isClosed) return;
        isClosed = true;
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (unregisterStream) {
          unregisterStream();
          unregisterStream = null;
        }
        removePresence(sessionId, user.discordId);
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      };

      unregisterStream = registerUserStream(sessionId, user.discordId, doClose);

      unsubscribe = subscribe(sessionId, (event) => {
        if (isClosed) return;
        req.log.info({ sessionId, eventType: event.type }, "[sse] pushing event to client");
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        // A client that stopped reading would otherwise buffer every event in
        // memory. Drop it; it reconnects and resumes from its last sequence.
        if (reply.raw.writableLength > MAX_BUFFERED_BYTES) {
          req.log.warn(
            { sessionId, userId: user.discordId, buffered: reply.raw.writableLength },
            "[sse] client not reading, closing stream",
          );
          doClose();
          reply.raw.destroy();
        }
      });

      // Send current presence roster to this client before registering them
      const snapshot = getPresence(sessionId);
      req.log.info({ sessionId, presenceCount: snapshot.length }, "[sse] sending presence snapshot");
      reply.raw.write(`data: ${JSON.stringify({ type: "presence.snapshot", payloadJson: { users: snapshot } })}\n\n`);

      // Register presence — broadcasts presence.join to all subscribers including this client
      addPresence(sessionId, presenceUser);

      keepAlive = setInterval(() => {
        if (isClosed) return;
        req.log.debug({ sessionId }, "[sse] ping");
        reply.raw.write(": ping\n\n");
      }, 25_000);

      req.raw.on("close", () => {
        req.log.info({ sessionId, userId: user.discordId }, "[sse] client disconnected");
        doClose();
      });
      reply.hijack();

      // A kick, leave or delete that landed between the check above and
      // registerUserStream closed this user's streams before this one was
      // registered. Check again now that any later one will find it.
      try {
        await assertParticipant(sessionId, user.discordId);
      } catch {
        req.log.info({ sessionId, userId: user.discordId }, "[sse] access lost while connecting, closing stream");
        doClose();
      }
    },
  );
}
