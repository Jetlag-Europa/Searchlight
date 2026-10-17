// All Discord REST calls must go through this module.
// Never call https://discord.com/api/v10/* from anywhere else.

import type { FastifyBaseLogger } from "fastify";
import { env } from "./env.js";

const DISCORD_API = "https://discord.com/api/v10";
const GLOBAL_RATE = 50; // req/sec

interface Bucket {
  remaining: number;
  resetAt: number; // ms since epoch
}

const buckets = new Map<string, Bucket>();

let globalTokens = GLOBAL_RATE;
let globalLastRefill = Date.now();

function refillGlobal() {
  const now = Date.now();
  const elapsed = (now - globalLastRefill) / 1000;
  globalTokens = Math.min(GLOBAL_RATE, globalTokens + elapsed * GLOBAL_RATE);
  globalLastRefill = now;
}

// Serialized queue for the global token bucket. Acquisitions are chained so
// concurrent callers each wait their turn for a token instead of racing — a
// burst (e.g. a cache-cold stampede of membership lookups) is metered to
// GLOBAL_RATE/sec rather than overshooting it and risking a 429 / IP ban.
let globalQueue: Promise<void> = Promise.resolve();

function acquireGlobal(): Promise<void> {
  const next = globalQueue.then(async () => {
    refillGlobal();
    if (globalTokens < 1) {
      // Wait just long enough for one token to accrue, then re-check.
      const waitMs = ((1 - globalTokens) / GLOBAL_RATE) * 1000;
      await sleep(waitMs);
      refillGlobal();
    }
    globalTokens -= 1;
  });
  // Keep the chain alive even if a waiter rejects (it shouldn't, but be safe).
  globalQueue = next.catch(() => {});
  return next;
}

async function acquireBucket(bucketId: string): Promise<void> {
  const bucket = buckets.get(bucketId);
  if (!bucket) return;
  if (bucket.remaining > 0) {
    bucket.remaining -= 1;
    return;
  }
  const waitMs = Math.max(0, bucket.resetAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
}

function updateBucket(bucketId: string, remaining: number, resetAfterSec: number) {
  buckets.set(bucketId, {
    remaining,
    resetAt: Date.now() + resetAfterSec * 1000,
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const DISCORD_TIMEOUT_MS = 8000;

async function request(
  path: string,
  init: RequestInit,
  logger?: FastifyBaseLogger,
  retries = 0,
): Promise<Response> {
  await acquireGlobal();

  const url = `${DISCORD_API}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Discord request timed out after ${DISCORD_TIMEOUT_MS}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const bucketId = res.headers.get("X-RateLimit-Bucket");
  const remaining = parseInt(res.headers.get("X-RateLimit-Remaining") ?? "1", 10);
  const resetAfter = parseFloat(res.headers.get("X-RateLimit-Reset-After") ?? "0");

  if (bucketId) {
    updateBucket(bucketId, remaining, resetAfter);
    await acquireBucket(bucketId);
  }

  if (res.status === 429) {
    if (retries >= 3) {
      throw new Error(`Discord rate limit exceeded after 3 retries: ${path}`);
    }
    const retryAfterSec = parseFloat(res.headers.get("Retry-After") ?? "1");
    const retryAfterMs = retryAfterSec * 1000;
    logger?.warn({ route: path, bucket: bucketId, retry_after_ms: retryAfterMs }, "Discord rate limit hit");
    await sleep(retryAfterMs);
    return request(path, init, logger, retries + 1);
  }

  return res;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface DiscordGuildMember {
  roles: string[]; // Discord role IDs
  nick: string | null;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  roles: DiscordRole[];
}

export const discord = {
  async getCurrentUser(accessToken: string, logger?: FastifyBaseLogger): Promise<DiscordUser> {
    const res = await request(
      "/users/@me",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      logger,
    );
    if (!res.ok) {
      throw new Error(`Discord /users/@me failed: ${res.status}`);
    }
    return res.json() as Promise<DiscordUser>;
  },

  // Any user's public profile, via the bot token. Returns null for unknown users.
  async getUser(userId: string, logger?: FastifyBaseLogger): Promise<DiscordUser | null> {
    const res = await request(
      `/users/${userId}`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
      logger,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Discord /users/${userId} failed: ${res.status}`);
    }
    return res.json() as Promise<DiscordUser>;
  },

  // Returns null when the user is not a member of the guild.
  // Uses the bot token so OAuth only needs the identify scope.
  async getGuildMember(
    guildId: string,
    userId: string,
    logger?: FastifyBaseLogger,
  ): Promise<DiscordGuildMember | null> {
    const res = await request(
      `/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } },
      logger,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Discord /guilds/${guildId}/members/${userId} failed: ${res.status}`);
    }
    return res.json() as Promise<DiscordGuildMember>;
  },

  // Returns all roles for a guild. Requires a bot token — the bot must be in the guild.
  async getGuildRoles(guildId: string, botToken: string, logger?: FastifyBaseLogger): Promise<DiscordRole[]> {
    const res = await request(
      `/guilds/${guildId}/roles`,
      { headers: { Authorization: `Bot ${botToken}` } },
      logger,
    );
    if (!res.ok) {
      throw new Error(`Discord /guilds/${guildId}/roles failed: ${res.status}`);
    }
    return res.json() as Promise<DiscordRole[]>;
  },
};
