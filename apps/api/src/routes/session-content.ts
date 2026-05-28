import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";

function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}

async function assertParticipant(sessionId: string, userId: string) {
  const session = await prisma.gameSession.findUnique({ where: { id: sessionId } });
  if (!session) throw notFound("Session not found");

  const isCreator = session.creatorId === userId;
  if (isCreator) return session;

  const participant = await prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });

  if (!participant || participant.acceptedAt === null || participant.revokedAt !== null) {
    throw forbidden();
  }

  return session;
}

export async function sessionContentRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/strokes
  app.get(
    "/:sessionId/strokes",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const strokes = await prisma.stroke.findMany({
        where: { sessionId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });

      return {
        strokes: strokes.map((s) => ({
          id: s.id,
          clientUuid: s.clientUuid,
          userId: s.userId,
          payloadJson: s.payloadJson,
          createdAt: s.createdAt.toISOString(),
        })),
      };
    },
  );

  // POST /sessions/:sessionId/strokes
  app.post(
    "/:sessionId/strokes",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          clientUuid: Type.String({ minLength: 1 }),
          payloadJson: Type.Unknown(),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const { clientUuid, payloadJson } = req.body as { clientUuid: string; payloadJson: unknown };

      const existing = await prisma.stroke.findUnique({ where: { clientUuid } });
      const stroke = await prisma.stroke.upsert({
        where: { clientUuid },
        update: {},
        create: {
          sessionId,
          userId: user.discordId,
          payloadJson: payloadJson as object,
          clientUuid,
        },
      });

      if (!existing) {
        prisma.event.upsert({
          where: { clientUuid: `stroke-create-${clientUuid}` },
          update: {},
          create: {
            sessionId,
            userId: user.discordId,
            type: "stroke.create",
            payloadJson: payloadJson as object,
            clientUuid: `stroke-create-${clientUuid}`,
            clientCreatedAt: new Date(),
          },
        }).catch((e: unknown) => req.log.warn({ err: e }, "[events] stroke.create write failed"));
      }

      return reply.status(201).send({
        id: stroke.id,
        clientUuid: stroke.clientUuid,
        userId: stroke.userId,
        payloadJson: stroke.payloadJson,
        createdAt: stroke.createdAt.toISOString(),
      });
    },
  );

  // DELETE /sessions/:sessionId/strokes/:clientUuid — soft delete
  app.delete(
    "/:sessionId/strokes/:clientUuid",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String(), clientUuid: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId, clientUuid } = req.params as { sessionId: string; clientUuid: string };
      await assertParticipant(sessionId, user.discordId);

      await prisma.stroke.updateMany({
        where: { clientUuid, sessionId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      prisma.event.upsert({
        where: { clientUuid: `stroke-delete-${clientUuid}` },
        update: {},
        create: {
          sessionId,
          userId: user.discordId,
          type: "stroke.delete",
          payloadJson: { clientUuid },
          clientUuid: `stroke-delete-${clientUuid}`,
          clientCreatedAt: new Date(),
        },
      }).catch((e: unknown) => req.log.warn({ err: e }, "[events] stroke.delete write failed"));

      return reply.status(204).send();
    },
  );

  // GET /sessions/:sessionId/questions
  app.get(
    "/:sessionId/questions",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const questions = await prisma.sessionQuestion.findMany({
        where: { sessionId },
        orderBy: { ordinal: "asc" },
      });

      return {
        questions: questions.map((q) => ({
          clientUuid: q.clientUuid,
          ordinal: q.ordinal,
          payloadJson: q.payloadJson,
        })),
      };
    },
  );

  // PUT /sessions/:sessionId/questions — full replacement
  app.put(
    "/:sessionId/questions",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          questions: Type.Array(
            Type.Object({
              clientUuid: Type.String({ minLength: 1 }),
              ordinal: Type.Number({ minimum: 0 }),
              payloadJson: Type.Unknown(),
            }),
          ),
          replacementId: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const { questions: incoming, replacementId } = req.body as {
        questions: Array<{ clientUuid: string; ordinal: number; payloadJson: unknown }>;
        replacementId?: string;
      };

      await prisma.$transaction([
        prisma.sessionQuestion.deleteMany({ where: { sessionId } }),
        prisma.sessionQuestion.createMany({
          data: incoming.map((q) => ({
            sessionId,
            clientUuid: q.clientUuid,
            ordinal: q.ordinal,
            payloadJson: q.payloadJson as object,
          })),
        }),
      ]);

      if (replacementId) {
        prisma.event.upsert({
          where: { clientUuid: `questions-replace-${replacementId}` },
          update: {},
          create: {
            sessionId,
            userId: user.discordId,
            type: "questions.replace",
            payloadJson: { replacementId, questions: incoming } as object,
            clientUuid: `questions-replace-${replacementId}`,
            clientCreatedAt: new Date(),
          },
        }).catch((e: unknown) => req.log.warn({ err: e }, "[events] questions.replace write failed"));
      }

      return reply.status(204).send();
    },
  );
}
