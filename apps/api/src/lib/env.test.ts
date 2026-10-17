import { afterEach, describe, expect, test, vi } from "vitest";

// env.ts reads process.env when it is first imported, so each test imports a
// fresh copy.
async function loadEnv() {
  vi.resetModules();
  return (await import("./env.js")).env;
}

describe("ENABLE_TEST_AUTH", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("refuses to start with test login when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_TEST_AUTH", "1");
    await expect(loadEnv()).rejects.toThrow(/ENABLE_TEST_AUTH/);
  });

  test("allows test login outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_TEST_AUTH", "1");
    expect((await loadEnv()).ENABLE_TEST_AUTH).toBe(true);
  });

  test("starts in production without test login", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_TEST_AUTH", "");
    expect((await loadEnv()).ENABLE_TEST_AUTH).toBe(false);
  });
});
