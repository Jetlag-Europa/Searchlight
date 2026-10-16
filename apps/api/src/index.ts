import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { env } from "./lib/env.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preloadGameDefinitions } from "./games/preload.js";
import { authRoutes } from "./routes/auth.js";
import { meRoute } from "./routes/me.js";
import { serverRoutes } from "./routes/servers.js";
import { gameRoutes } from "./routes/games.js";
import { gameImportRoutes } from "./routes/game-imports.js";
import { sessionRoutes } from "./routes/sessions.js";
import { sessionContentRoutes } from "./routes/session-content.js";
import { userRoutes } from "./routes/users.js";
import { eventRoutes } from "./routes/events.js";
import { linkRoutes } from "./routes/links.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./routes/game-links.js";

const app = Fastify({
  logger: {
    level: "info",
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url,
          hostname: req.hostname,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
          userAgent: req.headers["user-agent"],
          origin: req.headers["origin"],
          secFetchSite: req.headers["sec-fetch-site"],
        };
      },
    },
  },
}).withTypeProvider<TypeBoxTypeProvider>();

await app.register(fastifyCors, {
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
});

await app.register(fastifyCookie, {
  secret: env.SESSION_COOKIE_SECRET,
});

app.get(
  "/health",
  {
    schema: {
      response: { 200: Type.Object({ ok: Type.Boolean() }) },
    },
  },
  async () => ({ ok: true }),
);

await app.register(authRoutes, { prefix: "/auth" });
await app.register(meRoute);
await app.register(serverRoutes, { prefix: "/servers" });
await app.register(gameRoutes, { prefix: "/games" });
await app.register(gameImportRoutes, { prefix: "/games" });
await app.register(gameLinkManagementRoutes, { prefix: "/games" });
await app.register(sessionRoutes, { prefix: "/sessions" });
await app.register(sessionContentRoutes, { prefix: "/sessions" });
await app.register(userRoutes, { prefix: "/users" });
await app.register(eventRoutes, { prefix: "/sessions" });
await app.register(linkRoutes, { prefix: "/links" });
await app.register(gameLinkRoutes, { prefix: "/game-links" });

const __dir = dirname(fileURLToPath(import.meta.url));
const preloadCandidateDirs = [
  resolve(process.cwd(), "games/preloaded"),
  resolve(process.cwd(), "../../games/preloaded"),
  resolve(__dir, "../../games/preloaded"),
  resolve(__dir, "../../../games/preloaded"),
];
const activePreloadDir = preloadCandidateDirs.find((d) => existsSync(d));
if (activePreloadDir) {
  try {
    const summary = await preloadGameDefinitions(activePreloadDir);
    for (const { fileName, error } of summary.failures) {
      app.log.error({ err: error, file: fileName }, "Failed to preload game definition; skipped");
    }
    app.log.info(
      {
        total: summary.total,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        failed: summary.failures.length,
      },
      "Preloaded game definitions",
    );
  } catch (err) {
    app.log.error({ err }, "Failed to preload game definitions");
  }
}

const address = await app.listen({ port: env.PORT, host: env.HOST });
