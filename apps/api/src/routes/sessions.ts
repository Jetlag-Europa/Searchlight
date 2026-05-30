import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { broadcast } from "../lib/broadcaster.js";

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
          hiderLat: s.hiderLat,
          hiderLng: s.hiderLng,
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
        hiderLat: null,
        hiderLng: null,
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
        const [originalSession, snapshot] = await Promise.all([
          prisma.gameSession.findUniqueOrThrow({ where: { id: invite.sessionId } }),
          prisma.inviteSnapshot.findUnique({ where: { inviteId } }),
        ]);
        const questions = (snapshot?.questions ?? []) as Array<{ payloadJson: object; ordinal: number; clientUuid: string }>;

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
                payloadJson: q.payloadJson,
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
        hiderLat: session.hiderLat,
        hiderLng: session.hiderLng,
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
          hiderLat: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
          hiderLng: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);

      const body = req.body as {
        name?: string;
        visibility?: "private" | "shared";
        hiderLat?: number | null;
        hiderLng?: number | null;
      };

      // name and visibility are creator-only; hiderLat/hiderLng any participant can update
      if ((body.name !== undefined || body.visibility !== undefined) && !isCreator) {
        throw forbidden("Only the creator can update the session name or visibility");
      }

      const updated = await prisma.gameSession.update({
        where: { id: sessionId },
        data: body,
        include: { game: { select: { name: true } } },
      });

      if (body.hiderLat !== undefined || body.hiderLng !== undefined) {
        broadcast(sessionId, {
          type: "hider.update",
          payloadJson: { hiderLat: updated.hiderLat, hiderLng: updated.hiderLng },
        });
      }

      return {
        id: updated.id,
        gameId: updated.gameId,
        gameName: updated.game.name,
        serverId: updated.serverId,
        name: updated.name,
        visibility: updated.visibility,
        role: isCreator ? "creator" : "member",
        createdAt: updated.createdAt.toISOString(),
        hiderLat: updated.hiderLat,
        hiderLng: updated.hiderLng,
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
          inviteType: i.inviteType as "join" | "fork",
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

      let invite;
      if (inviteType === "fork") {
        const questions = await prisma.sessionQuestion.findMany({
          where: { sessionId },
          orderBy: { ordinal: "asc" },
          select: { payloadJson: true, ordinal: true, clientUuid: true },
        });
        invite = await prisma.$transaction(async (tx) => {
          const created = await tx.invite.create({
            data: { sessionId, invitedUserId, invitedByUserId: user.discordId, inviteType },
          });
          await tx.inviteSnapshot.create({
            data: { inviteId: created.id, questions },
          });
          return created;
        });
      } else {
        invite = await prisma.invite.create({
          data: { sessionId, invitedUserId, invitedByUserId: user.discordId, inviteType },
        });
      }

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

  // POST /sessions/:sessionId/links — create a share/invite link (creator only)
  app.post(
    "/:sessionId/links",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          linkType: Type.Union([Type.Literal("join"), Type.Literal("fork")]),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { linkType } = req.body as { linkType: "join" | "fork" };
      const { session, isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can create links");

      const token = randomBytes(16).toString("hex");

      if (linkType === "fork") {
        const questions = await prisma.sessionQuestion.findMany({
          where: { sessionId },
          orderBy: { ordinal: "asc" },
          select: { payloadJson: true, ordinal: true, clientUuid: true },
        });
        const link = await prisma.$transaction(async (tx) => {
          const created = await tx.sessionLink.create({
            data: { token, sessionId, createdById: user.discordId, linkType },
          });
          await tx.linkSnapshot.create({ data: { linkId: created.id, questions } });
          return created;
        });
        req.log.info({ sessionId, linkId: link.id }, "[links] fork link created");
        return reply.status(201).send({ id: link.id, token: link.token });
      }

      // join: promote to shared if private
      if (session.visibility === "private") {
        await prisma.gameSession.update({ where: { id: sessionId }, data: { visibility: "shared" } });
      }
      const link = await prisma.sessionLink.create({
        data: { token, sessionId, createdById: user.discordId, linkType },
      });
      req.log.info({ sessionId, linkId: link.id }, "[links] join link created");
      return reply.status(201).send({ id: link.id, token: link.token });
    },
  );

  // GET /sessions/:sessionId/links — list active links (creator only)
  app.get(
    "/:sessionId/links",
    { schema: { params: Type.Object({ sessionId: Type.String() }) } },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can view links");

      const links = await prisma.sessionLink.findMany({
        where: { sessionId, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });

      return {
        links: links.map((l) => ({
          id: l.id,
          token: l.token,
          linkType: l.linkType as "join" | "fork",
          createdAt: l.createdAt.toISOString(),
        })),
      };
    },
  );

  // DELETE /sessions/:sessionId/links/:linkId — revoke a link (creator only)
  app.delete(
    "/:sessionId/links/:linkId",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String(), linkId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId, linkId } = req.params as { sessionId: string; linkId: string };
      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) throw forbidden("Only the creator can revoke links");

      const link = await prisma.sessionLink.findUnique({ where: { id: linkId } });
      if (!link || link.sessionId !== sessionId) throw notFound("Link not found");

      await prisma.sessionLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
      return reply.status(204).send();
    },
  );
}
