import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { env } from "./env.js";
import {
  acquireUploadSlot,
  assertWithinWriteLimit,
  resetWriteLimits,
  WRITE_LIMIT,
} from "./write-limit.js";

const ADMIN = "test-write-limit-admin";
const saved = { ...WRITE_LIMIT };
const previousAdmins = env.ADMIN_DISCORD_IDS;

beforeAll(() => {
  env.ADMIN_DISCORD_IDS = ADMIN;
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(WRITE_LIMIT, saved);
  resetWriteLimits();
});

afterAll(() => {
  env.ADMIN_DISCORD_IDS = previousAdmins;
});

describe("assertWithinWriteLimit", () => {
  test("refuses past the limit until the oldest request leaves the window", () => {
    vi.useFakeTimers();
    WRITE_LIMIT.requests = 2;
    assertWithinWriteLimit("a");
    vi.advanceTimersByTime(5 * 60_000);
    assertWithinWriteLimit("a");
    expect(() => assertWithinWriteLimit("a")).toThrow(
      expect.objectContaining({
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "Too many uploads or changes in a short time. Try again in 5 minutes.",
      }),
    );
    // Others have their own.
    assertWithinWriteLimit("b");

    vi.advanceTimersByTime(4 * 60_000 + 30_000);
    expect(() => assertWithinWriteLimit("a")).toThrow(/Try again in 1 minute\.$/);
    vi.advanceTimersByTime(30_000);
    assertWithinWriteLimit("a");
  });

  test("global admins have no limit", () => {
    WRITE_LIMIT.requests = 1;
    for (let i = 0; i < 3; i++) assertWithinWriteLimit(ADMIN);
  });
});

describe("acquireUploadSlot", () => {
  test("caps uploads in progress per user and in total; admins only count toward the total", () => {
    WRITE_LIMIT.inFlightPerUser = 2;
    WRITE_LIMIT.inFlightTotal = 4;
    const a1 = acquireUploadSlot("a");
    acquireUploadSlot("a");
    expect(() => acquireUploadSlot("a")).toThrow(
      expect.objectContaining({
        statusCode: 429,
        code: "RATE_LIMITED",
        message: "Another upload is still being processed. Wait for it to finish and try again.",
      }),
    );
    acquireUploadSlot(ADMIN);
    acquireUploadSlot(ADMIN);
    expect(() => acquireUploadSlot("b")).toThrow(
      "Searchlight is processing many uploads right now. Try again in a minute.",
    );

    a1();
    acquireUploadSlot("b");
  });

  test("releasing twice frees one slot", () => {
    WRITE_LIMIT.inFlightPerUser = 1;
    WRITE_LIMIT.inFlightTotal = 2;
    const first = acquireUploadSlot("a");
    first();
    acquireUploadSlot("a");
    first();
    expect(() => acquireUploadSlot("a")).toThrow(/Another upload/);
    acquireUploadSlot("b");
    expect(() => acquireUploadSlot("c")).toThrow(/many uploads/);
  });

  test("a slot stays taken past the rate limit's window", () => {
    vi.useFakeTimers();
    WRITE_LIMIT.inFlightPerUser = 1;
    acquireUploadSlot("a");
    assertWithinWriteLimit("a");
    vi.advanceTimersByTime(WRITE_LIMIT.windowMs * 2);
    assertWithinWriteLimit("b");
    expect(() => acquireUploadSlot("a")).toThrow(/Another upload/);
  });
});
