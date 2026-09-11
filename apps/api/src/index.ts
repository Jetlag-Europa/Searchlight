import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { env } from "./lib/env.js";
import { authRoutes } from "./routes/auth.js";
import { meRoute } from "./routes/me.js";
import { serverRoutes } from "./routes/servers.js";
import { gameRoutes } from "./routes/games.js";
import { sessionRoutes } from "./routes/sessions.js";
import { sessionContentRoutes } from "./routes/session-content.js";
import { userRoutes } from "./routes/users.js";
import { boundaryRoutes } from "./routes/boundaries.js";
import { overpassRoutes } from "./routes/overpass.js";
import { eventRoutes } from "./routes/events.js";
import { linkRoutes } from "./routes/links.js";
import { feedbackRoutes } from "./routes/feedback.js";

// Request serializer. Fastify's default logs method/url/hostname/remoteAddress and
// nothing about the client, which made it impossible to attribute a wall of 401s to
// a browser (or to an in-app webview). `pageLoad` is a client-generated id sent on
// every API call from one page load, so 5-9 simultaneous 401s collapse into a single
// identifiable event in the logs instead of nine unrelated lines.
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
          userAgent: req.headers["user-agent"],
          referer: req.headers["referer"],
          origin: req.headers["origin"],
          secFetchSite: req.headers["sec-fetch-site"],
          pageLoad: req.headers["x-page-load"],
        };
      },
    },
  },
}).withTypeProvider<TypeBoxTypeProvider>();

await app.register(fastifyCors, {
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
  // x-page-load is the per-page-load correlation id (see the req serializer above).
  // Without it listed here, any request carrying the header fails preflight.
  allowedHeaders: ["Content-Type", "X-CSRF", "X-Page-Load"],
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
await app.register(sessionRoutes, { prefix: "/sessions" });
await app.register(sessionContentRoutes, { prefix: "/sessions" });
await app.register(userRoutes, { prefix: "/users" });
await app.register(boundaryRoutes, { prefix: "/boundaries" });
await app.register(overpassRoutes);
await app.register(eventRoutes, { prefix: "/sessions" });
await app.register(linkRoutes, { prefix: "/links" });
await app.register(feedbackRoutes, { prefix: "/feedback" });

const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`Server listening on ${address}`);
