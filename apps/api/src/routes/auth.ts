import type { FastifyInstance } from "fastify";
import { Discord, generateState } from "arctic";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma.js";
import { discord } from "../lib/discord-client.js";
import { env } from "../lib/env.js";

const discordOAuth = new Discord(
  env.DISCORD_CLIENT_ID,
  env.DISCORD_CLIENT_SECRET,
  env.DISCORD_REDIRECT_URI,
);

const SCOPES = ["identify", "guilds", "guilds.members.read"];
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days fixed

function sessionCookieOptions(expiresAt: Date) {
  const isProd = env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    signed: true,
    expires: expiresAt,
    ...(isProd && {
      secure: true,
      domain: env.SESSION_COOKIE_DOMAIN,
    }),
  };
}

export async function authRoutes(app: FastifyInstance) {
  // GET /auth/discord/login
  app.get("/discord/login", async (req, reply) => {
    const state = generateState();
    const url = discordOAuth.createAuthorizationURL(state, null, SCOPES);

    reply.setCookie("oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600, // 10 minutes
      path: "/",
    });

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

      reply.clearCookie("oauth_state", { path: "/" });

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
      const avatarUrl = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordUser.id) % 6}.png`;

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

      const sessionId = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      await prisma.authSession.create({
        data: { id: sessionId, userId: discordUser.id, expiresAt },
      });

      reply.setCookie("session", sessionId, {
        ...sessionCookieOptions(expiresAt),
        path: "/",
      });

      return reply.redirect(`${env.FRONTEND_ORIGIN}/map`);
    },
  );

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
