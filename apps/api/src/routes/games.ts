import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { getUserPermissions, userPassesDiscordRoleGate, assertServerMembership } from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { assertCanManageGame, canManageGames, findGameByIdOrKey } from "../lib/game-access.js";
import { connectedUserIds } from "../lib/broadcaster.js";
import { detailsData, fromDbDate } from "../lib/game-details.js";
import { type GameDetails, validateGameDetails } from "@searchlight/shared";

const gameShape = Type.Object({
  id: Type.String(),
  gameKey: Type.String(),
  serverId: Type.String(),
  name: Type.String(),
  size: Type.String(),
  unlisted: Type.Boolean(),
  currentRevisionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  archivedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  date: Type.Union([Type.String(), Type.Null()]),
  endDate: Type.Union([Type.String(), Type.Null()]),
  rulesUrl: Type.Union([Type.String(), Type.Null()]),
});

// Not a union: request coercion would turn null into "" for its string branch.
const nullableString = Type.Unsafe<string | null>({ type: ["string", "null"] });

function serializeGame(game: Prisma.GameGetPayload<{}>) {
  return {
    id: game.id,
    gameKey: game.gameKey,
    serverId: game.serverId,
    name: game.name,
    size: game.size,
    unlisted: game.unlisted,
    currentRevisionId: game.currentRevisionId,
    archivedAt: game.archivedAt?.toISOString() ?? null,
    date: fromDbDate(game.date),
    endDate: fromDbDate(game.endDate),
    rulesUrl: game.rulesUrl,
  };
}

export async function gameRoutes(app: FastifyInstance) {
  // GET /games?serverId= — list games for a server (must be a guild member),
  // newest event first, then undated games by name. Unlisted games are left
  // out: sessions of them start from game links only. The games page lists
  // them for the server's game managers with ?includeUnlisted=true. Archived
  // games (past events) are left out of new-session lists; ?includeArchived=true
  // lists them too, for anyone (Find a game shows them on request).
  app.get(
    "/",
    {
      schema: {
        querystring: Type.Object({
          serverId: Type.String({ minLength: 1 }),
          includeUnlisted: Type.Optional(Type.Boolean()),
          includeArchived: Type.Optional(Type.Boolean()),
        }),
        response: {
          200: Type.Object({ games: Type.Array(gameShape) }),
        },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { serverId, includeUnlisted = false, includeArchived = false } = req.query as {
        serverId: string;
        includeUnlisted?: boolean;
        includeArchived?: boolean;
      };

      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server) throw Object.assign(new Error("Server not found"), { statusCode: 404 });

      // Virtual servers (e.g. Home Games) have no Discord guild — skip the
      // membership check; their games are gated individually below.
      if (!VIRTUAL_SERVER_IDS.has(serverId)) {
        await assertServerMembership(user.discordId, serverId, req.log);
      }

      let games = await prisma.game.findMany({
        where: { serverId, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ date: { sort: "desc", nulls: "last" } }, { name: "asc" }],
      });
      if (games.some((game) => game.unlisted)) {
        const showUnlisted =
          includeUnlisted &&
          canManageGames(await getUserPermissions(user.discordId, serverId, true, req.log));
        if (!showUnlisted) games = games.filter((game) => !game.unlisted);
      }

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
        visible.push(serializeGame(game));
      }
      return { games: visible };
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
      if (!perms.has("server.admin")) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });

      const games = await prisma.game.findMany({ where: { serverId }, select: { id: true } });
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
      const playerRows = await prisma.$queryRaw<{ gameId: string; players: number }[]>`
        SELECT gs."gameId", COUNT(DISTINCT p."userId")::int AS players
        FROM "SessionParticipant" p
        JOIN "GameSession" gs ON gs.id = p."sessionId"
        WHERE gs."gameId" IN (${Prisma.join(gameIds)}) AND p."acceptedAt" IS NOT NULL
        GROUP BY gs."gameId"
      `;

      const connected = connectedUserIds();
      const liveSessions =
        connected.size === 0
          ? []
          : await prisma.gameSession.findMany({
              where: { id: { in: [...connected.keys()] }, gameId: { in: gameIds } },
              select: { id: true, gameId: true },
            });

      const stats = new Map(
        gameIds.map((gameId) => [
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
        const entry = stats.get(session.gameId)!;
        entry.liveSessions++;
        for (const userId of connected.get(session.id)!) entry.livePlayers.add(userId);
      }

      return {
        stats: [...stats.values()].map((entry) => ({ ...entry, livePlayers: entry.livePlayers.size })),
      };
    },
  );

  // PATCH /games/:gameId — what the server's game managers change on the games
  // page: listing, archiving and the game's details. A date and an end date
  // are set together (null clears), so they always fit each other.
  app.patch(
    "/:gameId",
    {
      schema: {
        params: Type.Object({ gameId: Type.String() }),
        body: Type.Object(
          {
            unlisted: Type.Optional(Type.Boolean()),
            archived: Type.Optional(Type.Boolean()),
            date: Type.Optional(nullableString),
            endDate: Type.Optional(nullableString),
            rulesUrl: Type.Optional(nullableString),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: { 200: gameShape },
      },
    },
    async (req) => {
      const { user } = await resolveSession(req);
      const { gameId } = req.params as { gameId: string };
      const { unlisted, archived, ...details } = req.body as {
        unlisted?: boolean;
        archived?: boolean;
      } & Partial<GameDetails>;
      // Unknown keys are stripped before this, so a typo leaves nothing to do.
      if (unlisted === undefined && archived === undefined && Object.keys(details).length === 0) {
        throw Object.assign(new Error("Nothing to change"), { statusCode: 400 });
      }

      if (("date" in details) !== ("endDate" in details)) {
        throw Object.assign(new Error("Set the date and the end date together"), { statusCode: 400 });
      }
      const issues = validateGameDetails(details);
      if (issues.length > 0) {
        throw Object.assign(new Error(issues.map((issue) => issue.message).join("; ")), {
          statusCode: 400,
        });
      }

      const game = await findGameByIdOrKey(gameId);
      if (!game) throw Object.assign(new Error("Game not found"), { statusCode: 404 });
      await assertCanManageGame(user.discordId, game, req.log);

      const updated = await prisma.game.update({
        where: { id: game.id },
        data: {
          ...detailsData(details),
          ...(unlisted !== undefined ? { unlisted } : {}),
          ...(archived !== undefined
            ? { archivedAt: archived ? (game.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      req.log.info({ gameId: game.id, changes: req.body, userId: user.discordId }, "[games] game changed");
      return serializeGame(updated);
    },
  );

  // DELETE /games/:gameId — delete a game (requires games.delete in the game's server)
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

      const game = await findGameByIdOrKey(gameId);
      if (!game) throw Object.assign(new Error("Game not found"), { statusCode: 404 });

      const perms = await getUserPermissions(
        user.discordId,
        game.serverId,
        true,
        req.log,
      );
      if (!perms.has("games.delete")) {
        throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
      }

      const sessionCount = await prisma.gameSession.count({ where: { gameId: game.id } });
      if (sessionCount > 0) {
        throw Object.assign(
          new Error(
            "This game has sessions, so it can't be deleted. Archive it instead: it leaves new-session lists, and its sessions and links keep working.",
          ),
          { statusCode: 409 },
        );
      }

      await prisma.game.delete({ where: { id: game.id } });
      return reply.status(204).send();
    },
  );
}
