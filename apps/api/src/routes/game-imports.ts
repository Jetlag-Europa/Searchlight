import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type ImportActor,
  ImportConflictError,
  ImportForbiddenError,
  importGameDefinition,
  ImportValidationError,
} from "../games/import-service.js";
import { assertGameAccess, findGameByIdOrKey } from "../lib/game-access.js";
import { getUserPermissions, hasPermissionOnSomeServer } from "../lib/permissions.js";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { listedSessionsWhere } from "../lib/session-access.js";

// Game definitions embed full GeoJSON boundaries; preloaded ones reach ~8 MB,
// well past Fastify's 1 MiB default.
const MAX_GAME_IMPORT_BYTES = 50 * 1024 * 1024;
// A broken multi-MB definition can produce an issue per feature; the message
// still states the total.
const MAX_REPORTED_ISSUES = 100;
// What canCreateGames and canEditGames accept from a logged-in user.
const IMPORT_PERMISSIONS = ["games.create", "games.edit", "server.admin"];

declare module "fastify" {
  interface FastifyRequest {
    // Set by POST /games/import's onRequest hook.
    importActor: ImportActor | null;
  }
}

export async function resolveImportActor(
  req: FastifyRequest,
): Promise<ImportActor> {
  // Session cookie auth
  const { user } = await resolveSession(req);
  // Turn away users who can't import anywhere before the body is parsed; the
  // import checks the target server.
  if (!(await hasPermissionOnSomeServer(user.discordId, IMPORT_PERMISSIONS, req.log))) {
    throw new ImportForbiddenError("You do not have permission to import games");
  }
  return {
    userId: user.discordId,
    async canCreateGames(serverId: string) {
      const perms = await getUserPermissions(user.discordId, serverId, true, req.log);
      return perms.has("games.create") || perms.has("server.admin");
    },
    async canEditGames(serverId: string) {
      const perms = await getUserPermissions(user.discordId, serverId, true, req.log);
      return perms.has("games.edit") || perms.has("server.admin");
    },
  };
}

// A proxy that compresses or recompresses responses weakens ETags (W/"..."),
// and If-None-Match may list several tags.
function matchesETag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .some((tag) => tag.trim().replace(/^W\//, "") === etag);
}

// RFC 6266: the quoted filename must be plain ASCII, so non-ASCII names go in
// the RFC 5987 filename* parameter (which clients prefer when present).
function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function loadDefinition(revisionId: string): Promise<unknown> {
  const rev = await prisma.gameRevision.findUnique({
    where: { id: revisionId },
    select: { definition: true },
  });
  return rev?.definition;
}

async function assertGameDefinitionAccess({
  req,
  game,
  revisionIds,
  session,
}: {
  req: FastifyRequest;
  game: { id: string; serverId: string; unlisted: boolean; createdById: string | null };
  // The requested revision and the game's current one; each one's role gate applies.
  revisionIds: (string | null | undefined)[];
  // Only for routes serving a single revision: participants of a session pinned
  // to that revision may read it without access to the game. A session shares
  // nothing else (not the export, the current revision or other revisions).
  session?: { id: string | undefined; revisionId: string };
}): Promise<void> {
  // 2. Cookie session auth
  const { user } = await resolveSession(req);

  // 3. Shared session access check: the sessions GET /sessions lists for the
  // user, viewers' included
  if (session?.id) {
    const pinned = await prisma.gameSession.findFirst({
      where: {
        id: session.id,
        gameId: game.id,
        gameRevisionId: session.revisionId,
        ...listedSessionsWhere(user.discordId),
      },
      select: { id: true },
    });

    if (pinned) {
      return; // Authorized via session
    }
  }

  // 4. Server membership and Discord role visibility checks
  await assertGameAccess(user.discordId, game, revisionIds, req.log);
}

export async function gameImportRoutes(app: FastifyInstance) {
  app.decorateRequest("importActor", null);

  // POST /games/import
  app.post(
    "/import",
    {
      bodyLimit: MAX_GAME_IMPORT_BYTES,
      // Authenticate, and check the caller may import on some server, before
      // Fastify reads and parses a body of up to MAX_GAME_IMPORT_BYTES.
      onRequest: async (req) => {
        req.importActor = await resolveImportActor(req);
      },
      schema: {
        querystring: Type.Object({
          dryRun: Type.Optional(Type.Boolean()),
          allowUpdate: Type.Optional(Type.Boolean()),
          // The existing game's revision a dry run showed (its
          // existing.currentRevisionId): the update is refused (409
          // GAME_CHANGED) if the game changed since.
          expectedCurrentRevisionId: Type.Optional(Type.String({ minLength: 1 })),
          expectedServerId: Type.Optional(Type.String()),
          // Only applies when the import creates the game; PATCH /games/:id
          // changes it later. Casual games are always unlisted.
          unlisted: Type.Optional(Type.Boolean()),
        }),
      },
    },
    async (req, reply) => {
      const {
        dryRun = false,
        allowUpdate = false,
        expectedServerId,
        expectedCurrentRevisionId,
        unlisted = false,
      } = req.query as {
        dryRun?: boolean;
        allowUpdate?: boolean;
        expectedServerId?: string;
        expectedCurrentRevisionId?: string;
        unlisted?: boolean;
      };
      const body = req.body as Record<string, unknown> | null | undefined;
      const shouldAllowUpdate = allowUpdate || Boolean(body?.allowUpdate);
      // Like allowUpdate, it may come with the game in the body.
      const bodyRevisionId = body?.expectedCurrentRevisionId;
      const pinnedRevisionId =
        expectedCurrentRevisionId ??
        (typeof bodyRevisionId === "string" && bodyRevisionId ? bodyRevisionId : undefined);
      const actor = req.importActor!;

      try {
        const result = await importGameDefinition({
          raw: (body?.["game"] ?? body) as unknown,
          source: "web",
          actor,
          dryRun,
          expectedServerId,
          allowUpdate: shouldAllowUpdate,
          expectedCurrentRevisionId: pinnedRevisionId,
          unlisted,
        });

        const status = result.status === "created" ? 201 : 200;
        return reply.status(status).send(result);
      } catch (err) {
        if (err instanceof ImportValidationError) {
          return reply.status(400).send({
            error: err.name,
            code: err.code,
            message: err.message,
            errors: err.errors.slice(0, MAX_REPORTED_ISSUES),
            warnings: err.warnings.slice(0, MAX_REPORTED_ISSUES),
          });
        }
        if (err instanceof ImportConflictError) {
          return reply.status(409).send({
            error: err.name,
            code: err.code,
            message: err.message,
            canUpdate: err.canUpdate ?? false,
            existingRevision: err.existingRevision,
            existing: err.existing,
          });
        }
        if (err instanceof ImportForbiddenError) {
          return reply.status(403).send({
            error: err.name,
            code: err.code,
            message: err.message,
          });
        }
        throw err;
      }
    },
  );

  // GET /games/:gameId/export
  app.get(
    "/:gameId/export",
    async (req, reply) => {
      const { gameId } = req.params as { gameId: string };
      const game = await findGameByIdOrKey(gameId, {
        currentRevision: { select: { id: true, checksum: true } },
      });

      if (!game) {
        return reply.status(404).send({ error: "Game not found" });
      }

      const revision = game.currentRevision;
      if (!revision) {
        return reply.status(404).send({ error: "Game definition not found" });
      }

      await assertGameDefinitionAccess({
        req,
        game,
        revisionIds: [revision.id],
      });

      const etag = `"${revision.checksum}"`;
      if (matchesETag(req.headers["if-none-match"], etag)) {
        return reply.status(304).send();
      }

      const definition = await loadDefinition(revision.id);
      if (!definition) {
        return reply.status(404).send({ error: "Game definition not found" });
      }

      // Compact JSON: pretty-printing made definitions ~4.5x larger on the
      // wire. Downloads are re-formatted client-side.
      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("ETag", etag)
        .header("Content-Disposition", attachmentDisposition(`${game.gameKey}.game.json`))
        .send(JSON.stringify(definition));
    },
  );

  // GET /games/revisions/:revisionId
  app.get(
    "/revisions/:revisionId",
    {
      schema: {
        querystring: Type.Object({
          sessionId: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const { revisionId } = req.params as { revisionId: string };
      const { sessionId } = req.query as { sessionId?: string };

      const rev = await prisma.gameRevision.findUnique({
        where: { id: revisionId },
        select: { id: true, checksum: true, game: true },
      });
      if (!rev) {
        return reply.status(404).send({ error: "Revision not found" });
      }

      await assertGameDefinitionAccess({
        req,
        game: rev.game,
        revisionIds: [rev.id, rev.game.currentRevisionId],
        session: { id: sessionId, revisionId: rev.id },
      });

      const etag = `"${rev.checksum}"`;
      if (matchesETag(req.headers["if-none-match"], etag)) {
        return reply.status(304).send();
      }

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("ETag", etag)
        .send(JSON.stringify(await loadDefinition(rev.id)));
    },
  );

  // GET /games/:gameId/revisions/:revision
  app.get(
    "/:gameId/revisions/:revision",
    {
      schema: {
        querystring: Type.Object({
          sessionId: Type.Optional(Type.String()),
        }),
      },
    },
    async (req, reply) => {
      const { gameId, revision } = req.params as {
        gameId: string;
        revision: string;
      };
      const { sessionId } = req.query as { sessionId?: string };

      const game = await findGameByIdOrKey(gameId);
      if (!game) {
        return reply.status(404).send({ error: "Game not found" });
      }

      const revisionNum = parseInt(revision, 10);
      // Out of the column's INT4 range, Prisma throws instead of finding nothing.
      const isInt =
        !Number.isNaN(revisionNum) &&
        String(revisionNum) === revision.trim() &&
        revisionNum >= 1 &&
        revisionNum <= 2147483647;

      const select = { id: true, checksum: true } as const;
      let rev: { id: string; checksum: string } | null = null;
      if (isInt) {
        rev = await prisma.gameRevision.findUnique({
          where: {
            gameId_revision: {
              gameId: game.id,
              revision: revisionNum,
            },
          },
          select,
        });
      }
      if (!rev) {
        rev = await prisma.gameRevision.findFirst({
          where: {
            id: revision,
            gameId: game.id,
          },
          select,
        });
      }

      if (!rev) {
        return reply.status(404).send({ error: "Revision not found" });
      }

      await assertGameDefinitionAccess({
        req,
        game,
        revisionIds: [rev.id, game.currentRevisionId],
        session: { id: sessionId, revisionId: rev.id },
      });

      const etag = `"${rev.checksum}"`;
      if (matchesETag(req.headers["if-none-match"], etag)) {
        return reply.status(304).send();
      }

      return reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("ETag", etag)
        .send(JSON.stringify(await loadDefinition(rev.id)));
    },
  );
}
