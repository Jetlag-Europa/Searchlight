import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function notFound(msg = "Not found") {
  return Object.assign(new Error(msg), { statusCode: 404 });
}
function forbidden(msg = "Forbidden") {
  return Object.assign(new Error(msg), { statusCode: 403 });
}
function conflict(msg: string) {
  return Object.assign(new Error(msg), { statusCode: 409 });
}

async function resolveParticipant(sessionId: string, userId: string) {
  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include: { game: { select: { name: true } } },
  });
  if (!session) throw notFound("Session not found");

  const participant = await prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });

  const isCreator = session.creatorId === userId;
  const isActiveParticipant =
    participant &&
    participant.acceptedAt !== null &&
    participant.revokedAt === null;

  if (!isCreator && !isActiveParticipant) {
    throw forbidden();
  }

  return { session, participant, isCreator };
}

// ── route module ──────────────────────────────────────────────────────────────

export async function sessionRoutes(app: FastifyInstance) {
  // GET /sessions?serverId= — list sessions accessible to the authed user
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({ serverId: Type.String({ minLength: 1 }) }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.query as { serverId: string };

      // Sessions where user is creator OR shared+accepted participant
      const sessions = await prisma.gameSession.findMany({
        where: {
          serverId,
          OR: [
            { creatorId: user.discordId },
            {
              visibility: "shared",
              participants: {
                some: {
                  userId: user.discordId,
                  acceptedAt: { not: null },
                  revokedAt: null,
                },
              },
            },
          ],
        },
        include: {
          game: { select: { name: true } },
          participants: {
            where: { userId: user.discordId },
            select: { role: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          gameId: s.gameId,
          gameName: s.game.name,
          serverId: s.serverId,
          name: s.name,
          visibility: s.visibility,
          role: s.participants[0]?.role ?? "creator",
          createdAt: s.createdAt.toISOString(),
        })),
      };
    },
  );

  // POST /sessions — create a session
  app.post(
    "/",
    {
      schema: {
        body: Type.Object({
          gameId: Type.String({ minLength: 1 }),
          name: Type.String({ minLength: 1 }),
          visibility: Type.Union([Type.Literal("private"), Type.Literal("shared")]),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId, name, visibility } = req.body as {
        gameId: string;
        name: string;
        visibility: "private" | "shared";
      };

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game) throw notFound("Game not found");

      const session = await prisma.$transaction(async (tx) => {
        const s = await tx.gameSession.create({
          data: {
            gameId,
            serverId: game.serverId,
            creatorId: user.discordId,
            name,
            visibility,
          },
        });
        await tx.sessionParticipant.create({
          data: {
            sessionId: s.id,
            userId: user.discordId,
            role: "creator",
            acceptedAt: new Date(),
          },
        });
        return s;
      });

      return reply.status(201).send({
        id: session.id,
        gameId: session.gameId,
        gameName: game.name,
        serverId: session.serverId,
        name: session.name,
        visibility: session.visibility,
        role: "creator",
        createdAt: session.createdAt.toISOString(),
      });
    },
  );

  // GET /sessions/pending-invites — pending invites for the authed user
  // NOTE: this route must be registered before /:sessionId routes to avoid conflicts
  app.get(
    "/pending-invites",
    {},
    async (req) => {
      const { user } = await resolveSession(req);

      const invites = await prisma.invite.findMany({
        where: {
          invitedUserId: user.discordId,
          acceptedAt: null,
          declinedAt: null,
          revokedAt: null,
        },
        include: {
          session: { include: { game: { select: { name: true } } } },
          invitedBy: { select: { displayName: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return {
        invites: invites.map((i) => ({
          id: i.id,
          sessionId: i.sessionId,
          sessionName: i.session.name,
          gameName: i.session.game.name,
          invitedByDisplayName: i.invitedBy.displayName,
          inviteType: i.inviteType as "join" | "fork",
          createdAt: i.createdAt.toISOString(),
        })),
      };
    },
  );

  // POST /sessions/invites/:inviteId/accept
  app.post(
    "/invites/:inviteId/accept",
    {
      schema: {
        params: Type.Object({ inviteId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { inviteId } = req.params as { inviteId: string };

      const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
      if (!invite) throw notFound("Invite not found");
      if (invite.invitedUserId !== user.discordId) throw forbidden();
      if (invite.revokedAt || invite.declinedAt || invite.acceptedAt) {
        throw conflict("Invite is no longer pending");
      }

      if (invite.inviteType === "fork") {
        const [originalSession, questions] = await Promise.all([
          prisma.gameSession.findUniqueOrThrow({ where: { id: invite.sessionId } }),
          prisma.sessionQuestion.findMany({
            where: { sessionId: invite.sessionId },
            orderBy: { ordinal: "asc" },
          }),
        ]);

        const newSession = await prisma.$transaction(async (tx) => {
          const created = await tx.gameSession.create({
            data: {
              gameId: originalSession.gameId,
              serverId: originalSession.serverId,
              creatorId: user.discordId,
              name: `Copy of ${originalSession.name}`,
              visibility: "private",
            },
          });
          if (questions.length > 0) {
            await tx.sessionQuestion.createMany({
              data: questions.map((q) => ({
                sessionId: created.id,
                payloadJson: q.payloadJson as object,
                ordinal: q.ordinal,
                clientUuid: `fork-${created.id}-${q.clientUuid}`,
              })),
            });
          }
          await tx.invite.update({ where: { id: inviteId }, data: { acceptedAt: new Date() } });
          return created;
        });

        req.log.info({ inviteId, newSessionId: newSession.id, userId: user.discordId }, "[invites] fork invite accepted — new session created");
        return reply.status(200).send({ sessionId: newSession.id });
      }

      await prisma.$transaction([
        prisma.invite.update({
          where: { id: inviteId },
          data: { acceptedAt: new Date() },
        }),
        prisma.sessionParticipant.upsert({
          where: { sessionId_userId: { sessionId: invite.sessionId, userId: user.discordId } },
          update: { acceptedAt: new Date(), revokedAt: null },
          create: {
            sessionId: invite.sessionId,
            userId: user.discordId,
            role: "member",
            acceptedAt: new Date(),
          },
        }),
      ]);

      return reply.status(204).send();
    },
  );

  // POST /sessions/invites/:inviteId/decline
  app.post(
    "/invites/:inviteId/decline",
    {
      schema: {
        params: Type.Object({ inviteId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { inviteId } = req.params as { inviteId: string };

      const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
      if (!invite) throw notFound("Invite not found");
      if (invite.invitedUserId !== user.discordId) throw forbidden();
      if (invite.revokedAt || invite.declinedAt || invite.acceptedAt) {
        throw conflict("Invite is no longer pending");
      }

      await prisma.invite.update({ where: { id: inviteId }, data: { declinedAt: new Date() } });
      return reply.status(204).send();
    },
  );

  // GET /sessions/:sessionId
  app.get(
    "/:sessionId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };

      const { session } = await resolveParticipant(sessionId, user.discordId);

      const participants = await prisma.sessionParticipant.findMany({
        where: { sessionId, revokedAt: null, acceptedAt: { not: null } },
        include: { user: { select: { discordId: true, displayName: true, avatarUrl: true } } },
      });

      // Also include creator even if their acceptedAt setup differs
      const creatorEntry = await prisma.sessionParticipant.findUnique({
        where: { sessionId_userId: { sessionId, userId: session.creatorId } },
        include: { user: { select: { discordId: true, displayName: true, avatarUrl: true } } },
      });

      const allParticipants = [
        ...(creatorEntry ? [creatorEntry] : []),
        ...participants.filter((p) => p.userId !== session.creatorId),
      ];

      return {
        id: session.id,
        gameId: session.gameId,
        gameName: session.game.name,
        serverId: session.serverId,
        name: session.name,
        visibility: session.visibility,
        role: session.creatorId === user.discordId ? "creator" : "member",
        createdAt: session.createdAt.toISOString(),
        participants: allParticipants.map((p) => ({
          userId: p.userId,
          displayName: p.user.displayName,
          avatarUrl: p.user.avatarUrl,
          role: p.role,
          acceptedAt: p.acceptedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  // PATCH /sessions/:sessionId
  app.patch(
    "/:sessionId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          name: Type.Optional(Type.String({ minLength: 1 })),
          visibility: Type.Optional(
            Type.Union([Type.Literal("private"), Type.Literal("shared")]),
          ),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can update the session");

      const body = req.body as { name?: string; visibility?: "private" | "shared" };
      const updated = await prisma.gameSession.update({
        where: { id: sessionId },
        data: body,
        include: { game: { select: { name: true } } },
      });

      return {
        id: updated.id,
        gameId: updated.gameId,
        gameName: updated.game.name,
        serverId: updated.serverId,
        name: updated.name,
        visibility: updated.visibility,
        role: "creator",
        createdAt: updated.createdAt.toISOString(),
      };
    },
  );

  // DELETE /sessions/:sessionId
  app.delete(
    "/:sessionId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can delete the session");

      await prisma.gameSession.delete({ where: { id: sessionId } });
      return reply.status(204).send();
    },
  );

  // GET /sessions/:sessionId/participants
  app.get(
    "/:sessionId/participants",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      await resolveParticipant(sessionId, user.discordId);

      const participants = await prisma.sessionParticipant.findMany({
        where: { sessionId, revokedAt: null },
        include: { user: { select: { discordId: true, displayName: true, avatarUrl: true } } },
      });

      return {
        participants: participants.map((p) => ({
          userId: p.userId,
          displayName: p.user.displayName,
          avatarUrl: p.user.avatarUrl,
          role: p.role,
          acceptedAt: p.acceptedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  // DELETE /sessions/:sessionId/participants/:userId — kick (soft delete)
  app.delete(
    "/:sessionId/participants/:userId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String(), userId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId, userId: targetUserId } = req.params as {
        sessionId: string;
        userId: string;
      };

      const { session, isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can kick participants");
      if (targetUserId === session.creatorId) throw forbidden("Cannot kick the session creator");

      await prisma.sessionParticipant.update({
        where: { sessionId_userId: { sessionId, userId: targetUserId } },
        data: { revokedAt: new Date() },
      });

      return reply.status(204).send();
    },
  );

  // GET /sessions/:sessionId/invites — list pending invites (creator only)
  app.get(
    "/:sessionId/invites",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can view invites");

      const invites = await prisma.invite.findMany({
        where: { sessionId, revokedAt: null, acceptedAt: null, declinedAt: null },
        include: {
          invitedUser: { select: { discordId: true, displayName: true } },
          invitedBy: { select: { discordId: true } },
        },
      });

      return {
        invites: invites.map((i) => ({
          id: i.id,
          invitedUserId: i.invitedUserId,
          invitedUserDisplayName: i.invitedUser.displayName,
          invitedByUserId: i.invitedByUserId,
          createdAt: i.createdAt.toISOString(),
        })),
      };
    },
  );

  // POST /sessions/:sessionId/invites — send invite (creator only)
  app.post(
    "/:sessionId/invites",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          invitedUserId: Type.String({ minLength: 1 }),
          inviteType: Type.Optional(Type.Union([Type.Literal("join"), Type.Literal("fork")])),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { invitedUserId, inviteType = "join" } = req.body as { invitedUserId: string; inviteType?: "join" | "fork" };

      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can send invites");
      if (invitedUserId === user.discordId) throw conflict("Cannot invite yourself");

      const existing = await prisma.invite.findFirst({
        where: {
          sessionId,
          invitedUserId,
          revokedAt: null,
          acceptedAt: null,
          declinedAt: null,
        },
      });
      if (existing) throw conflict("An active invite already exists for this user");

      const invite = await prisma.invite.create({
        data: {
          sessionId,
          invitedUserId,
          invitedByUserId: user.discordId,
          inviteType,
        },
      });

      return reply.status(201).send({ id: invite.id, createdAt: invite.createdAt.toISOString() });
    },
  );

  // DELETE /sessions/:sessionId/leave — participant leaves a shared session
  app.delete(
    "/:sessionId/leave",
    {
      schema: { params: Type.Object({ sessionId: Type.String() }) },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };

      const { session, isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (isCreator) throw forbidden("Session creator cannot leave — delete the session instead");

      await prisma.sessionParticipant.update({
        where: { sessionId_userId: { sessionId, userId: user.discordId } },
        data: { revokedAt: new Date() },
      });

      req.log.info({ sessionId, userId: user.discordId }, "[sessions] participant left session");
      void session;
      return reply.status(204).send();
    },
  );

  // DELETE /sessions/:sessionId/invites/:inviteId — revoke invite (creator only)
  app.delete(
    "/:sessionId/invites/:inviteId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String(), inviteId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId, inviteId } = req.params as { sessionId: string; inviteId: string };

      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can revoke invites");

      const invite = await prisma.invite.findUnique({ where: { id: inviteId } });
      if (!invite || invite.sessionId !== sessionId) throw notFound("Invite not found");

      await prisma.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
      return reply.status(204).send();
    },
  );
}
