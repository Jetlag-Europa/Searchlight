import type { GameListing, GameSession, Visibility } from "@prisma/client";
import prisma from "./prisma.js";

// Game link tokens are told apart from session link tokens by this prefix.
export const GAME_LINK_PREFIX = "g_";

/**
 * Whether a fork of this session is granted its game. Sharing a private game's
 * session is how access to it spreads, and a granted session passes its grant
 * on. The grant is recorded on the fork, so it outlasts the game becoming
 * public (when membership would otherwise be needed to follow it).
 */
export function forkFollowsGame(source: {
  followsGame: boolean;
  game: { listing: GameListing };
}): boolean {
  return source.followsGame || source.game.listing === "unlisted";
}

/** Creates a session pinned to a game revision, with its creator as participant. */
export function createGameSession(data: {
  gameId: string;
  serverId: string;
  creatorId: string;
  name: string;
  visibility: Visibility;
  gameRevisionId: string;
  followsGame?: boolean;
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
