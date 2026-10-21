import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { broadcast } from "../lib/broadcaster.js";
import { forbidden, notFound } from "../lib/http-errors.js";
import type { Event, Stroke } from "@prisma/client";
function conflict(msg = "Conflict") {
  return Object.assign(new Error(msg), { statusCode: 409 });
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

      let transactionResult: {
        stroke: Stroke;
        eventToBroadcast: Event | null;
      };

      try {
        transactionResult = await prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<Array<{ id: string; eventSequence: number }>>`
            SELECT id, "eventSequence"
            FROM "GameSession"
            WHERE id = ${sessionId}
            FOR UPDATE
          `;
          if (!locked) throw notFound("Session not found");

          const existing = await tx.stroke.findUnique({ where: { clientUuid } });
          if (existing) {
            if (existing.sessionId !== sessionId) {
              throw conflict("Stroke clientUuid already exists in another session");
            }
            return { stroke: existing, eventToBroadcast: null };
          }

          const stroke = await tx.stroke.create({
            data: {
              sessionId,
              userId: user.discordId,
              payloadJson: payloadJson as object,
              clientUuid,
            },
          });

          const nextSequence = (locked.eventSequence ?? 0) + 1;
          await tx.gameSession.update({
            where: { id: sessionId },
            data: { eventSequence: nextSequence },
          });

          const event = await tx.event.create({
            data: {
              sessionId,
              userId: user.discordId,
              sequence: nextSequence,
              type: "stroke.create",
              payloadJson: payloadJson as object,
              clientUuid: `stroke-create-${clientUuid}`,
              clientCreatedAt: new Date(),
            },
          });

          return { stroke, eventToBroadcast: event };
        });
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
          const existing = await prisma.stroke.findUnique({ where: { clientUuid } });
          if (existing) {
            if (existing.sessionId !== sessionId) {
              throw conflict("Stroke clientUuid already exists in another session");
            }
            transactionResult = { stroke: existing, eventToBroadcast: null };
          } else {
            throw conflict("Unique constraint conflict on stroke creation");
          }
        } else {
          throw err;
        }
      }

      if (transactionResult.eventToBroadcast) {
        const e = transactionResult.eventToBroadcast;
        req.log.info({ sessionId, eventId: e.id, clientUuid, sequence: e.sequence }, "[events] stroke.create event saved, broadcasting");
        broadcast(sessionId, {
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          sequence: e.sequence,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        });
      } else {
        req.log.info({ sessionId, clientUuid }, "[events] stroke already exists, skipping event write and broadcast");
      }

      return reply.status(201).send({
        id: transactionResult.stroke.id,
        clientUuid: transactionResult.stroke.clientUuid,
        userId: transactionResult.stroke.userId,
        payloadJson: transactionResult.stroke.payloadJson,
        createdAt: transactionResult.stroke.createdAt.toISOString(),
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

      let eventToBroadcast: Event | null = null;
      try {
        eventToBroadcast = await prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<Array<{ id: string; eventSequence: number }>>`
            SELECT id, "eventSequence"
            FROM "GameSession"
            WHERE id = ${sessionId}
            FOR UPDATE
          `;
          if (!locked) throw notFound("Session not found");

          const stroke = await tx.stroke.findUnique({ where: { clientUuid } });
          if (stroke && stroke.sessionId !== sessionId) {
            throw conflict("Stroke clientUuid belongs to another session");
          }

          const existingEvent = await tx.event.findUnique({
            where: { clientUuid: `stroke-delete-${clientUuid}` },
          });
          if (existingEvent) {
            if (existingEvent.sessionId !== sessionId) {
              throw conflict("Stroke delete event belongs to another session");
            }
            return null;
          }

          if (stroke) {
            if (stroke.deletedAt === null) {
              await tx.stroke.update({
                where: { clientUuid },
                data: { deletedAt: new Date() },
              });
            }
          } else {
            await tx.stroke.create({
              data: {
                sessionId,
                userId: user.discordId,
                clientUuid,
                payloadJson: {},
                deletedAt: new Date(),
              },
            });
          }

          const nextSequence = (locked.eventSequence ?? 0) + 1;
          await tx.gameSession.update({
            where: { id: sessionId },
            data: { eventSequence: nextSequence },
          });

          const event = await tx.event.create({
            data: {
              sessionId,
              userId: user.discordId,
              sequence: nextSequence,
              type: "stroke.delete",
              payloadJson: { clientUuid },
              clientUuid: `stroke-delete-${clientUuid}`,
              clientCreatedAt: new Date(),
            },
          });

          return event;
        });
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
          const existingEvent = await prisma.event.findUnique({
            where: { clientUuid: `stroke-delete-${clientUuid}` },
          });
          if (existingEvent && existingEvent.sessionId === sessionId) {
            eventToBroadcast = null;
          } else if (existingEvent && existingEvent.sessionId !== sessionId) {
            throw conflict("Stroke delete event belongs to another session");
          } else {
            throw conflict("Unique constraint conflict on stroke delete");
          }
        } else {
          throw err;
        }
      }

      if (eventToBroadcast) {
        const e = eventToBroadcast;
        req.log.info({ sessionId, eventId: e.id, clientUuid, sequence: e.sequence }, "[events] stroke.delete event saved, broadcasting");
        broadcast(sessionId, {
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          sequence: e.sequence,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        });
      } else {
        req.log.info({ sessionId, clientUuid }, "[events] stroke delete already processed, skipping broadcast");
      }

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
              ordinal: Type.Integer({ minimum: 0, maximum: 2147483647 }),
              payloadJson: Type.Unknown(),
            }),
          ),
          replacementId: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await assertParticipant(sessionId, user.discordId);

      const { questions: incoming, replacementId } = req.body as {
        questions: Array<{ clientUuid: string; ordinal: number; payloadJson: unknown }>;
        replacementId: string;
      };

      let eventToBroadcast: Event | null = null;
      try {
        eventToBroadcast = await prisma.$transaction(async (tx) => {
          const [locked] = await tx.$queryRaw<Array<{ id: string; eventSequence: number }>>`
            SELECT id, "eventSequence"
            FROM "GameSession"
            WHERE id = ${sessionId}
            FOR UPDATE
          `;
          if (!locked) throw notFound("Session not found");

          const existingEvent = await tx.event.findUnique({
            where: { clientUuid: `questions-replace-${replacementId}` },
          });
          if (existingEvent) {
            if (existingEvent.sessionId !== sessionId) {
              throw conflict("Question replacementId belongs to another session");
            }
            return null;
          }

          await tx.sessionQuestion.deleteMany({ where: { sessionId } });
          if (incoming.length > 0) {
            await tx.sessionQuestion.createMany({
              data: incoming.map((q) => ({
                sessionId,
                clientUuid: q.clientUuid,
                ordinal: q.ordinal,
                payloadJson: q.payloadJson as object,
              })),
            });
          }

          const nextSequence = (locked.eventSequence ?? 0) + 1;
          await tx.gameSession.update({
            where: { id: sessionId },
            data: { eventSequence: nextSequence },
          });

          const event = await tx.event.create({
            data: {
              sessionId,
              userId: user.discordId,
              sequence: nextSequence,
              type: "questions.replace",
              payloadJson: { replacementId, questions: incoming } as object,
              clientUuid: `questions-replace-${replacementId}`,
              clientCreatedAt: new Date(),
            },
          });
          return event;
        });
      } catch (err: unknown) {
        if (replacementId && typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
          const existingEvent = await prisma.event.findUnique({
            where: { clientUuid: `questions-replace-${replacementId}` },
          });
          if (existingEvent && existingEvent.sessionId === sessionId) {
            eventToBroadcast = null;
          } else if (existingEvent && existingEvent.sessionId !== sessionId) {
            throw conflict("Question replacementId belongs to another session");
          } else {
            throw conflict("Unique constraint conflict on question replacement");
          }
        } else {
          throw err;
        }
      }

      if (eventToBroadcast) {
        const e = eventToBroadcast;
        req.log.info({ sessionId, eventId: e.id, replacementId, sequence: e.sequence }, "[events] questions.replace event saved, broadcasting");
        broadcast(sessionId, {
          id: e.id,
          sessionId: e.sessionId,
          userId: e.userId,
          sequence: e.sequence,
          type: e.type,
          payloadJson: e.payloadJson,
          clientUuid: e.clientUuid,
          clientCreatedAt: e.clientCreatedAt.toISOString(),
          serverReceivedAt: e.serverReceivedAt.toISOString(),
        });
      } else {
        req.log.info({ sessionId, replacementId }, "[events] questions.replace duplicate skipped broadcast");
      }

      return reply.status(204).send();
    },
  );
}
