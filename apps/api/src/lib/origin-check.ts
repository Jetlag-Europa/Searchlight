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
// The API's own pages (the /auth/dev-login form) post with an Origin whose host
// is the request's Host.
export async function rejectCrossOriginWrites(req: FastifyRequest) {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin === undefined || origin === frontendOrigin) return;
  if (sameHost(origin, req.headers.host)) return;
  req.log.warn({ origin, method: req.method, url: req.url }, "Cross-origin write rejected");
  throw Object.assign(new Error("Cross-origin request not allowed"), { statusCode: 403 });
}

function sameHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    // "null" (sandboxed frames, some redirects) and other non-URL values.
    return false;
  }
}
