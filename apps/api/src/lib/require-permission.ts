import type { FastifyRequest, FastifyReply } from "fastify";
import { resolveSession } from "./session.js";
import { getUserPermissions } from "./permissions.js";
import prisma from "./prisma.js";

const forbidden = () => Object.assign(new Error("Forbidden"), { statusCode: 403 });

export function requirePermission(
  permission: string,
  getServerId: (req: FastifyRequest) => string,
  forceRefresh = false,
) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const { user } = await resolveSession(req);
    const serverId = getServerId(req);

    const server = await prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

    const perms = await getUserPermissions(
      user.discordId,
      serverId,
      user.discordAccessToken,
      forceRefresh,
      req.log,
    );

    if (!perms.has(permission)) throw forbidden();
  };
}
