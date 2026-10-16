import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { resolveSession } from "../lib/session.js";
import { overpassJson } from "../lib/overpass.js";

// Overpass settings a client query may not exceed. The frontend asks for at
// most [timeout:60]; 80 s stays under the 90 s fetch timeout below, so Overpass
// gives up before we do. 512 MiB is Overpass's own default maxsize.
const MAX_TIMEOUT_S = 80;
const MAX_MAXSIZE_BYTES = 512 * 1024 * 1024;

// Per-user limits. Free play is open to every logged-in Discord user (Home
// Games needs no server membership), so these, not membership, keep one account
// from monopolising the private instance. A token bucket allows a burst of 120
// (a cold free-play load with many questions), then 60 per minute.
const RATE_LIMIT_BURST = 120;
const RATE_LIMIT_PER_MINUTE = 60;
const MAX_IN_FLIGHT_PER_USER = 6;

// The settings statement: one or more [key:value] blocks ending in ";", first
// in the query.
const SETTINGS_RE = /^(\s*)((?:\[[^[\]]*\]\s*)+);/;
const SETTING_RE = /\[\s*(\w+)\s*:\s*([^\]]*?)\s*\]/g;

function clampSetting(value: string, max: number): number {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : max;
}

// Clamps [timeout] and [maxsize] in the query's settings, adding them when
// absent. Without a settings statement one is prepended; a query that hides its
// settings from this parse (e.g. behind a comment) then has two, which
// Overpass rejects.
export function boundQuerySettings(query: string): string {
    const match = SETTINGS_RE.exec(query);
    if (!match) {
        return `[timeout:${MAX_TIMEOUT_S}][maxsize:${MAX_MAXSIZE_BYTES}];\n${query}`;
    }
    let hasTimeout = false;
    let hasMaxsize = false;
    let settings = match[2].trimEnd().replace(SETTING_RE, (whole, key: string, value: string) => {
        switch (key.toLowerCase()) {
            case "timeout":
                hasTimeout = true;
                return `[timeout:${clampSetting(value, MAX_TIMEOUT_S)}]`;
            case "maxsize":
                hasMaxsize = true;
                return `[maxsize:${clampSetting(value, MAX_MAXSIZE_BYTES)}]`;
            default:
                return whole;
        }
    });
    if (!hasTimeout) settings += `[timeout:${MAX_TIMEOUT_S}]`;
    if (!hasMaxsize) settings += `[maxsize:${MAX_MAXSIZE_BYTES}]`;
    return `${match[1]}${settings};${query.slice(match[0].length)}`;
}

const tooManyRequests = () =>
    Object.assign(new Error("Too many Overpass requests"), { statusCode: 429 });

// POST /overpass — generic Overpass proxy. The frontend funnels every Overpass
// query through here so requests reach the self-hosted instance (LocalOverpass,
// possibly behind Cloudflare Access) instead of the browser hitting public servers
// directly — the browser can't safely hold the CF-Access service token. Auth is
// enforced via resolveSession (throws 401 when unauthenticated), and each query's
// settings, response size and per-user rate are bounded, so this is not an open
// proxy. The raw Overpass JSON is returned unchanged.
export async function overpassRoutes(app: FastifyInstance) {
    // Single API instance, so in-memory state is enough.
    const buckets = new Map<string, { tokens: number; updatedAt: number }>();
    const inFlight = new Map<string, number>();

    app.post(
        "/overpass",
        {
            schema: {
                body: Type.Object({
                    query: Type.String({ minLength: 1, maxLength: 100_000 }),
                }),
            },
        },
        async (req, reply) => {
            const { user } = await resolveSession(req);
            const userId = user.discordId;
            const { query } = req.body as { query: string };

            const running = inFlight.get(userId) ?? 0;
            if (running >= MAX_IN_FLIGHT_PER_USER) throw tooManyRequests();

            const now = Date.now();
            const bucket = buckets.get(userId) ?? { tokens: RATE_LIMIT_BURST, updatedAt: now };
            bucket.tokens = Math.min(
                RATE_LIMIT_BURST,
                bucket.tokens + ((now - bucket.updatedAt) / 60_000) * RATE_LIMIT_PER_MINUTE,
            );
            bucket.updatedAt = now;
            buckets.set(userId, bucket);
            if (bucket.tokens < 1) {
                const waitMs = ((1 - bucket.tokens) / RATE_LIMIT_PER_MINUTE) * 60_000;
                reply.header("retry-after", Math.ceil(waitMs / 1000));
                throw tooManyRequests();
            }
            bucket.tokens -= 1;

            inFlight.set(userId, running + 1);
            try {
                // Frontend queries use [timeout:60] and can be heavy (large poly:
                // zone filters); allow more headroom than the boundary-route default.
                return await overpassJson(boundQuerySettings(query), { timeoutMs: 90_000 });
            } finally {
                const left = (inFlight.get(userId) ?? 1) - 1;
                if (left > 0) inFlight.set(userId, left);
                else inFlight.delete(userId);
            }
        },
    );
}
