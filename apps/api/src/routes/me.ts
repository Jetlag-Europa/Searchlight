import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { MeResponse } from "@taibled/shared";
import { resolveSession } from "../lib/session.js";

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
      const { user } = await resolveSession(req);
      const { discordId, username, displayName, avatarUrl } = user;
      return { user: { discordId, username, displayName, avatarUrl } };
    },
  );
}
