import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { env } from "../lib/env.js";
import { forbidden, notFound } from "../lib/http-errors.js";
import { getUserPermissions, isAdmin } from "../lib/permissions.js";
import { resolveSession } from "../lib/session.js";
import { assertParticipant } from "./session-content.js";

// The location tracker (searchlight-tracker, a Playwright container outside
// this repo) reads Google Maps location sharing for several Google accounts.
// Global admins give each server an account; a session shows the people
// sharing with its server's account, and stores which of them are pinned.

interface TrackerPerson {
  id: string;
  name: string;
  photoUrl: string | null;
  lat: number;
  lng: number;
  accuracy: number | null;
  timestamp: number | null;
  battery: number | null;
  charging: boolean | null;
}

// GET /people?account= on the tracker.
interface TrackerState {
  ok: boolean;
  updatedAt: number | null;
  error: string | null;
  people: TrackerPerson[];
}

// GET /accounts on the tracker.
interface TrackerAccount {
  name: string;
  ok: boolean;
  error: string | null;
  updatedAt: number | null;
  people: number;
}

interface LivePins {
  shown: string[];
  labels: Record<string, string>;
}

const ACCOUNT_NAME = "^[a-z0-9-]{1,40}$";
const MAX_LABEL = 40;
const MAX_PINS = 100;

function trackerUnavailable() {
  return Object.assign(new Error("The location tracker isn't running"), { statusCode: 503 });
}

async function fetchTracker<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(new URL(path, env.LOCATION_TRACKER_URL), {
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function readPins(value: unknown): LivePins {
  const v = (value ?? {}) as Partial<LivePins>;
  return {
    shown: Array.isArray(v.shown) ? v.shown.filter((id) => typeof id === "string") : [],
    labels: v.labels && typeof v.labels === "object" ? v.labels : {},
  };
}

// Throws unless the user is in the session and has locations.view on its server.
async function assertCanSeeLocations(sessionId: string, userId: string, log: FastifyInstance["log"]) {
  const session = await assertParticipant(sessionId, userId);
  const perms = await getUserPermissions(userId, session.serverId, true, log);
  if (!perms.has("locations.view")) {
    throw forbidden("Your roles on this server don't include seeing live locations");
  }
  return session;
}

export async function liveLocationRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/live-locations — the people sharing with the
  // server's account, and the session's pins. Needs locations.view on the
  // session's server: admins map it to Discord roles on the admin page, and
  // global admins always have it.
  app.get(
    "/:sessionId/live-locations",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const session = await assertCanSeeLocations(sessionId, user.discordId, req.log);
      const server = await prisma.server.findUnique({
        where: { id: session.serverId },
        select: { locationAccount: true },
      });
      const pins = readPins(session.livePins);

      reply.header("cache-control", "no-store");
      const account = server?.locationAccount ?? null;
      if (!account) {
        return { account: null, ok: false, updatedAt: null, error: null, people: [], ...pins };
      }

      let state: TrackerState;
      try {
        const res = await fetchTracker<TrackerState>(`/people?account=${encodeURIComponent(account)}`);
        state =
          res.status === 404
            ? { ok: false, updatedAt: null, error: `The account "${account}" has no cookies yet`, people: [] }
            : res.body;
      } catch (err) {
        req.log.warn({ err }, "Location tracker unreachable");
        throw trackerUnavailable();
      }

      return {
        account,
        ok: state.ok,
        updatedAt: state.updatedAt,
        error: state.error,
        people: state.people.map((p) => ({
          id: p.id,
          name: p.name,
          photoUrl: p.photoUrl,
          lat: p.lat,
          lng: p.lng,
          accuracy: p.accuracy,
          timestamp: p.timestamp,
          battery: p.battery,
          charging: p.charging,
        })),
        ...pins,
      };
    },
  );

  // PATCH /sessions/:sessionId/live-locations — pin or unpin one person, or
  // rename their pin (an empty label goes back to their Google name).
  app.patch(
    "/:sessionId/live-locations",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        body: Type.Object({
          personId: Type.String({ minLength: 1, maxLength: 100 }),
          shown: Type.Optional(Type.Boolean()),
          label: Type.Optional(Type.Union([Type.String({ maxLength: MAX_LABEL }), Type.Null()])),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const { personId, shown, label } = req.body as {
        personId: string;
        shown?: boolean;
        label?: string | null;
      };
      await assertCanSeeLocations(sessionId, user.discordId, req.log);

      // Row lock, so two people editing pins at once don't undo each other.
      return prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ livePins: unknown }[]>`
          SELECT "livePins" FROM "GameSession" WHERE id = ${sessionId} FOR UPDATE
        `;
        if (!row) throw notFound("Session not found");
        const pins = readPins(row.livePins);
        if (shown !== undefined) {
          pins.shown = pins.shown.filter((id) => id !== personId);
          if (shown) pins.shown.push(personId);
          pins.shown = pins.shown.slice(-MAX_PINS);
        }
        if (label !== undefined) {
          const trimmed = label?.trim();
          if (trimmed) pins.labels[personId] = trimmed;
          else delete pins.labels[personId];
          const ids = Object.keys(pins.labels);
          for (const id of ids.slice(0, Math.max(0, ids.length - MAX_PINS))) delete pins.labels[id];
        }
        await tx.gameSession.update({ where: { id: sessionId }, data: { livePins: pins as object } });
        return pins;
      });
    },
  );
}

// Under /servers. Only global admins (ADMIN_DISCORD_IDS) choose accounts:
// a server's account decides whose locations its sessions can show.
export async function liveLocationServerRoutes(app: FastifyInstance) {
  // GET /servers/:serverId/location-account — the server's account and the
  // tracker's accounts.
  app.get(
    "/:serverId/location-account",
    {
      schema: {
        params: Type.Object({ serverId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      if (!isAdmin(user.discordId)) throw forbidden();
      const { serverId } = req.params as { serverId: string };
      const server = await prisma.server.findUnique({
        where: { id: serverId },
        select: { locationAccount: true },
      });
      if (!server) throw notFound("Server not found");

      let accounts: TrackerAccount[] | null = null;
      try {
        accounts = (await fetchTracker<TrackerAccount[]>("/accounts")).body;
      } catch (err) {
        req.log.warn({ err }, "Location tracker unreachable");
      }
      return { account: server.locationAccount, accounts };
    },
  );

  // PUT /servers/:serverId/location-account — set or clear the account. Any
  // name is accepted, so a server can be set up before the account's cookies.
  app.put(
    "/:serverId/location-account",
    {
      schema: {
        params: Type.Object({ serverId: Type.String() }),
        body: Type.Object({
          account: Type.Union([Type.String({ pattern: ACCOUNT_NAME }), Type.Null()]),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      if (!isAdmin(user.discordId)) throw forbidden();
      const { serverId } = req.params as { serverId: string };
      const { account } = req.body as { account: string | null };
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw notFound("Server not found");
      await prisma.server.update({ where: { id: serverId }, data: { locationAccount: account } });
      req.log.info({ serverId, account, by: user.discordId }, "Location account changed");
      return { account };
    },
  );
}
