import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import { brotliDecompressSync, gzipSync } from "node:zlib";
import { registerCompression } from "./compression.js";

const FRONTEND_ORIGIN = process.env["FRONTEND_ORIGIN"]!;
const large = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item ${i}` })) };

// Registered in the same order as index.ts.
async function buildTestApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: FRONTEND_ORIGIN, credentials: true });
  await registerCompression(app);
  app.get("/large", async () => large);
  app.get("/small", async () => ({ ok: true }));
  // A body limit above Fastify's 1 MB default, as on game imports.
  app.post("/echo", { bodyLimit: 16 * 1024 * 1024 }, async (req) => ({
    size: JSON.stringify(req.body).length,
  }));
  await app.ready();
  return app;
}

describe("registerCompression", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  test("compresses large responses with brotli, keeping the CORS headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/large",
      headers: { origin: FRONTEND_ORIGIN, "accept-encoding": "gzip, deflate, br, zstd" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["access-control-allow-origin"]).toBe(FRONTEND_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers.vary).toContain("accept-encoding");
    expect(JSON.parse(brotliDecompressSync(res.rawPayload).toString())).toEqual(large);
  });

  test("leaves responses under 1 KB alone", async () => {
    const res = await app.inject({ method: "GET", url: "/small", headers: { "accept-encoding": "br" } });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.json()).toEqual({ ok: true });
  });

  test("parses a large JSON request body as before", async () => {
    const body = { blob: "x".repeat(4 * 1024 * 1024) };
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json", "accept-encoding": "br" },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ size: JSON.stringify(body).length });
  });

  // Fastify on its own rejects a request body with a Content-Encoding; the
  // plugin's request decompression would accept it instead.
  test("doesn't decompress request bodies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      payload: gzipSync(JSON.stringify({ a: 1 })),
    });
    expect(res.statusCode).toBe(400);
  });
});
