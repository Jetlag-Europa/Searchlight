import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { env } from "../lib/env.js";
import { resolveSession } from "../lib/session.js";
import { assertParticipant } from "./session-content.js";

// What the location tracker (Google Maps location sharing, read by a Playwright
// container outside this repo) answers on GET /people.
interface TrackerState {
  ok: boolean;
  updatedAt: number | null;
  error: string | null;
  people: {
    id: string;
    name: string;
    photoUrl: string | null;
    lat: number;
    lng: number;
    accuracy: number | null;
    timestamp: number | null;
    battery: number | null;
    charging: boolean | null;
  }[];
}

export async function liveLocationRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/live-locations — everyone sharing their location
  // with the tracker's Google account. Each device picks whom to show.
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
      await assertParticipant(sessionId, user.discordId);

      reply.header("cache-control", "no-store");
      let state: TrackerState;
      try {
        const res = await fetch(new URL("/people", env.LOCATION_TRACKER_URL), {
          signal: AbortSignal.timeout(5_000),
        });
        state = (await res.json()) as TrackerState;
      } catch (err) {
        req.log.warn({ err }, "Location tracker unreachable");
        return reply.status(503).send({ error: "The location tracker isn't running" });
      }

      return {
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
      };
    },
  );
}
