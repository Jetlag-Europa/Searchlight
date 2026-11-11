import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import prisma from "./prisma.js";
import { env } from "./env.js";

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

// A login lasts 30 days from its last renewal. Once less than half of that is
// left, the next ordinary request pushes it back to 30 days (see
// registerSessionRenewal), so a player who keeps using the app stays logged
// in, and the row is written at most about once every 15 days.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_LEFT_MS = SESSION_TTL_MS / 2;

function sessionCookieOptions(expiresAt: Date) {
  const isProd = env.NODE_ENV === "production";
  return {
    httpOnly: true,
    // Subdomains of one site (searchlight.jetlageuropa.org and
    // api-searchlight.jetlageuropa.org) are same-site, so SameSite=Lax would work for
    // them. None is kept for deployments where the web app and API are different
    // sites, e.g. the web app on Cloudflare Workers (*.workers.dev; see DEPLOY.md),
    // where Lax cookies aren't sent on the app's fetches. With None, cross-site forms
    // also carry the cookie; lib/origin-check.ts rejects their writes.
    sameSite: (isProd ? "none" : "lax") as "none" | "lax",
    signed: true,
    expires: expiresAt,
    path: "/",
    ...(isProd && {
      secure: true,
    }),
  };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie("session", sessionId, sessionCookieOptions(expiresAt));
}

type AuthFailureReason = "no_cookie" | "bad_signature" | "no_session_row" | "expired";

const unauthorized = (req: FastifyRequest, reason: AuthFailureReason) => {
  // Keep diagnostics server-side; never log cookie values or session credentials.
  req.log.info({ authFailure: reason }, "Session authentication failed");
  return Object.assign(new Error("Unauthorized"), { statusCode: 401 });
};

// Requests whose login is due for renewal, by session id.
const dueForRenewal = new WeakMap<FastifyRequest, string>();

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
  const now = Date.now();
  if (session.expiresAt.getTime() < now) throw unauthorized(req, "expired");

  if (session.expiresAt.getTime() - now < RENEW_WHEN_LEFT_MS) dueForRenewal.set(req, session.id);

  return { user: session.user };
}

// Renews a login that resolveSession found due, as the response goes out: the
// row and the cookie are renewed together, so the cookie never expires before
// the row (the browser drops an expired cookie, which logs the player out).
// Hijacked replies (the SSE stream) skip onSend, so they renew nothing; the
// app's ordinary requests do it. A failed renewal only logs: the request is
// valid either way. Add it to the root instance before the routes.
export function registerSessionRenewal(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const sessionId = dueForRenewal.get(req);
    if (!sessionId) return payload;
    dueForRenewal.delete(req);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    try {
      // updateMany, not update: a logout may have deleted the row since.
      // Concurrent requests each renew and each send their cookie.
      const { count } = await prisma.authSession.updateMany({
        where: { id: sessionId, expiresAt: { gt: new Date() } },
        data: { expiresAt },
      });
      if (count === 1) setSessionCookie(reply, sessionId, expiresAt);
    } catch (err) {
      req.log.warn({ err }, "Could not renew the login; it keeps its current expiry");
    }
    return payload;
  });
}
