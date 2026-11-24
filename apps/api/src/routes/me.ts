import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { MeResponse, UserPreferences } from "@searchlight/shared";
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
        body: Type.Record(Type.String(), Type.Unknown()),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      app.log.info({ userId: user.discordId }, "[searchlight:prefs] saving preferences");
      // Merged in one statement: a device sends only the keys it changed, and
      // two devices saving at once both keep theirs.
      await prisma.$executeRaw`
        UPDATE "User"
        SET preferences = (CASE WHEN jsonb_typeof(preferences) = 'object' THEN preferences
            ELSE '{}'::jsonb END) || ${JSON.stringify(req.body)}::jsonb,
          "updatedAt" = now()
        WHERE "discordId" = ${user.discordId}
      `;
      return reply.status(204).send();
    },
  );
}
