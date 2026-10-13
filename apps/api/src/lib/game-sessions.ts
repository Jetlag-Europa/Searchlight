import type { GameSession, Visibility } from "@prisma/client";
import prisma from "./prisma.js";

// Game link tokens are told apart from session link tokens by this prefix.
export const GAME_LINK_PREFIX = "g_";

/** Creates a session pinned to a game revision, with its creator as participant. */
export function createGameSession(data: {
  gameId: string;
  serverId: string;
  creatorId: string;
  name: string;
  visibility: Visibility;
  gameRevisionId: string;
}): Promise<GameSession> {
  return prisma.$transaction(async (tx) => {
    const session = await tx.gameSession.create({ data });
    await tx.sessionParticipant.create({
      data: {
        sessionId: session.id,
        userId: data.creatorId,
        role: "creator",
        acceptedAt: new Date(),
      },
    });
    return session;
  });
}
