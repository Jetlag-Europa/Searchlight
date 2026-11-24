import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { Prisma } from "@prisma/client";
import { CASUAL_SERVER_ID, type GameSettingsUpdate } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { resolveSession } from "../lib/session.js";
import {
  getUserPermissions,
  isAdmin,
  userPassesDiscordRoleGate,
  assertServerMembership,
} from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import {
  assertCanManageGame,
  canManageGame,
  isOwnCasualGame,
  isUnlisted,
} from "../lib/game-access.js";
import { forbidden, notFound } from "../lib/http-errors.js";
import { connectedUserIds } from "../lib/broadcaster.js";
import { acquireUploadSlot, assertWithinWriteLimit } from "../lib/write-limit.js";
import { ImportValidationError, pruneGame, updateGameSettings } from "../games/import-service.js";

const gameShape = Type.Object({
  id: Type.String(),
  gameKey: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  size: Type.String(),
  unlisted: Type.Boolean(),
  currentRevisionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  archivedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  createdById: Type.Union([Type.String(), Type.Null()]),
  createdByName: Type.Union([Type.String(), Type.Null()]),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
});

// What serializeGames needs besides the game.
const withRevisionTime = { currentRevision: { select: { createdAt: true } } } as const;

// "updatedAt" is the current revision's upload: Game.updatedAt also moves on
// local opens.
async function serializeGames(
  games: Prisma.GameGetPayload<{ include: typeof withRevisionTime }>[],
) {
  const users = await prisma.user.findMany({
    where: { discordId: { in: games.flatMap((game) => game.createdById ?? []) } },
    select: { discordId: true, displayName: true },
  });
  const names = new Map(users.map((u) => [u.discordId, u.displayName]));
  return games.map((game) => ({
    id: game.id,
    gameKey: game.gameKey,
    serverId: game.serverId,
    name: game.name,
    size: game.size,
    unlisted: game.unlisted,
    currentRevisionId: game.currentRevisionId,
    archivedAt: game.archivedAt?.toISOString() ?? null,
    createdById: game.createdById,
    createdByName: (game.createdById && names.get(game.createdById)) ?? null,
    updatedAt: game.currentRevision?.createdAt.toISOString() ?? null,
  }));
}

export async function gameRoutes(app: FastifyInstance) {
  // GET /games?serverId= — list games for a server (must be a guild member).
  // Unlisted games are left out: sessions of them start from game links only.
  // The games page lists them for the server's game managers with
  // ?includeUnlisted=true. All Casual games are unlisted: each is listed there
  // only for its creator (and global admins).
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.String({ minLength: 1 }),
          includeUnlisted: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({ games: Type.Array(gameShape) }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId, includeUnlisted = false } = req.query as {
        serverId: string;
        includeUnlisted?: boolean;
      };

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      // Virtual servers (e.g. Casual Games) have no Discord guild — skip the
      // membership check; each of their games is listed for its creator only.
      if (!VIRTUAL_SERVER_IDS.has(serverId)) {
        await assertServerMembership(user.discordId, serverId, req.log);
      }

      const casual = serverId === CASUAL_SERVER_ID;
      if (casual && !includeUnlisted) return { games: [] };
      let games = await prisma.game.findMany({
        where: {
          serverId,
          archivedAt: null,
          // A Casual game is listed for its creator (see canManageGame).
          ...(casual && !isAdmin(user.discordId) && { createdById: user.discordId }),
        },
        include: withRevisionTime,
        orderBy: { name: "asc" },
      });
      if (!includeUnlisted) {
        games = games.filter((game) => !isUnlisted(game));
      } else if (
        !casual &&
        games.some((game) => game.unlisted) &&
        // Elsewhere managing games is per server, whoever created them.
        !(await canManageGame(user.discordId, { serverId, createdById: null }, req.log))
      ) {
        games = games.filter((game) => !game.unlisted);
      }

      // Every gate passes for the viewer: their own Casual games, or a global
      // admin. Reading `visibility` detoasts each definition.
      if (casual || isAdmin(user.discordId)) return { games: await serializeGames(games) };

      // Only `visibility` is needed here; loading every multi-MB definition
      // made listing a server's games pull its whole game catalogue.
      const revisionIds = games
        .map((game) => game.currentRevisionId)
        .filter((id): id is string => Boolean(id));
      const visibilityByRevision = new Map<string, any>();
      if (revisionIds.length > 0) {
        const rows = await prisma.$queryRaw<{ id: string; visibility: any }[]>`
          SELECT id, definition->'visibility' AS visibility
          FROM "GameRevision"
          WHERE id IN (${Prisma.join(revisionIds)})
        `;
        for (const row of rows) visibilityByRevision.set(row.id, row.visibility);
      }

      const visible = [];
      for (const game of games) {
        const visibility = game.currentRevisionId
          ? visibilityByRevision.get(game.currentRevisionId)
          : undefined;
        if (visibility?.kind === "discord-role") {
          const passes = await userPassesDiscordRoleGate(
            user.discordId,
            visibility.guildId,
            visibility.roleId,
            req.log,
          );
          if (!passes) {
            continue;
          }
        }
        visible.push(game);
      }
      return { games: await serializeGames(visible) };
    },
  );

  // GET /games/stats?serverId= — usage of each of the server's games, for its
  // server admins (global admins hold server.admin everywhere). Only counts
  // per game: no session ids, names, players or contents, so the stats can't
  // lead anyone into a session.
  app.get(
    "/stats",
    {
      schema: {
        querystring: Type.Object({ serverId: Type.String({ minLength: 1 }) }),
        response: {
          200: Type.Object({
            stats: Type.Array(
              Type.Object({
                gameId: Type.String(),
                liveSessions: Type.Integer(),
                livePlayers: Type.Integer(),
                activeSessions24h: Type.Integer(),
                activeSessions7d: Type.Integer(),
                totalSessions: Type.Integer(),
                players: Type.Integer(),
                questions: Type.Integer(),
                localOpens: Type.Integer(),
                lastActivityAt: Type.Union([Type.String(), Type.Null()]),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId } = req.query as { serverId: string };

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      const perms = await getUserPermissions(user.discordId, serverId, true, req.log);
      if (!perms.has("server.admin"))
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });

      const games = await prisma.game.findMany({
        where: { serverId, archivedAt: null },
        select: { id: true, localOpens: true },
      });
      const gameIds = games.map((game) => game.id);
      if (gameIds.length === 0) return { stats: [] };

      // A session's last activity is its newest event, or its creation.
      // "createdAt" is a timestamp without time zone holding UTC (Event times
      // are timestamptz), so read it as UTC whatever the database's TimeZone.
      const sessionRows = await prisma.$queryRaw<
        {
          gameId: string;
          totalSessions: number;
          activeSessions24h: number;
          activeSessions7d: number;
          questions: number;
          lastActivityAt: Date | null;
        }[]
      >`
        WITH s AS (
          SELECT gs."gameId",
            GREATEST(
              gs."createdAt" AT TIME ZONE 'UTC',
              (SELECT MAX(e."serverReceivedAt") FROM "Event" e WHERE e."sessionId" = gs.id)
            ) AS "lastActivity",
            (SELECT COUNT(*) FROM "SessionQuestion" q WHERE q."sessionId" = gs.id) AS questions
          FROM "GameSession" gs
          WHERE gs."gameId" IN (${Prisma.join(gameIds)})
        )
        SELECT "gameId",
          COUNT(*)::int AS "totalSessions",
          COUNT(*) FILTER (WHERE "lastActivity" > now() - interval '1 day')::int AS "activeSessions24h",
          COUNT(*) FILTER (WHERE "lastActivity" > now() - interval '7 days')::int AS "activeSessions7d",
          SUM(questions)::int AS questions,
          MAX("lastActivity") AS "lastActivityAt"
        FROM s
        GROUP BY "gameId"
      `;
      // Viewers only watch, so they aren't players, here or live.
      const playerRows = await prisma.$queryRaw<{ gameId: string; players: number }[]>`
        SELECT gs."gameId", COUNT(DISTINCT p."userId")::int AS players
        FROM "SessionParticipant" p
        JOIN "GameSession" gs ON gs.id = p."sessionId"
        WHERE gs."gameId" IN (${Prisma.join(gameIds)}) AND p."acceptedAt" IS NOT NULL
          AND p.role <> 'viewer'
        GROUP BY gs."gameId"
      `;

      const connected = connectedUserIds();
      const liveSessions =
        connected.size === 0
          ? []
          : await prisma.gameSession.findMany({
              where: { id: { in: [...connected.keys()] }, gameId: { in: gameIds } },
              select: {
                id: true,
                gameId: true,
                participants: { where: { role: "viewer" }, select: { userId: true } },
              },
            });

      const stats = new Map(
        games.map(({ id: gameId, localOpens }) => [
          gameId,
          {
            gameId,
            liveSessions: 0,
            livePlayers: new Set<string>(),
            activeSessions24h: 0,
            activeSessions7d: 0,
            totalSessions: 0,
            players: 0,
            questions: 0,
            localOpens,
            lastActivityAt: null as string | null,
          },
        ]),
      );
      for (const row of sessionRows) {
        const entry = stats.get(row.gameId)!;
        entry.totalSessions = row.totalSessions;
        entry.activeSessions24h = row.activeSessions24h;
        entry.activeSessions7d = row.activeSessions7d;
        entry.questions = row.questions;
        entry.lastActivityAt = row.lastActivityAt?.toISOString() ?? null;
      }
      for (const row of playerRows) stats.get(row.gameId)!.players = row.players;
      for (const session of liveSessions) {
        const viewers = new Set(session.participants.map((p) => p.userId));
        const players = connected.get(session.id)!.filter((userId) => !viewers.has(userId));
        if (players.length === 0) continue;
        const entry = stats.get(session.gameId)!;
        entry.liveSessions++;
        for (const userId of players) entry.livePlayers.add(userId);
      }

      return {
        stats: [...stats.values()].map((entry) => ({
          ...entry,
          livePlayers: entry.livePlayers.size,
        })),
      };
    },
  );

  // PATCH /games/:gameId — list or unlist a game (game managers of its server).
  // Links to the game stay valid either way. Casual games can't be listed.
  app.patch(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Object({ unlisted: Type.Boolean() }, { additionalProperties: false }),
        response: { 200: gameShape },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const { unlisted } = req.body as { unlisted: boolean };

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.archivedAt) throw notFound("Game not found");
      await assertCanManageGame(user.discordId, game, req.log);
      if (!unlisted && game.serverId === CASUAL_SERVER_ID) {
        throw Object.assign(new Error("Casual games are always unlisted"), { statusCode: 400 });
      }

      const updated = await prisma.$transaction(async (tx) => {
        // Conditional, so a repeat (or a concurrent duplicate) changes and logs nothing.
        const { count } = await tx.game.updateMany({
          where: { id: game.id, unlisted: !unlisted, archivedAt: null },
          data: { unlisted },
        });
        if (count > 0) {
          await audit(tx, {
            serverId: game.serverId,
            actorId: user.discordId,
            action: "game.listing",
            targetId: game.id,
            targetName: game.name,
            details: { unlisted },
          });
        }
        // Deleted meanwhile: listing it would bring it back to the session picker.
        const current = await tx.game.findUnique({
          where: { id: game.id },
          include: withRevisionTime,
        });
        if (!current || current.archivedAt) throw notFound("Game not found");
        return current;
      });
      req.log.info(
        { gameId: game.id, unlisted, userId: user.discordId },
        "[games] listing changed",
      );
      return (await serializeGames([updated]))[0];
    },
  );

  // PATCH /games/:gameId/settings — change a game's name and size (game
  // editors of its server; on Casual Games, also the game's creator). Saved
  // as a new revision, like uploading the edited JSON, so sessions keep their
  // revision and are offered the update.
  app.patch(
    "/:gameId/settings",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Object(
          {
            baseRevisionId: Type.String({ minLength: 1 }),
            // Its length is checked once trimmed.
            name: Type.Optional(Type.String()),
            size: Type.Optional(
              Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]),
            ),
          },
          // Rejects unknown fields: Fastify strips them where
          // additionalProperties is false, which would hide a client's typo.
          { additionalProperties: Type.Never() },
        ),
        response: {
          200: Type.Object({
            status: Type.Union([Type.Literal("updated"), Type.Literal("unchanged")]),
            revision: Type.Integer(),
            game: gameShape,
          }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const body = req.body as GameSettingsUpdate;
      assertWithinWriteLimit(user.discordId);

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.archivedAt) throw notFound("Game not found");
      // Checked before the definition, which can be several MB, is loaded.
      const perms = await getUserPermissions(user.discordId, game.serverId, true, req.log);
      const canEdit = perms.has("games.edit") || perms.has("server.admin");
      // A Casual game's creator edits it while they hold games.create there,
      // as for an import of it.
      const ownCasualGame = isOwnCasualGame(user.discordId, game) && perms.has("games.create");
      if (!canEdit && !ownCasualGame)
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });

      const name = body.name?.trim();
      if (name === "") {
        throw Object.assign(new Error("The game's name can't be empty"), { statusCode: 400 });
      }
      if (name && name.length > 120) {
        throw Object.assign(new Error("The game's name can be at most 120 characters"), {
          statusCode: 400,
        });
      }

      let result;
      // Held until the work is done: it loads and validates the whole definition.
      const releaseUploadSlot = acquireUploadSlot(user.discordId);
      try {
        result = await updateGameSettings({
          game,
          baseRevisionId: body.baseRevisionId,
          name,
          size: body.size,
          actor: {
            userId: user.discordId,
            canCreateGames: (serverId) => ownCasualGame && serverId === game.serverId,
            canEditGames: (serverId) => canEdit && serverId === game.serverId,
          },
        });
      } catch (err) {
        // A conflict (409 GAME_CHANGED) is sent as it is, like this route's
        // other errors: { statusCode, code, error, message }. A validation
        // failure gets the first issue as its message, for the dialog to show.
        if (err instanceof ImportValidationError) {
          const issue = err.errors[0];
          throw Object.assign(new Error(issue ? `${issue.message} (${issue.path})` : err.message), {
            statusCode: 400,
            code: err.code,
          });
        }
        throw err;
      } finally {
        releaseUploadSlot();
      }

      const updated = await prisma.game.findUnique({
        where: { id: game.id },
        include: withRevisionTime,
      });
      if (!updated || updated.archivedAt) throw notFound("Game not found");
      req.log.info(
        {
          gameId: game.id,
          status: result.status,
          revision: result.revision,
          userId: user.discordId,
        },
        "[games] settings changed",
      );
      return {
        status: result.status,
        revision: result.revision,
        game: (await serializeGames([updated]))[0],
      };
    },
  );

  // DELETE /games/:gameId — delete a game (games.delete on its server; a
  // Casual game's creator too, also after leaving every server). It leaves
  // the games list, its game links are revoked and nobody can start sessions
  // of it; sessions already started keep their revision. The game is kept,
  // archived, until its last session is deleted (see pruneGame).
  app.delete(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
      },
    },
    async (req, reply) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };

      const game = await prisma.game.findUnique({ where: { id: gameId } });
      if (!game || game.archivedAt) throw notFound("Game not found");

      // The creator's check first: it needs no Discord lookup.
      if (
        !isOwnCasualGame(user.discordId, game) &&
        !(await getUserPermissions(user.discordId, game.serverId, true, req.log)).has(
          "games.delete",
        )
      ) {
        throw forbidden();
      }

      await prisma.$transaction(async (tx) => {
        const now = new Date();
        // Conditional, so a concurrent second delete finds nothing. No current
        // revision and unlisted close every way to it but sessions'; the
        // ownerScope frees its id for a new game.
        const { count } = await tx.game.updateMany({
          where: { id: game.id, archivedAt: null },
          data: {
            archivedAt: now,
            currentRevisionId: null,
            unlisted: true,
            ownerScope: `archived:${game.id}`,
          },
        });
        if (count === 0) throw notFound("Game not found");
        await tx.gameLink.updateMany({
          where: { gameId: game.id, revokedAt: null },
          data: { revokedAt: now },
        });
        const sessions = await tx.gameSession.count({ where: { gameId: game.id } });
        await audit(tx, {
          serverId: game.serverId,
          actorId: user.discordId,
          action: "game.delete",
          targetId: game.id,
          targetName: game.name,
          details: sessions > 0 ? { sessions } : {},
        });
        await pruneGame(tx, game.id);
      });
      return reply.status(204).send();
    },
  );
}
