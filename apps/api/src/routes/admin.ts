import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { isAdmin } from "../lib/permissions.js";

const forbidden = () => Object.assign(new Error("Forbidden"), { statusCode: 403 });

export async function adminRoutes(app: FastifyInstance) {
  // GET /admin/google-map-loads?month=YYYY-MM — the Google map loads the web
  // app reported in a UTC month (default: this one), per user and per day.
  // For the instance's admins (ADMIN_DISCORD_IDS), who pay for the key.
  app.get(
    "/google-map-loads",
    {
      schema: {
        querystring: Type.Object({
          month: Type.Optional(Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" })),
        }),
        response: {
          200: Type.Object({
            month: Type.String(),
            total: Type.Integer(),
            users: Type.Array(
              Type.Object({
                discordId: Type.String(),
                displayName: Type.String(),
                username: Type.String(),
                loads: Type.Integer(),
              }),
            ),
            days: Type.Array(Type.Object({ day: Type.String(), loads: Type.Integer() })),
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      if (!isAdmin(user.discordId)) throw forbidden();
      const month =
        (req.query as { month?: string }).month ?? new Date().toISOString().slice(0, 7);
      const start = new Date(`${month}-01T00:00:00Z`);
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1);
      const inMonth = { createdAt: { gte: start, lt: end } };

      const [byUser, days] = await Promise.all([
        prisma.googleMapLoad.groupBy({
          by: ["userId"],
          where: inMonth,
          _count: { _all: true },
        }),
        prisma.$queryRaw<{ day: string; loads: number }[]>`
          SELECT to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
                 COUNT(*)::int AS loads
          FROM "GoogleMapLoad"
          WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
          GROUP BY 1
          ORDER BY 1
        `,
      ]);
      const names = await prisma.user.findMany({
        where: { discordId: { in: byUser.map((u) => u.userId) } },
        select: { discordId: true, displayName: true, username: true },
      });
      const nameOf = new Map(names.map((n) => [n.discordId, n]));
      const users = byUser
        .map((u) => ({
          discordId: u.userId,
          displayName: nameOf.get(u.userId)?.displayName ?? "",
          username: nameOf.get(u.userId)?.username ?? "",
          loads: u._count._all,
        }))
        .sort((a, b) => b.loads - a.loads || a.displayName.localeCompare(b.displayName));

      return {
        month,
        total: users.reduce((sum, u) => sum + u.loads, 0),
        users,
        days,
      };
    },
  );
}
