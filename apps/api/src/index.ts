import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { env } from "./lib/env.js";
import { authRoutes } from "./routes/auth.js";
import { meRoute } from "./routes/me.js";

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

const address = await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`Server listening on ${address}`);
