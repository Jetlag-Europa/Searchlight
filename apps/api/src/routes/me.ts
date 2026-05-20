import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { MeResponse } from "@taibled/shared";
import prisma from "../lib/prisma.js";

const unauthorized = () => Object.assign(new Error("Unauthorized"), { statusCode: 401 });

export async function meRoute(app: FastifyInstance) {
  app.get(
    "/me",
    {
      schema: {
        response: {
          200: Type.Object({
            user: Type.Object({
              discordId: Type.String(),
              username: Type.String(),
              displayName: Type.String(),
              avatarUrl: Type.String(),
            }),
          }),
        },
      },
    },
    async (req): Promise<MeResponse> => {
      const raw = req.cookies["session"];
      if (!raw) throw unauthorized();

      const unsigned = req.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) throw unauthorized();

      const session = await prisma.authSession.findUnique({
        where: { id: unsigned.value },
        include: { user: true },
      });

      if (!session || session.expiresAt < new Date()) throw unauthorized();

      const { discordId, username, displayName, avatarUrl } = session.user;
      return { user: { discordId, username, displayName, avatarUrl } };
    },
  );
}
