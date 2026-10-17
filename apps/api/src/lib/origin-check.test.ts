import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import { errorHandler } from "./error-handler.js";
import { rejectCrossOriginWrites } from "./origin-check.js";

const API_HOST = "sl-pr-10-api.dev.jl-e.org";
const FRONTEND_ORIGIN = process.env["FRONTEND_ORIGIN"]!;

async function buildTestApp() {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  app.addHook("onRequest", rejectCrossOriginWrites);
  app.get("/thing", async () => ({ ok: true }));
  app.options("/thing", async () => ({ ok: true }));
  app.post("/thing", async () => ({ ok: true }));
  app.delete("/thing", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rejectCrossOriginWrites", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  // A text/plain body is what a cross-site HTML form can send without a preflight.
  const post = (origin?: string, method: "POST" | "DELETE" = "POST") =>
    app.inject({
      method,
      url: "/thing",
      headers: {
        host: API_HOST,
        "content-type": "text/plain",
        ...(origin !== undefined && { origin }),
      },
      payload: "x=1",
    });

  test("allows a write without Origin (non-browser clients)", async () => {
    expect((await post()).statusCode).toBe(200);
  });

  test("allows a write from FRONTEND_ORIGIN", async () => {
    expect((await post(FRONTEND_ORIGIN)).statusCode).toBe(200);
  });

  test("allows a write from the API's own host", async () => {
    expect((await post(`https://${API_HOST}`)).statusCode).toBe(200);
  });

  test.each([
    ["another site", "https://evil.example"],
    ["an opaque origin", "null"],
    ["a sibling preview", "https://sl-pr-9.dev.jl-e.org"],
    ["the frontend's host on another port", `${FRONTEND_ORIGIN}:8443`],
  ])("rejects a write from %s", async (_name, origin) => {
    const res = await post(origin);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      statusCode: 403,
      error: "Forbidden",
      message: "Cross-origin request not allowed",
    });
  });

  test("rejects other write methods too", async () => {
    expect((await post("https://evil.example", "DELETE")).statusCode).toBe(403);
  });

  test.each(["GET", "OPTIONS"] as const)("leaves %s alone", async (method) => {
    const res = await app.inject({
      method,
      url: "/thing",
      headers: { host: API_HOST, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(200);
  });
});
