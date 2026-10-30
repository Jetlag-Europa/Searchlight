import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { subscribe, addPresence, removePresence, getPresence, registerUserStream } from "../lib/broadcaster.js";
import type { PresenceUser, SessionRole } from "@searchlight/shared";
import { env } from "../lib/env.js";
import { eventForRole, resolveSessionAccess } from "../lib/session-access.js";

// How long a stream waits for its client to read a backed-up write before
// dropping it. An object so tests can shorten it.
export const stallTimeout = { ms: 30_000 };

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
      const { session } = await resolveSessionAccess(sessionId, user.discordId);

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
      const { role } = await resolveSessionAccess(sessionId, user.discordId);

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
        events: events.map((e) => eventForRole({
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          sequence: e.sequence,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        }, role)),
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
      await resolveSessionAccess(sessionId, user.discordId);

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

      // The reply is hijacked, so the CORS plugin doesn't add these.
      const corsHeaders = {
        "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
        "Access-Control-Allow-Credentials": "true",
      };

      let isClosed = false;
      let isPresent = false;
      let keepAlive: NodeJS.Timeout | null = null;
      let stallTimer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      let unregisterStream: (() => void) | null = null;

      // Closing before the stream opened answers `status` instead: EventSource
      // treats any non-200 as final, and the client then checks the session
      // before it reconnects.
      const doClose = (status = 503) => {
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
        if (isPresent) removePresence(sessionId, user.discordId);
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
        try {
          if (!reply.raw.headersSent) reply.raw.writeHead(status, corsHeaders);
          reply.raw.end();
        } catch {
          // ignore
        }
      };

      // A client that stops reading would otherwise make the stream buffer
      // every event in memory. Once a write has to wait, the client has
      // stallTimeout.ms to drain it; if it doesn't, drop the stream. It
      // reconnects and resumes from its last sequence.
      const send = (chunk: string) => {
        if (reply.raw.write(chunk) || stallTimer) return;
        stallTimer = setTimeout(() => {
          req.log.warn({ sessionId, userId: user.discordId }, "[sse] client stopped reading, closing stream");
          doClose();
          reply.raw.destroy();
        }, stallTimeout.ms);
        reply.raw.once("drain", () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = null;
        });
      };

      reply.hijack();
      req.raw.on("close", () => {
        req.log.info({ sessionId, userId: user.discordId }, "[sse] client disconnected");
        doClose();
      });
      // A client that left during the lookups above closed before the listener.
      if (req.raw.destroyed || reply.raw.destroyed) {
        doClose();
        return;
      }
      unregisterStream = registerUserStream(sessionId, user.discordId, doClose);
      if (isClosed) return;

      // A kick, leave, role change or delete that landed between the check
      // above and registerUserStream closed this user's streams before this
      // one was registered. Check again now that any later one will find it,
      // before opening the stream: once it's open the client starts catching
      // up, so from then on it must get every new event. The stream is
      // filtered for the role this finds; changing it closes the stream.
      let role: SessionRole;
      try {
        ({ role } = await resolveSessionAccess(sessionId, user.discordId));
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        req.log.info(
          { sessionId, userId: user.discordId, err, statusCode },
          "[sse] access check failed while connecting, closing stream",
        );
        doClose(statusCode ?? 500);
        return;
      }
      if (isClosed) return;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        ...corsHeaders,
      });
      reply.raw.write("retry: 3000\n\n");
      req.log.info({ sessionId, userId: user.discordId }, "[sse] headers sent, stream open");

      unsubscribe = subscribe(sessionId, (event) => {
        if (isClosed) return;
        req.log.info({ sessionId, eventType: event.type }, "[sse] pushing event to client");
        send(`data: ${JSON.stringify(eventForRole(event, role))}\n\n`);
      });

      // Send current presence roster to this client before registering them
      const snapshot = getPresence(sessionId);
      req.log.info({ sessionId, presenceCount: snapshot.length }, "[sse] sending presence snapshot");
      send(`data: ${JSON.stringify({ type: "presence.snapshot", payloadJson: { users: snapshot } })}\n\n`);

      // Register presence — broadcasts presence.join to all subscribers including this client
      addPresence(sessionId, presenceUser);
      isPresent = true;

      keepAlive = setInterval(() => {
        if (isClosed) return;
        req.log.debug({ sessionId }, "[sse] ping");
        send(": ping\n\n");
      }, 25_000);
    },
  );
}
