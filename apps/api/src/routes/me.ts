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
        body: Type.Any(),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      app.log.info({ userId: user.discordId }, "[searchlight:prefs] saving preferences");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.user.update({
        where: { discordId: user.discordId },
        data: { preferences: req.body } as any,
      });
      return reply.status(204).send();
    },
  );

  // One Google map the web app created, which Google bills as a map load.
  // Only counted, for the admin page (GET /admin/google-map-loads).
  app.post(
    "/me/google-map-loads",
    {
      schema: {
        body: Type.Object({
          sessionId: Type.Optional(Type.String({ maxLength: 64 })),
        }),
        response: { 204: Type.Null() },
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.body as { sessionId?: string };
      await prisma.googleMapLoad.create({
        data: { userId: user.discordId, sessionId: sessionId || null },
      });
      return reply.status(204).send();
    },
  );
}
