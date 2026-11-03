import type { Prisma, SessionParticipant } from "@prisma/client";
import type { SessionRole } from "@searchlight/shared";
import prisma from "./prisma.js";
import { forbidden, notFound } from "./http-errors.js";

// Who may do what in a session. Its creator and active participants (who
// accepted a link and weren't kicked and didn't leave) may read it; creators
// and members may change it, viewers only follow it.

/** The caller's role, from the session and their participant row. */
export function sessionRole(
  session: { creatorId: string },
  userId: string,
  participant: { role: string } | null | undefined,
): SessionRole {
  if (session.creatorId === userId) return "creator";
  return participant?.role === "viewer" ? "viewer" : "member";
}

function isActive(participant: SessionParticipant | null): participant is SessionParticipant {
  return participant !== null && participant.acceptedAt !== null && participant.revokedAt === null;
}

/**
 * The session, the caller's participant row and role. Throws 404 if there's no
 * such session and 403 unless the caller is its creator or an active
 * participant.
 */
export async function resolveSessionAccess<I extends Prisma.GameSessionInclude = {}>(
  sessionId: string,
  userId: string,
  include?: I,
) {
  const session = (await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include,
  })) as Prisma.GameSessionGetPayload<{ include: I }> | null;
  if (!session) throw notFound("Session not found");

  const participant = await prisma.sessionParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
  });

  const isCreator = session.creatorId === userId;
  if (!isCreator && !isActive(participant)) throw forbidden();

  return { session, participant, isCreator, role: sessionRole(session, userId, participant) };
}

/** Throws 403 for a viewer: they can't change the session. */
export function assertCanWrite(role: SessionRole): void {
  if (role === "viewer") throw forbidden("Spectators can't change this session");
}

/** resolveSessionAccess, then 403 unless the caller is a creator or member. */
export async function resolveSessionWriter<I extends Prisma.GameSessionInclude = {}>(
  sessionId: string,
  userId: string,
  include?: I,
) {
  const access = await resolveSessionAccess(sessionId, userId, include);
  assertCanWrite(access.role);
  return access;
}

/**
 * The sessions a user's session list shows: those they created, and shared
 * ones they are an active participant of, viewers included.
 */
export function listedSessionsWhere(userId: string): Prisma.GameSessionWhereInput {
  return {
    OR: [
      { creatorId: userId },
      {
        visibility: "shared",
        participants: {
          some: { userId, acceptedAt: { not: null }, revokedAt: null },
        },
      },
    ],
  };
}

/** The hider's position as a participant with `role` may see it: viewers never do. */
export function hiderPositionForRole(
  session: { hiderLat: number | null; hiderLng: number | null },
  role: SessionRole,
): { hiderLat: number | null; hiderLng: number | null } {
  if (role === "viewer") return { hiderLat: null, hiderLng: null };
  return { hiderLat: session.hiderLat, hiderLng: session.hiderLng };
}

/**
 * The event as a participant with `role` may see it: viewers get hider
 * updates without the position. Redacted rather than left out, so the
 * sequence numbers they catch up on stay contiguous.
 */
export function eventForRole<E extends { type: string; payloadJson: unknown }>(
  event: E,
  role: SessionRole,
): E {
  if (role === "viewer" && event.type === "hider.update") {
    return { ...event, payloadJson: { hiderLat: null, hiderLng: null } };
  }
  return event;
}
