// All Discord REST calls must go through this module.
// Never call https://discord.com/api/v10/* from anywhere else.

import type { FastifyBaseLogger } from "fastify";

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

async function acquireGlobal(): Promise<void> {
  refillGlobal();
  if (globalTokens >= 1) {
    globalTokens -= 1;
    return;
  }
  const waitMs = ((1 - globalTokens) / GLOBAL_RATE) * 1000;
  await sleep(waitMs);
  globalTokens = 0;
  globalLastRefill = Date.now();
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

async function request(
  path: string,
  init: RequestInit,
  logger?: FastifyBaseLogger,
  retries = 0,
): Promise<Response> {
  await acquireGlobal();

  const url = `${DISCORD_API}${path}`;
  const res = await fetch(url, init);

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

  // Returns null when the user is not a member of the guild.
  async getGuildMember(
    guildId: string,
    accessToken: string,
    logger?: FastifyBaseLogger,
  ): Promise<DiscordGuildMember | null> {
    const res = await request(
      `/users/@me/guilds/${guildId}/member`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      logger,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Discord /users/@me/guilds/${guildId}/member failed: ${res.status}`);
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
