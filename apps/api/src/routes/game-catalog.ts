import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { isServerMember, LISTING_NON_MEMBER_TTL_MS, userPassesDiscordRoleGate } from "../lib/permissions.js";
import { VIRTUAL_SERVER_IDS } from "../lib/virtual-servers.js";
import { getDiscordRoleGate } from "../lib/game-access.js";

// The game browser: every game the user can start a session of, across all
// their servers, with where it is played, and, locked, the listed games of
// servers they haven't joined whose admins offer an invite to join.

const nullableBounds = Type.Unsafe<[number, number, number, number] | null>({
  anyOf: [
    { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    { type: "null" },
  ],
});

const catalogGameShape = Type.Object({
  id: Type.String(),
  gameKey: Type.String(),
  name: Type.String(),
  size: Type.String(),
  serverId: Type.String(),
  serverName: Type.String(),
  center: Type.Tuple([Type.Number(), Type.Number()]),
  bounds: nullableBounds,
  zoneCount: Type.Integer(),
  updatedAt: Type.String(),
  locked: Type.Boolean(),
  joinUrl: Type.Union([Type.String(), Type.Null()]),
});

const catalogShape = Type.Object({
  games: Type.Array(catalogGameShape),
  // Servers whose membership couldn't be checked (Discord unavailable): their
  // games are missing from the list.
  unavailableServers: Type.Array(Type.String()),
});

function isPosition(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number");
}

function isBounds(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number");
}

interface RevisionSummary {
  createdAt: string;
  visibility: unknown;
  /** Null when the definition has no valid center; such games aren't listed. */
  center: [number, number] | null;
  bounds: [number, number, number, number] | null;
  zoneCount: number;
}

// Revisions never change, so their summaries are kept for the life of the
// process: reading them makes Postgres decompress each multi-MB definition.
const summaryCache = new Map<string, RevisionSummary>();

async function revisionSummaries(revisionIds: string[]): Promise<Map<string, RevisionSummary>> {
  const missing = revisionIds.filter((id) => !summaryCache.has(id));
  if (missing.length > 0) {
    const rows = await prisma.$queryRaw<
      { id: string; createdAt: Date; visibility: unknown; center: unknown; bounds: unknown; zoneCount: number }[]
    >`
      SELECT
        id,
        "createdAt",
        definition->'visibility' AS visibility,
        definition->'map'->'center' AS center,
        definition->'map'->'bounds' AS bounds,
        CASE WHEN jsonb_typeof(definition->'hidingZones'->'features'->'features') = 'array'
          THEN jsonb_array_length(definition->'hidingZones'->'features'->'features')
          ELSE 0
        END::int AS "zoneCount"
      FROM "GameRevision"
      WHERE id IN (${Prisma.join(missing)})
    `;
    for (const row of rows) {
      summaryCache.set(row.id, {
        createdAt: row.createdAt.toISOString(),
        visibility: row.visibility,
        center: isPosition(row.center) ? row.center : null,
        bounds: isBounds(row.bounds) ? row.bounds : null,
        zoneCount: row.zoneCount,
      });
    }
  }
  const summaries = new Map<string, RevisionSummary>();
  for (const id of revisionIds) {
    const summary = summaryCache.get(id);
    if (summary) summaries.set(id, summary);
  }
  return summaries;
}

export async function gameCatalogRoutes(app: FastifyInstance) {
  // GET /games/catalog — the listed games the user may start sessions of on
  // any server (what GET /games returns for each server they belong to), then,
  // locked, the listed games without a role gate on the servers they aren't in
  // whose admins set an invite: setting one is how a server shows its games to
  // non-members.
  app.get(
    "/catalog",
    { schema: { response: { 200: catalogShape } } },
    async (req) => {
      const { user } = await resolveSession(req);
      const userId = user.discordId;

      // Whether the user belongs to each server, cached as for the server list
      // (a "not a member" for 10 minutes), so this rarely asks Discord; a
      // server Discord can't answer for is left out.
      const servers = await prisma.server.findMany({
        select: { id: true, name: true, inviteUrl: true },
      });
      const serverInfo = new Map<string, { name: string; inviteUrl: string | null; locked: boolean }>();
      const unavailableServers: string[] = [];
      await Promise.all(
        servers.map(async (server) => {
          let member = true;
          if (!VIRTUAL_SERVER_IDS.has(server.id)) {
            try {
              member = await isServerMember(userId, server.id, req.log, LISTING_NON_MEMBER_TTL_MS);
            } catch (err) {
              req.log.warn({ serverId: server.id, err }, "[catalog] membership check failed; server skipped");
              unavailableServers.push(server.name);
              return;
            }
          }
          if (member) serverInfo.set(server.id, { ...server, locked: false });
          else if (server.inviteUrl) serverInfo.set(server.id, { ...server, locked: true });
        }),
      );
      const empty = { games: [], unavailableServers };
      if (serverInfo.size === 0) return empty;

      const games = await prisma.game.findMany({
        where: {
          serverId: { in: [...serverInfo.keys()] },
          unlisted: false,
          archivedAt: null,
          currentRevisionId: { not: null },
        },
        select: {
          id: true,
          gameKey: true,
          name: true,
          size: true,
          serverId: true,
          currentRevisionId: true,
        },
      });
      if (games.length === 0) return empty;

      const revisions = await revisionSummaries(games.map((g) => g.currentRevisionId!));

      // Role gates repeat across games; check each (guild, role) once.
      const gateChecks = new Map<string, Promise<boolean>>();
      const passesGate = (visibility: unknown): Promise<boolean> => {
        const gate = getDiscordRoleGate(visibility);
        if (!gate) return Promise.resolve(true);
        const key = `${gate.guildId}:${gate.roleId}`;
        let check = gateChecks.get(key);
        if (!check) {
          check = userPassesDiscordRoleGate(userId, gate.guildId, gate.roleId, req.log);
          gateChecks.set(key, check);
        }
        return check;
      };

      const visible = (
        await Promise.all(
          games.map(async (game) => {
            const revision = revisions.get(game.currentRevisionId!);
            if (!revision?.center) return null;
            const server = serverInfo.get(game.serverId)!;
            // Joining the server wouldn't open a role-gated game: leave it out.
            if (server.locked) {
              if (getDiscordRoleGate(revision.visibility)) return null;
            } else if (!(await passesGate(revision.visibility))) {
              return null;
            }
            return { game, revision, server, center: revision.center };
          }),
        )
      ).filter((entry) => entry !== null);
      if (visible.length === 0) return empty;

      return {
        games: visible
          .map(({ game, revision, server, center }) => ({
            id: game.id,
            gameKey: game.gameKey,
            name: game.name,
            size: game.size,
            serverId: game.serverId,
            serverName: server.name,
            center,
            bounds: revision.bounds,
            zoneCount: revision.zoneCount,
            updatedAt: revision.createdAt,
            locked: server.locked,
            joinUrl: server.locked ? server.inviteUrl : null,
          }))
          .sort(
            (a, b) =>
              Number(a.locked) - Number(b.locked) || a.name.localeCompare(b.name),
          ),
        unavailableServers,
      };
    },
  );
}
