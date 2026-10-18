import type { FastifyRequest } from "fastify";
import { env } from "./env.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const frontendOrigin = new URL(env.FRONTEND_ORIGIN).origin;

// The session cookie is SameSite=None in production, and a plain HTML form can
// POST text/plain or urlencoded bodies to another site without a CORS
// preflight, so CORS alone doesn't stop another site from making writes with a
// user's cookie. Browsers send Origin on such requests, so writes whose Origin
// is neither the frontend nor the API itself are rejected.
//
// Requests without Origin pass: browsers always send it on cross-origin POSTs,
// and non-browser clients (import-token scripts, curl) don't send it.
export async function rejectCrossOriginWrites(req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin === undefined || origin === frontendOrigin) return;
  if (isDevLoginPage(origin, req.headers.host)) return;
  req.log.warn({ origin, method: req.method, url: req.url }, "Cross-origin write rejected");
  throw Object.assign(new Error("Cross-origin request not allowed"), { statusCode: 403 });
}

// The /auth/dev-login form, which only exists when DEV_LOGIN_TOKEN is set, is
// served by the API and posts to itself: its Origin's host is the request's Host.
function isDevLoginPage(origin: string, host: string | undefined): boolean {
  if (!env.DEV_LOGIN_TOKEN || !host) return false;
  try {
    const url = new URL(origin);
    if (env.NODE_ENV === "production" && url.protocol !== "https:") return false;
    return url.host === host.toLowerCase();
  } catch {
    // "null" (sandboxed frames, some redirects) and other non-URL values.
    return false;
  }
}
