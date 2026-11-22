import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { USAGE_EVENTS, type UsageEvent, type UsageResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { isAdmin } from "../lib/permissions.js";
import { forbidden } from "../lib/http-errors.js";

export async function usageRoutes(app: FastifyInstance) {
  // POST /usage — public: adds one to today's count of the event.
  app.post(
    "/",
    {
      schema: {
        body: Type.Object({ event: Type.Union(USAGE_EVENTS.map((e) => Type.Literal(e))) }),
      },
    },
    async (req, reply) => {
      const { event } = req.body as { event: UsageEvent };
      await prisma.$executeRaw`
        INSERT INTO "UsageCount" (day, event, count)
        VALUES ((now() AT TIME ZONE 'UTC')::date, ${event}, 1)
        ON CONFLICT (day, event) DO UPDATE SET count = "UsageCount".count + 1
      `;
      return reply.status(204).send();
    },
  );

  // GET /usage — totals per event, for global admins.
  app.get("/", async (req): Promise<UsageResponse> => {
    const { user } = await resolveSession(req);
    if (!isAdmin(user.discordId)) throw forbidden();
    const counts = await prisma.$queryRaw<UsageResponse["counts"]>`
      SELECT event,
        COALESCE(SUM(count) FILTER (WHERE day > (now() AT TIME ZONE 'UTC')::date - 7), 0)::int AS "last7d",
        COALESCE(SUM(count) FILTER (WHERE day > (now() AT TIME ZONE 'UTC')::date - 30), 0)::int AS "last30d",
        SUM(count)::int AS total
      FROM "UsageCount"
      GROUP BY event
    `;
    return { counts };
  });
}
