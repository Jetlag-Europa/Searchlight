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
import { eventRoutes } from "./routes/events.js";

const app = Fastify({ logger: { level: "info" } }).withTypeProvider<TypeBoxTypeProvider>();

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
await app.register(sessionRoutes, { prefix: "/sessions" });
await app.register(sessionContentRoutes, { prefix: "/sessions" });
await app.register(userRoutes, { prefix: "/users" });
await app.register(boundaryRoutes, { prefix: "/boundaries" });
await app.register(eventRoutes, { prefix: "/sessions" });

const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`Server listening on ${address}`);
