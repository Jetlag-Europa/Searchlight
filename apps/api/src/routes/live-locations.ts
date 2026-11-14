import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { forbidden, notFound } from "../lib/http-errors.js";
import { fetchTracker, putTrackerCookies, type TrackerAccount, type TrackerState } from "../lib/location-tracker.js";
import { getUserPermissions, isAdmin } from "../lib/permissions.js";
import { resolveSession } from "../lib/session.js";
import { resolveSessionAccess } from "../lib/session-access.js";

// Global admins give each server one of the location tracker's Google
// accounts; a session shows the people sharing with its server's account, and
// stores which of them are pinned.

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

function readPins(value: unknown): LivePins {
  const v = (value ?? {}) as Partial<LivePins>;
  return {
    shown: Array.isArray(v.shown) ? v.shown.filter((id) => typeof id === "string") : [],
    labels: v.labels && typeof v.labels === "object" ? v.labels : {},
  };
}

// Throws unless the user is in the session, not as a spectator, and has
// locations.view on its server. Spectators never see the hider's position, so
// not the live locations either.
async function assertCanSeeLocations(sessionId: string, userId: string, log: FastifyInstance["log"]) {
  const { session, role } = await resolveSessionAccess(sessionId, userId);
  if (role === "viewer") throw forbidden("Spectators can't see live locations");
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

// Under /servers. Only global admins (ADMIN_DISCORD_IDS) choose accounts: a
// server's account decides whose locations its sessions can show. A server's
// admins (server.admin) see how its account is doing and can upload new
// cookies when Google logs it out.

const MAX_COOKIES_LENGTH = 200_000;

function badRequest(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// The server, if the user is a global admin or has server.admin on it.
async function serverForAdmin(serverId: string, userId: string, log: FastifyInstance["log"]) {
  const server = await prisma.server.findUnique({
    where: { id: serverId },
    select: { id: true, locationAccount: true },
  });
  if (!server) throw notFound("Server not found");
  const globalAdmin = isAdmin(userId);
  if (!globalAdmin && !(await getUserPermissions(userId, serverId, true, log)).has("server.admin")) {
    throw forbidden();
  }
  return { server, globalAdmin };
}

export async function liveLocationServerRoutes(app: FastifyInstance) {
  // GET /servers/:serverId/location-account — the server's account and how
  // it's doing; for global admins also every account the tracker has.
  app.get(
    "/:serverId/location-account",
    {
      schema: {
        params: Type.Object({ serverId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.params as { serverId: string };
      const { server, globalAdmin } = await serverForAdmin(serverId, user.discordId, req.log);

      reply.header("cache-control", "no-store");
      let accounts: TrackerAccount[] | null = null;
      try {
        accounts = (await fetchTracker<TrackerAccount[]>("/accounts")).body;
      } catch (err) {
        req.log.warn({ err }, "Location tracker unreachable");
      }
      return {
        account: server.locationAccount,
        // Whether this user may pick the account (global admins only).
        canChoose: globalAdmin,
        trackerReachable: accounts !== null,
        // null: the tracker has no cookies for it (or can't be reached).
        status: accounts?.find((a) => a.name === server.locationAccount) ?? null,
        accounts: globalAdmin ? accounts : null,
      };
    },
  );

  // PUT /servers/:serverId/location-account/cookies — new cookies for the
  // server's account (a Cookie-Editor export of the logged-in Google account).
  // The tracker checks them, and restarts the account with them.
  app.put(
    "/:serverId/location-account/cookies",
    {
      schema: {
        params: Type.Object({ serverId: Type.String() }),
        body: Type.Object({
          cookies: Type.String({ minLength: 1, maxLength: MAX_COOKIES_LENGTH }),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.params as { serverId: string };
      const { cookies } = req.body as { cookies: string };
      const { server, globalAdmin } = await serverForAdmin(serverId, user.discordId, req.log);
      const account = server.locationAccount;
      if (!account) throw badRequest("This server has no live locations account yet: a global admin picks one");
      // An account shared with another server: one server's admins mustn't
      // decide whose locations the other's sessions show.
      if (!globalAdmin) {
        const sharing = await prisma.server.count({ where: { locationAccount: account, id: { not: serverId } } });
        if (sharing > 0) throw forbidden("Other servers use this Google account too: ask a global admin to update it");
      }

      let res;
      try {
        res = await putTrackerCookies(account, cookies);
      } catch (err) {
        req.log.warn({ err }, "Location tracker unreachable");
        throw trackerUnavailable();
      }
      if (res.status === 400) throw badRequest(res.body.error ?? "The tracker didn't take these cookies");
      if (res.status !== 200) {
        req.log.warn({ status: res.status }, "Location tracker refused cookies");
        throw trackerUnavailable();
      }
      // Never log the cookies themselves.
      req.log.info({ serverId, account, by: user.discordId }, "Location account cookies replaced");
      return { ok: true };
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
