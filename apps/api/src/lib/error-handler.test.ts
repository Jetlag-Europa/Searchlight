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
  app.get("/gone", async () => {
    throw Object.assign(new Error("This link has expired"), { status: 410 });
  });
  app.get("/gone-object", async () => {
    throw { status: 410, message: "This link has expired" };
  });
  app.get("/not-found", async (_req, reply) => {
    reply.code(404);
    throw new Error("No such game");
  });
  app.get("/unavailable", async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { status: 503 });
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

  test("takes the status from an error's `status`", async () => {
    const res = await app.inject({ method: "GET", url: "/gone" });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: "Gone", message: "This link has expired" });
  });

  test("takes the status from a thrown object's `status`", async () => {
    const res = await app.inject({ method: "GET", url: "/gone-object" });
    expect(res.statusCode).toBe(410);
  });

  test("keeps a status set on the reply before throwing", async () => {
    const res = await app.inject({ method: "GET", url: "/not-found" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Not Found", message: "No such game" });
  });

  test("hides the message of an error with a 5xx `status`", async () => {
    const res = await app.inject({ method: "GET", url: "/unavailable" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      statusCode: 503,
      error: "Internal Server Error",
      message: "Internal Server Error",
    });
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
