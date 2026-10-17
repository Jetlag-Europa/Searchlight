import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import { Type } from "@sinclair/typebox";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { errorHandler } from "./error-handler.js";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.setErrorHandler(errorHandler);
  app.get("/crash", async () => {
    throw new Error("Invalid `prisma.user.findMany()` invocation in /app/src/secret.ts");
  });
  app.get("/forbidden", async () => {
    throw Object.assign(new Error("Not a member of this server"), { statusCode: 403 });
  });
  app.get(
    "/validated",
    { schema: { querystring: Type.Object({ n: Type.Integer() }) } },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

describe("errorHandler", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test("hides an unexpected error's message", async () => {
    const res = await app.inject({ method: "GET", url: "/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
  });

  test("keeps a client error's message", async () => {
    const res = await app.inject({ method: "GET", url: "/forbidden" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Forbidden", message: "Not a member of this server" });
  });

  test("keeps validation errors as they were", async () => {
    const res = await app.inject({ method: "GET", url: "/validated?n=1.5" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "FST_ERR_VALIDATION",
      message: "querystring/n must be integer",
    });
  });
});
