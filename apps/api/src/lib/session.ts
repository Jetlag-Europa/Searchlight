import type { FastifyRequest } from "fastify";
import prisma from "./prisma.js";

export interface ResolvedUser {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  discordAccessToken: string;
  discordRefreshToken: string;
  discordTokenExpiresAt: Date;
  preferences?: unknown;
}

type AuthFailureReason = "no_cookie" | "bad_signature" | "no_session_row" | "expired";

const unauthorized = (req: FastifyRequest, reason: AuthFailureReason) => {
  // Keep diagnostics server-side; never log cookie values or session credentials.
  req.log.info({ authFailure: reason }, "Session authentication failed");
  return Object.assign(new Error("Unauthorized"), { statusCode: 401 });
};

export async function resolveSession(req: FastifyRequest): Promise<{ user: ResolvedUser }> {
  const raw = req.cookies["session"];
  if (!raw) throw unauthorized(req, "no_cookie");

  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) throw unauthorized(req, "bad_signature");

  const session = await prisma.authSession.findUnique({
    where: { id: unsigned.value },
    include: { user: true },
  });

  if (!session) throw unauthorized(req, "no_session_row");
  if (session.expiresAt < new Date()) throw unauthorized(req, "expired");

  return { user: session.user };
}
