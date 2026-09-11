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

// Why a 401 happened. The first two are decided before the database is touched
// and are therefore indistinguishable by response time alone — which is exactly
// the ambiguity this exists to remove. Logged, never sent to the client.
export type AuthFailureReason =
  | "no_cookie"       // browser sent no session cookie at all
  | "bad_signature"   // cookie present but did not verify against SESSION_COOKIE_SECRET
  | "no_session_row"  // signed id valid, but no matching AuthSession (revoked/pruned)
  | "expired";        // row found, past expiresAt

const unauthorized = (req: FastifyRequest, reason: AuthFailureReason) => {
  req.log.warn({ authFailure: reason, cookieNames: Object.keys(req.cookies) }, "auth: 401");
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
