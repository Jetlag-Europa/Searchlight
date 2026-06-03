import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { MeResponse, UserPreferences } from "@taibled/shared";
import { resolveSession } from "../lib/session.js";
import prisma from "../lib/prisma.js";

export async function meRoute(app: FastifyInstance) {
  // No response schema — preferences is arbitrary JSON, let Fastify use JSON.stringify
  // rather than fast-json-stringify which may drop fields with no explicit schema.
  app.get("/me", async (req): Promise<MeResponse> => {
    const { user } = await resolveSession(req);
    const { discordId, username, displayName, avatarUrl, preferences } = user;
    return {
      user: { discordId, username, displayName, avatarUrl },
      preferences: (preferences as UserPreferences | null) ?? {},
    };
  });

  app.patch(
    "/me/preferences",
    {
      schema: {
        body: Type.Any(),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      app.log.info({ userId: user.discordId }, "[taibled:prefs] saving preferences");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.user.update({
        where: { discordId: user.discordId },
        data: { preferences: req.body } as any,
      });
      return reply.status(204).send();
    },
  );
}
