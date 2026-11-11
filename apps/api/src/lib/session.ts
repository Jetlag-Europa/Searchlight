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

// A login lasts 30 days from its last renewal. Once it is a day old, the next
// ordinary request pushes it back to 30 days (see registerSessionRenewal). So
// a login ends after 29 to 30 days without use, and the row is written at most
// about once a day per login.
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

// The login each request resolved, for registerSessionRenewal.
const resolvedLogins = new WeakMap<FastifyRequest, { id: string; expiresAt: Date }>();

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
  if (session.expiresAt.getTime() < Date.now()) throw unauthorized(req, "expired");

  resolvedLogins.set(req, { id: session.id, expiresAt: session.expiresAt });

  return { user: session.user };
}

// Every ordinary response to a request that resolved a login re-sends its
// cookie with the row's expiry, renewing the row first if it is due. The
// cookie never outlives the row, and a renewed cookie that never reached the
// browser (a dropped connection) is repaired by the next response that does:
// re-sending costs no write. A response that started before a logout may
// bring the cookie back after it, but its row is gone, so it logs nobody in.
// Hijacked replies (the SSE stream) skip onSend, so they send and renew
// nothing; the app's ordinary requests do it. A failed renewal only logs: the
// request is valid either way. Add it to the root instance before the routes.
export function registerSessionRenewal(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply, payload) => {
    const login = resolvedLogins.get(req);
    if (!login) return payload;
    resolvedLogins.delete(req);
    let { expiresAt } = login;
    if (expiresAt.getTime() - Date.now() < RENEW_WHEN_LEFT_MS) {
      const renewed = new Date(Date.now() + SESSION_TTL_MS);
      try {
        // updateMany, not update: a logout may have deleted the row since,
        // and then no cookie is sent. Concurrent requests each renew.
        const { count } = await prisma.authSession.updateMany({
          where: { id: login.id, expiresAt: { gt: new Date() } },
          data: { expiresAt: renewed },
        });
        if (count === 0) return payload;
        expiresAt = renewed;
      } catch (err) {
        req.log.warn({ err }, "Could not renew the login; it keeps its current expiry");
      }
    }
    setSessionCookie(reply, login.id, expiresAt);
    // Set-Cookie alone doesn't stop a shared cache from storing a response.
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "private");
    return payload;
  });
}
