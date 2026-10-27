import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { assertGameAccess, findGameByIdOrKey, isUnlisted } from "../lib/game-access.js";
import { forbidden, notFound } from "../lib/http-errors.js";
import { broadcast, closeUserStreams, closeSessionStreams } from "../lib/broadcaster.js";
import type { Event } from "@prisma/client";

// ── helpers ───────────────────────────────────────────────────────────────────

function conflict(msg: string) {
  return Object.assign(new Error(msg), { statusCode: 409 });
}

const nullableNumber = Type.Unsafe<number | null>({ type: ["number", "null"] });

async function resolveParticipant(sessionId: string, userId: string) {
  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include: {
      game: {
        select: {
          name: true,
          unlisted: true,
          createdById: true,
          currentRevisionId: true,
          currentRevision: { select: { id: true, revision: true } },
        },
      },
      gameRevision: { select: { id: true, revision: true } },
    },
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

/**
 * Throws 403 unless the user may move the session to `revisionId`, the game's
 * current revision: either they may use the game, or the session was started
 * from a game link that is still active (the link grants what it did then).
 */
async function assertUpgradeAccess(
  userId: string,
  session: {
    gameId: string;
    serverId: string;
    gameLinkId: string | null;
    game: { unlisted: boolean; createdById: string | null };
  },
  revisionId: string | null,
  logger: FastifyBaseLogger,
) {
  if (session.gameLinkId) {
    const link = await prisma.gameLink.findUnique({
      where: { id: session.gameLinkId },
      select: { gameId: true, revokedAt: true },
    });
    if (link && !link.revokedAt && link.gameId === session.gameId) return;
  }
  await assertGameAccess(
    userId,
    { serverId: session.serverId, unlisted: session.game.unlisted, createdById: session.game.createdById },
    [revisionId],
    logger,
  );
}

/**
 * Creates a session pinned to `revision` with its creator as participant and
 * returns its summary. Callers check access to the game first.
 */
export async function createSession({
  game,
  revision,
  creatorId,
  name,
  visibility,
  gameLinkId,
}: {
  game: {
    id: string;
    serverId: string;
    name: string;
    currentRevisionId: string | null;
    currentRevision: { revision: number } | null;
  };
  revision: { id: string; revision: number };
  creatorId: string;
  name: string;
  visibility: "private" | "shared";
  gameLinkId?: string;
}) {
  const session = await prisma.$transaction(async (tx) => {
    const s = await tx.gameSession.create({
      data: {
        gameId: game.id,
        serverId: game.serverId,
        creatorId,
        name,
        visibility,
        gameRevisionId: revision.id,
        gameLinkId,
      },
    });
    await tx.sessionParticipant.create({
      data: {
        sessionId: s.id,
        userId: creatorId,
        role: "creator",
        acceptedAt: new Date(),
      },
    });
    return s;
  });

  return {
    id: session.id,
    gameId: session.gameId,
    gameName: game.name,
    serverId: session.serverId,
    name: session.name,
    visibility: session.visibility,
    role: "creator" as const,
    createdAt: session.createdAt.toISOString(),
    hiderLat: null,
    hiderLng: null,
    planningModeEnabled: false,
    gameRevisionId: session.gameRevisionId,
    sessionRevision: revision.revision,
    currentRevision: game.currentRevision?.revision ?? null,
    hasNewerRevision: Boolean(
      game.currentRevisionId && revision.id !== game.currentRevisionId,
    ),
  };
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
          game: {
            select: {
              name: true,
              currentRevisionId: true,
              currentRevision: { select: { revision: true } },
            },
          },
          gameRevision: { select: { revision: true } },
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
          planningModeEnabled: s.planningModeEnabled,
          gameRevisionId: s.gameRevisionId,
          sessionRevision: s.gameRevision.revision,
          currentRevision: s.game.currentRevision?.revision ?? null,
          hasNewerRevision: Boolean(
            s.game.currentRevisionId &&
              s.gameRevisionId !== s.game.currentRevisionId,
          ),
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
          // Sessions become shared when the creator makes a join link, so
          // the web app no longer sends this; older clients still may.
          visibility: Type.Optional(
            Type.Union([Type.Literal("private"), Type.Literal("shared")]),
          ),
          gameRevisionId: Type.Optional(Type.String({ minLength: 1 })),
        }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId, name, visibility = "private", gameRevisionId } = req.body as {
        gameId: string;
        name: string;
        visibility?: "private" | "shared";
        gameRevisionId?: string;
      };

      const game = await findGameByIdOrKey(gameId, {
        currentRevision: { select: { id: true, revision: true } },
      });
      if (!game) throw notFound("Game not found");
      // For everyone, game managers included; GET /games leaves them out too.
      if (isUnlisted(game)) {
        throw forbidden("This game is unlisted; start sessions of it from a game link");
      }

      let targetRevision: { id: string; revision: number };
      if (gameRevisionId) {
        const rev = await prisma.gameRevision.findFirst({
          where: { id: gameRevisionId, gameId: game.id },
          select: { id: true, revision: true },
        });
        if (!rev) {
          throw Object.assign(new Error("Specified game revision not found for this game"), {
            statusCode: 400,
          });
        }
        targetRevision = rev;
      } else {
        if (!game.currentRevision) {
          throw Object.assign(
            new Error("Game has no available revision; an imported JSON revision is required"),
            { statusCode: 400 },
          );
        }
        targetRevision = game.currentRevision;
      }

      // A session's participants may read the revision it is pinned to, so
      // creating one requires the access that reading the game does.
      await assertGameAccess(
        user.discordId,
        game,
        [targetRevision.id, game.currentRevisionId],
        req.log,
      );

      const session = await createSession({
        game,
        revision: targetRevision,
        creatorId: user.discordId,
        name,
        visibility,
      });
      return reply.status(201).send(session);
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
        planningModeEnabled: session.planningModeEnabled,
        gameRevisionId: session.gameRevisionId,
        sessionRevision: session.gameRevision.revision,
        currentRevision: session.game.currentRevision?.revision ?? null,
        hasNewerRevision: Boolean(
          session.game.currentRevisionId &&
            session.gameRevisionId !== session.game.currentRevisionId,
        ),
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

  // POST /sessions/:sessionId/upgrade-revision
  app.post(
    "/:sessionId/upgrade-revision",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };

      const { session, isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (!isCreator) {
        throw Object.assign(
          new Error("Only the session creator can upgrade the game revision"),
          { statusCode: 403 },
        );
      }

      // Upgrading shares the game's current revision with every participant,
      // so it requires the access that reading that revision does.
      let checkedRevisionId = session.game.currentRevisionId;
      await assertUpgradeAccess(user.discordId, session, checkedRevisionId, req.log);

      type UpgradeResult = {
        status: "already-current" | "upgraded";
        previousRevision: number;
        newRevision: number;
        gameRevisionId: string;
        eventToBroadcast: Event | null;
      };
      type UpgradeAttempt =
        | UpgradeResult
        | { status: "revision-changed"; gameRevisionId: string };

      const attemptUpgrade = () => prisma.$transaction(async (tx): Promise<UpgradeAttempt> => {
        const [lockedSession] = await tx.$queryRaw<Array<{ id: string; gameRevisionId: string; eventSequence: number }>>`
          SELECT id, "gameRevisionId", "eventSequence"
          FROM "GameSession"
          WHERE id = ${sessionId}
          FOR UPDATE
        `;
        if (!lockedSession) throw notFound("Session not found");

        // Resolve the target only after serializing session transitions. A request
        // delayed before the lock must not apply an obsolete published revision.
        const game = await tx.game.findUnique({
          where: { id: session.gameId },
          include: { currentRevision: { select: { id: true, revision: true } } },
        });
        if (!game?.currentRevision) {
          throw notFound("No current revision found for this game");
        }
        const targetRevision = game.currentRevision;
        if (targetRevision.id !== checkedRevisionId) {
          // Published while this request waited for the lock. Its access
          // check can call Discord, so it runs after the lock is released.
          return { status: "revision-changed", gameRevisionId: targetRevision.id };
        }

        if (lockedSession.gameRevisionId === targetRevision.id) {
          return {
            status: "already-current",
            previousRevision: targetRevision.revision,
            newRevision: targetRevision.revision,
            gameRevisionId: targetRevision.id,
            eventToBroadcast: null,
          };
        }

        const previousRevision = await tx.gameRevision.findUniqueOrThrow({
          where: { id: lockedSession.gameRevisionId },
          select: { revision: true },
        });

        const nextSequence = (lockedSession.eventSequence ?? 0) + 1;
        await tx.gameSession.update({
          where: { id: sessionId },
          data: {
            gameRevisionId: targetRevision.id,
            eventSequence: nextSequence,
          },
        });

        const event = await tx.event.create({
          data: {
            sessionId,
            userId: user.discordId,
            sequence: nextSequence,
            type: "session.revision-upgraded",
            payloadJson: {
              sessionId,
              gameRevisionId: targetRevision.id,
              revision: targetRevision.revision,
            },
            clientUuid: `session-revision-upgraded-${sessionId}-${nextSequence}`,
            clientCreatedAt: new Date(),
          },
        });

        return {
          status: "upgraded",
          previousRevision: previousRevision.revision,
          newRevision: targetRevision.revision,
          gameRevisionId: targetRevision.id,
          eventToBroadcast: event,
        };
      });

      let upgradeResult = await attemptUpgrade();
      for (let retries = 0; upgradeResult.status === "revision-changed"; retries++) {
        if (retries === 2) {
          throw conflict("The game was updated while upgrading; try again");
        }
        checkedRevisionId = upgradeResult.gameRevisionId;
        await assertUpgradeAccess(user.discordId, session, checkedRevisionId, req.log);
        upgradeResult = await attemptUpgrade();
      }

      if (upgradeResult.eventToBroadcast) {
        const e = upgradeResult.eventToBroadcast;
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
      }

      if (upgradeResult.status === "already-current") {
        return reply.send({
          status: "already-current",
          newRevision: upgradeResult.newRevision,
          gameRevisionId: upgradeResult.gameRevisionId,
        });
      }

      return reply.send({
        status: "upgraded",
        previousRevision: upgradeResult.previousRevision,
        newRevision: upgradeResult.newRevision,
        gameRevisionId: upgradeResult.gameRevisionId,
      });
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
          // One type list, not a union: Ajv coerces types, so a union's first
          // branch would turn a cleared position (null) into 0, or a 0 into
          // null. With a list it coerces only values neither type matches.
          hiderLat: Type.Optional(nullableNumber),
          hiderLng: Type.Optional(nullableNumber),
          planningModeEnabled: Type.Optional(Type.Boolean()),
        }, { additionalProperties: false }),
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
        planningModeEnabled?: boolean;
      };

      // name and visibility are creator-only; hiderLat/hiderLng any participant can update
      if ((body.name !== undefined || body.visibility !== undefined) && !isCreator) {
        throw forbidden("Only the creator can update the session name or visibility");
      }

      const { updated, eventsToBroadcast } = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{
          id: string;
          eventSequence: number;
          hiderLat: number | null;
          hiderLng: number | null;
          planningModeEnabled: boolean;
        }>>`
          SELECT id, "eventSequence", "hiderLat", "hiderLng", "planningModeEnabled"
          FROM "GameSession"
          WHERE id = ${sessionId}
          FOR UPDATE
        `;
        if (!locked) throw notFound("Session not found");

        let curSequence = locked.eventSequence ?? 0;
        const events: Event[] = [];

        const hiderRequested = body.hiderLat !== undefined || body.hiderLng !== undefined;
        const newHiderLat = body.hiderLat !== undefined ? body.hiderLat : locked.hiderLat;
        const newHiderLng = body.hiderLng !== undefined ? body.hiderLng : locked.hiderLng;
        const hiderChanged = hiderRequested && (newHiderLat !== locked.hiderLat || newHiderLng !== locked.hiderLng);

        const planningRequested = body.planningModeEnabled !== undefined;
        const newPlanning = planningRequested ? body.planningModeEnabled : locked.planningModeEnabled;
        const planningChanged = planningRequested && newPlanning !== locked.planningModeEnabled;

        if (hiderChanged) {
          curSequence += 1;
          const hiderEvent = await tx.event.create({
            data: {
              sessionId,
              userId: user.discordId,
              sequence: curSequence,
              type: "hider.update",
              payloadJson: { hiderLat: newHiderLat, hiderLng: newHiderLng },
              clientUuid: `hider-update-${sessionId}-${curSequence}`,
              clientCreatedAt: new Date(),
            },
          });
          events.push(hiderEvent);
        }

        if (planningChanged) {
          curSequence += 1;
          const planningEvent = await tx.event.create({
            data: {
              sessionId,
              userId: user.discordId,
              sequence: curSequence,
              type: "planning.toggle",
              payloadJson: { planningModeEnabled: newPlanning },
              clientUuid: `planning-toggle-${sessionId}-${curSequence}`,
              clientCreatedAt: new Date(),
            },
          });
          events.push(planningEvent);
        }

        // Copy only the fields this route owns; never spread the request body
        // into the update, or a caller could overwrite creatorId, serverId, etc.
        const updateData: Record<string, unknown> = {};
        if (body.name !== undefined) updateData.name = body.name;
        if (body.visibility !== undefined) updateData.visibility = body.visibility;
        if (body.hiderLat !== undefined) updateData.hiderLat = body.hiderLat;
        if (body.hiderLng !== undefined) updateData.hiderLng = body.hiderLng;
        if (body.planningModeEnabled !== undefined) {
          updateData.planningModeEnabled = body.planningModeEnabled;
        }
        if (curSequence !== locked.eventSequence) {
          updateData.eventSequence = curSequence;
        }

        const updatedSession = await tx.gameSession.update({
          where: { id: sessionId },
          data: updateData,
          include: {
            game: {
              select: {
                name: true,
                currentRevisionId: true,
                currentRevision: { select: { revision: true } },
              },
            },
            gameRevision: { select: { revision: true } },
          },
        });

        return { updated: updatedSession, eventsToBroadcast: events };
      });

      for (const e of eventsToBroadcast) {
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
        planningModeEnabled: updated.planningModeEnabled,
        gameRevisionId: updated.gameRevisionId,
        sessionRevision: updated.gameRevision.revision,
        currentRevision: updated.game.currentRevision?.revision ?? null,
        hasNewerRevision: Boolean(
          updated.game.currentRevisionId &&
            updated.gameRevisionId !== updated.game.currentRevisionId,
        ),
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
      closeSessionStreams(sessionId);
      return reply.status(204).send();
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

      const { count } = await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId: targetUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw notFound("Participant not found");
      closeUserStreams(sessionId, targetUserId);

      return reply.status(204).send();
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

      const { isCreator } = await resolveParticipant(sessionId, user.discordId);
      if (isCreator) throw forbidden("Session creator cannot leave — delete the session instead");

      await prisma.sessionParticipant.update({
        where: { sessionId_userId: { sessionId, userId: user.discordId } },
        data: { revokedAt: new Date() },
      });
      closeUserStreams(sessionId, user.discordId);

      req.log.info({ sessionId, userId: user.discordId }, "[sessions] participant left session");
      return reply.status(204).send();
    },
  );

  // POST /sessions/:sessionId/links — create a join or share link (creator only)
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
          await tx.linkSnapshot.create({
            data: {
              linkId: created.id,
              questions,
              gameRevisionId: session.gameRevisionId,
            },
          });
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
