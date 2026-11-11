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

// A login lasts 30 days from its last renewal; a request renews it once it is a day old.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_LEFT_MS = SESSION_TTL_MS - 24 * 60 * 60 * 1000;

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

// Logins due for renewal, by the request that resolved them.
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
  if (session.expiresAt < new Date()) throw unauthorized(req, "expired");

  if (session.expiresAt.getTime() - Date.now() < RENEW_WHEN_LEFT_MS) dueForRenewal.set(req, session.id);

  return { user: session.user };
}

// Renews in onSend, so the new cookie rides on the response. Hijacked replies
// (the SSE stream) skip onSend and renew nothing. Register before the routes.
export function registerSessionRenewal(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const id = dueForRenewal.get(req);
    if (!id) return payload;
    dueForRenewal.delete(req);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    try {
      // updateMany: a logout meanwhile deleted the row, so send no cookie.
      const { count } = await prisma.authSession.updateMany({
        where: { id, expiresAt: { gt: new Date() } },
        data: { expiresAt },
      });
      if (count > 0) setSessionCookie(reply, id, expiresAt);
    } catch (err) {
      req.log.warn({ err }, "Could not renew the login");
    }
    return payload;
  });
}
