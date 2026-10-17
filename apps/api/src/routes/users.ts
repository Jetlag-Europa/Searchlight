import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import prisma from "../lib/prisma.js";
import { assertServerMembership } from "../lib/permissions.js";
import { resolveSession } from "../lib/session.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";

export async function userRoutes(app: FastifyInstance) {
  // GET /users/search?serverId=&q= — search authed users in a server by display name / username
  app.get(
    "/search",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.String({ minLength: 1 }),
          q: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId, q } = req.query as { serverId: string; q: string };

      const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      // Only a server's members may search it. Virtual servers have no Discord
      // guild to check (and no members to find).
      if (!VIRTUAL_SERVER_IDS.has(serverId)) {
        await assertServerMembership(user.discordId, serverId, req.log);
      }

      // Find users whose cached membership says they are in this server (i.e. they've logged in
      // and their guild membership has been fetched at least once) and whose username or
      // displayName matches the query. Exclude the requesting user themselves.
      const users = await prisma.user.findMany({
        where: {
          discordId: { not: user.discordId },
          membershipCaches: { some: { serverId, isMember: true } },
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { displayName: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          discordId: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
        take: 10,
      });

      return { users };
    },
  );
}
