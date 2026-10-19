import type { FastifyInstance, FastifyReply } from "fastify";
import { Discord, generateState } from "arctic";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import prisma from "../lib/prisma.js";
import { discord } from "../lib/discord-client.js";
import { env } from "../lib/env.js";

const discordOAuth = new Discord(
  env.DISCORD_CLIENT_ID,
  env.DISCORD_CLIENT_SECRET,
  env.DISCORD_REDIRECT_URI,
);

const SCOPES = ["identify"];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days fixed

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
    ...(isProd && {
      secure: true,
    }),
  };
}

function avatarUrlFor(discordId: string, avatar: string | null): string {
  return avatar
    ? `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png`
    : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordId) % 6}.png`;
}

async function startSession(reply: FastifyReply, discordId: string): Promise<void> {
  const sessionId = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.authSession.create({
    data: { id: sessionId, userId: discordId, expiresAt },
  });

  reply.setCookie("session", sessionId, {
    ...sessionCookieOptions(expiresAt),
    path: "/",
  });
}

// Users created by test/dev login never went through OAuth. Nothing reads the OAuth
// tokens after login (membership checks use the bot token), so placeholders do.
const placeholderTokens = () => ({
  discordAccessToken: "test-access-token",
  discordRefreshToken: "test-refresh-token",
  discordTokenExpiresAt: new Date(Date.now() + SESSION_TTL_MS),
});

const DISCORD_ID_RE = /^\d{15,21}$/;

function tokenMatches(given: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(env.DEV_LOGIN_TOKEN).digest();
  return timingSafeEqual(a, b);
}

// Where to send the user after login: a path on the web app, never another site.
const frontendOrigin = new URL(env.FRONTEND_ORIGIN).origin;
function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  const url = URL.parse(value, frontendOrigin);
  return url?.origin === frontendOrigin ? url.pathname + url.search + url.hash : undefined;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function devLoginPage(discordId: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Searchlight dev login</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: .5rem; font: inherit; }
  button { margin-top: 1.5rem; padding: .5rem 1rem; font: inherit; }
  .error { color: #b00020; }
  p { color: #555; }
</style>
</head>
<body>
<h1>Dev login</h1>
<p>Preview deployments only. Logs in as any Discord user, without Discord.
Their servers and roles come from the bot, as usual.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/auth/dev-login">
  <label for="discordId">Discord user ID</label>
  <input id="discordId" name="discordId" inputmode="numeric" required value="${escapeHtml(discordId)}">
  <label for="token">Dev login token</label>
  <input id="token" name="token" type="password" required autocomplete="current-password">
  <button type="submit">Log in</button>
</form>
</body>
</html>`;
}

export async function authRoutes(app: FastifyInstance) {
  // GET /auth/discord/login
  app.get<{ Querystring: { returnTo?: string } }>("/discord/login", async (req, reply) => {
    const state = generateState();
    const url = discordOAuth.createAuthorizationURL(state, null, SCOPES);
    const oauthCookie = {
      httpOnly: true,
      sameSite: "lax" as const,
      maxAge: 600, // 10 minutes
      path: "/",
    };

    reply.setCookie("oauth_state", state, oauthCookie);
    const returnTo = safeReturnTo(req.query.returnTo);
    if (returnTo) reply.setCookie("oauth_return_to", returnTo, oauthCookie);
    else reply.clearCookie("oauth_return_to", { path: "/" });

    return reply.redirect(url.toString());
  });

  // GET /auth/discord/callback
  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/discord/callback",
    async (req, reply) => {
      const { code, state } = req.query;
      const storedState = req.cookies["oauth_state"];

      if (!code || !state || !storedState || state !== storedState) {
        return reply.status(400).send("Invalid OAuth state");
      }

      const returnTo = safeReturnTo(req.cookies["oauth_return_to"]) ?? "/map";
      reply.clearCookie("oauth_state", { path: "/" });
      reply.clearCookie("oauth_return_to", { path: "/" });

      let tokens;
      try {
        tokens = await discordOAuth.validateAuthorizationCode(code, null);
      } catch {
        return reply.status(400).send("Failed to exchange OAuth code");
      }

      const accessToken = tokens.accessToken();
      const refreshToken = tokens.refreshToken();
      const accessTokenExpiresAt = tokens.accessTokenExpiresAt();

      const discordUser = await discord.getCurrentUser(accessToken, req.log);

      const displayName = discordUser.global_name ?? discordUser.username;
      const avatarUrl = avatarUrlFor(discordUser.id, discordUser.avatar);

      await prisma.user.upsert({
        where: { discordId: discordUser.id },
        update: {
          username: discordUser.username,
          displayName,
          avatarUrl,
          discordAccessToken: accessToken,
          discordRefreshToken: refreshToken,
          discordTokenExpiresAt: accessTokenExpiresAt,
        },
        create: {
          discordId: discordUser.id,
          username: discordUser.username,
          displayName,
          avatarUrl,
          discordAccessToken: accessToken,
          discordRefreshToken: refreshToken,
          discordTokenExpiresAt: accessTokenExpiresAt,
        },
      });

      await startSession(reply, discordUser.id);

      return reply.redirect(`${frontendOrigin}${returnTo}`);
    },
  );

  // POST /auth/test-login — TEST ONLY, gated by ENABLE_TEST_AUTH=1.
  // Mints a session cookie for a seeded user without the Discord OAuth dance, so
  // Playwright e2e can authenticate deterministically. The route is only
  // registered when the flag is on, so it does not exist at all in production.
  if (env.ENABLE_TEST_AUTH) {
    app.log.warn(
      "ENABLE_TEST_AUTH=1 — POST /auth/test-login is registered. Do NOT use this in production.",
    );

    app.post<{ Body?: { discordId?: string } }>(
      "/test-login",
      async (req, reply) => {
        const discordId = req.body?.discordId ?? env.TEST_AUTH_USER_ID;

        // Upsert so the endpoint works even if the user wasn't pre-seeded.
        const user = await prisma.user.upsert({
          where: { discordId },
          update: {},
          create: {
            discordId,
            username: discordId,
            displayName: `Test User ${discordId}`,
            avatarUrl: `https://cdn.discordapp.com/embed/avatars/0.png`,
            ...placeholderTokens(),
          },
        });

        await startSession(reply, user.discordId);

        return reply.send({
          user: { discordId: user.discordId, displayName: user.displayName },
        });
      },
    );
  }

  // /auth/dev-login — PREVIEW DEPLOYMENTS ONLY, gated by DEV_LOGIN_TOKEN.
  // Logs in as any Discord user ID given the token, so testers and agents can act as
  // specific users without their Discord accounts. Real users get their Discord
  // profile via the bot; unknown IDs become placeholder users (members of nothing).
  // Like test-login, the routes do not exist when the token is unset.
  if (env.DEV_LOGIN_TOKEN) {
    app.log.warn(
      "DEV_LOGIN_TOKEN is set — /auth/dev-login is registered. Do NOT use this in production.",
    );

    // The HTML form posts urlencoded; Fastify only parses JSON by default.
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    // GET /auth/dev-login — a login form for browsers.
    app.get<{ Querystring: { discordId?: string } }>("/dev-login", async (req, reply) => {
      return reply.type("text/html").send(devLoginPage(req.query.discordId ?? ""));
    });

    // POST /auth/dev-login — form (redirects to the app) or JSON (returns the user).
    // The token comes from `Authorization: Bearer <token>` or the body's `token`.
    app.post<{ Body?: { discordId?: unknown; token?: unknown } }>(
      "/dev-login",
      async (req, reply) => {
        const isForm = req.headers["content-type"]?.startsWith(
          "application/x-www-form-urlencoded",
        );
        const fail = (status: number, error: string, discordId = "") =>
          isForm
            ? reply.status(status).type("text/html").send(devLoginPage(discordId, error))
            : reply.status(status).send({ error });

        const discordId = typeof req.body?.discordId === "string" ? req.body.discordId.trim() : "";
        const auth = req.headers.authorization;
        const token = auth?.startsWith("Bearer ")
          ? auth.slice("Bearer ".length)
          : typeof req.body?.token === "string"
            ? req.body.token
            : "";

        if (!token || !tokenMatches(token)) {
          req.log.warn({ discordId }, "Dev login rejected: bad token");
          return fail(403, "Wrong dev login token.", discordId);
        }
        if (!DISCORD_ID_RE.test(discordId)) {
          return fail(400, "discordId must be a numeric Discord user ID.", discordId);
        }

        let profile = null;
        try {
          profile = await discord.getUser(discordId, req.log);
        } catch (err) {
          req.log.warn({ err, discordId }, "Dev login: Discord profile lookup failed");
        }
        const known = profile
          ? {
              username: profile.username,
              displayName: profile.global_name ?? profile.username,
              avatarUrl: avatarUrlFor(discordId, profile.avatar),
            }
          : null;

        // Keep a real user's OAuth tokens if they have logged in here before.
        const user = await prisma.user.upsert({
          where: { discordId },
          update: known ?? {},
          create: {
            discordId,
            username: known?.username ?? `dev-${discordId}`,
            displayName: known?.displayName ?? `Dev User ${discordId.slice(-4)}`,
            avatarUrl: known?.avatarUrl ?? avatarUrlFor(discordId, null),
            ...placeholderTokens(),
          },
        });

        await startSession(reply, discordId);
        req.log.warn({ discordId, knownDiscordUser: known !== null }, "Dev login");

        if (isForm) return reply.redirect(`${env.FRONTEND_ORIGIN}/map`, 303);
        return reply.send({
          user: { discordId: user.discordId, displayName: user.displayName },
        });
      },
    );
  }

  // POST /auth/logout
  app.post("/logout", async (req, reply) => {
    // Strict CSRF check — must be exactly the string "1"
    const csrf = req.headers["x-csrf"];
    if (csrf !== "1") {
      return reply.status(403).send();
    }

    const raw = req.cookies["session"];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (unsigned.valid && unsigned.value) {
        await prisma.authSession.deleteMany({ where: { id: unsigned.value } });
      }
    }

    reply.clearCookie("session", { path: "/" });
    return reply.status(204).send();
  });
}
