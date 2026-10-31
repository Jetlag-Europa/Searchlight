import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { env } from "./lib/env.js";
import prisma from "./lib/prisma.js";
import { closeAllStreams } from "./lib/broadcaster.js";
import { errorHandler } from "./lib/error-handler.js";
import { rejectCrossOriginWrites } from "./lib/origin-check.js";
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
import { eventRoutes } from "./routes/events.js";
import { linkRoutes } from "./routes/links.js";
import { gameLinkManagementRoutes, gameLinkRoutes } from "./routes/game-links.js";
import { ogRoutes } from "./routes/og.js";
import { liveLocationRoutes, liveLocationServerRoutes } from "./routes/live-locations.js";

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

app.setErrorHandler(errorHandler);

// app.close() waits for open requests, and live streams never end on their
// own, so end them first. Clients reconnect and resume from their last sequence.
app.addHook("preClose", async () => {
  closeAllStreams();
});
app.addHook("onClose", async () => {
  await prisma.$disconnect();
});

await app.register(fastifyCors, {
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
});

app.addHook("onRequest", rejectCrossOriginWrites);

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
await app.register(liveLocationServerRoutes, { prefix: "/servers" });
await app.register(gameRoutes, { prefix: "/games" });
await app.register(gameImportRoutes, { prefix: "/games" });
await app.register(gameLinkManagementRoutes, { prefix: "/games" });
await app.register(sessionRoutes, { prefix: "/sessions" });
await app.register(sessionContentRoutes, { prefix: "/sessions" });
await app.register(eventRoutes, { prefix: "/sessions" });
await app.register(liveLocationRoutes, { prefix: "/sessions" });
await app.register(linkRoutes, { prefix: "/links" });
await app.register(gameLinkRoutes, { prefix: "/game-links" });
await app.register(ogRoutes, { prefix: "/og" });

// Node runs as PID 1 in the container, which has no default signal handling:
// without this, `docker stop` waits out its timeout and kills the process
// mid-request. Registered before the game preload so a stop during boot works
// too. Exit before Docker's 10 s timeout even if closing hangs.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "Shutting down");
    setTimeout(() => {
      app.log.error("Shutdown timed out, exiting");
      process.exit(1);
    }, 8_000).unref();
    app.close().then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, "Shutdown failed");
        process.exit(1);
      },
    );
  });
}

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
    for (const { fileName, revision } of summary.kept) {
      app.log.warn(
        { file: fileName, revision },
        `games/preloaded/${fileName} is unchanged since the last start, but revision ${revision} was made current since; keeping ${revision}`,
      );
    }
    app.log.info(
      {
        total: summary.total,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        kept: summary.kept.length,
        failed: summary.failures.length,
      },
      "Preloaded game definitions",
    );
  } catch (err) {
    app.log.error({ err }, "Failed to preload game definitions");
  }
}

const address = await app.listen({ port: env.PORT, host: env.HOST });
