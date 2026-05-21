import type { FastifyRequest } from "fastify";
import prisma from "./prisma.js";

export interface ResolvedUser {
  discordId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  discordAccessToken: string;
  discordRefreshToken: string;
  discordTokenExpiresAt: Date;
}

const unauthorized = () => Object.assign(new Error("Unauthorized"), { statusCode: 401 });

export async function resolveSession(req: FastifyRequest): Promise<{ user: ResolvedUser }> {
  const raw = req.cookies["session"];
  if (!raw) throw unauthorized();

  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) throw unauthorized();

  const session = await prisma.authSession.findUnique({
    where: { id: unsigned.value },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) throw unauthorized();

  return { user: session.user };
}
