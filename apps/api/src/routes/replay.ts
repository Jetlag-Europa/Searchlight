import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { getUserPermissions } from "../lib/permissions.js";
import { resolveSession } from "../lib/session.js";
import { assertParticipant } from "./session-content.js";

// Tracker stack: what a session replay needs. The question list after every
// change (the web app works out which questions were really asked), and, for
// users with locations.view, the logged positions of the people sharing with
// the server's account while the session ran.

// Positions this long before the first question change, and this long after
// the last (the seekers still have to walk up to the hider), but never more
// than MAX_SPAN_MS after the first: a session edited days later mustn't hand
// out days of everyone's whereabouts.
const MARGIN_MS = 15 * 60_000;
const AFTER_MS = 30 * 60_000;
const MAX_SPAN_MS = 12 * 60 * 60_000;

interface StoredQuestion {
  ordinal: number;
  payloadJson: unknown;
}

export async function replayRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/replay
  app.get(
    "/:sessionId/replay",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      const session = await assertParticipant(sessionId, user.discordId);

      const events = await prisma.event.findMany({
        where: { sessionId, type: "questions.replace" },
        orderBy: { sequence: "asc" },
        select: { serverReceivedAt: true, payloadJson: true },
      });
      const snapshots = events.map((e) => {
        const stored = ((e.payloadJson as { questions?: StoredQuestion[] }).questions ?? []).slice();
        stored.sort((a, b) => a.ordinal - b.ordinal);
        return { at: e.serverReceivedAt.getTime(), questions: stored.map((q) => q.payloadJson) };
      });
      // Moments a game's log recorded (the endgame, the hider found), for
      // sessions copied in from a log rather than played here.
      const marks: { endgame: number | null; found: number | null } = { endgame: null, found: null };
      for (const e of await prisma.event.findMany({
        where: { sessionId, type: "replay.mark" },
        orderBy: { sequence: "asc" },
        select: { serverReceivedAt: true, payloadJson: true },
      })) {
        const kind = (e.payloadJson as { kind?: unknown }).kind;
        if (kind === "endgame" || kind === "found") marks[kind] ??= e.serverReceivedAt.getTime();
      }

      const perms = await getUserPermissions(user.discordId, session.serverId, true, req.log);
      const server = await prisma.server.findUnique({
        where: { id: session.serverId },
        select: { locationAccount: true },
      });
      const account = server?.locationAccount ?? null;
      const canSeeLocations = perms.has("locations.view") && account !== null;

      const people: {
        id: string;
        name: string;
        label: string | null;
        pinned: boolean;
        // [time ms, lat, lng, accuracy m]
        positions: [number, number, number, number | null][];
      }[] = [];
      if (canSeeLocations && snapshots.length > 0) {
        const pins = (session.livePins ?? {}) as { shown?: string[]; labels?: Record<string, string> };
        const rows = await prisma.locationLog.findMany({
          where: {
            account,
            recordedAt: {
              gte: new Date(snapshots[0]!.at - MARGIN_MS),
              lte: new Date(
                Math.min(snapshots[snapshots.length - 1]!.at + AFTER_MS, snapshots[0]!.at + MAX_SPAN_MS),
              ),
            },
          },
          orderBy: { recordedAt: "asc" },
          select: { personId: true, name: true, lat: true, lng: true, accuracy: true, recordedAt: true },
        });
        const byPerson = new Map<string, (typeof people)[number]>();
        for (const r of rows) {
          let person = byPerson.get(r.personId);
          if (!person) {
            person = {
              id: r.personId,
              name: r.name,
              label: pins.labels?.[r.personId] ?? null,
              pinned: pins.shown?.includes(r.personId) ?? false,
              positions: [],
            };
            byPerson.set(r.personId, person);
            people.push(person);
          }
          person.name = r.name;
          person.positions.push([r.recordedAt.getTime(), r.lat, r.lng, r.accuracy]);
        }
      }

      return {
        session: {
          id: session.id,
          name: session.name,
          gameId: session.gameId,
          gameRevisionId: session.gameRevisionId,
        },
        snapshots,
        marks,
        canSeeLocations,
        people,
        // The session's hider location (hider mode), for finding the endgame
        // without live locations.
        hider:
          session.hiderLat !== null && session.hiderLng !== null
            ? { lat: session.hiderLat, lng: session.hiderLng }
            : null,
      };
    },
  );
}
