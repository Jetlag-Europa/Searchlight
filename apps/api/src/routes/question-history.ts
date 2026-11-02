import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { Type } from "@sinclair/typebox";
import {
  diffQuestionLists,
  type QuestionHistoryEntry,
  type QuestionHistoryResponse,
} from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { resolveSessionAccess } from "../lib/session-access.js";

type Query = { before?: number; after?: number; limit?: number };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

// Every save stores the whole list, so a page of a long session with custom
// zones can be large. Stop reading a page once its snapshots pass this many
// bytes as stored; the client asks for the rest with the next page. Stored
// size is compressed, so the JSON is several times larger. An object so tests
// can shrink it.
export const pageByteBudget = { bytes: 1024 * 1024 };

interface ReplaceRow {
  sequence: number;
  userId: string;
  displayName: string | null;
  serverReceivedAt: Date;
  size: number;
}

// The question list a `questions.replace` payload holds, in saved order, or
// null when it isn't one.
function questionsOf(payloadText: string): unknown[] | null {
  try {
    const payload = JSON.parse(payloadText) as { questions?: unknown };
    if (!Array.isArray(payload.questions)) return null;
    return payload.questions
      .filter((q): q is { ordinal?: unknown; payloadJson?: unknown } => typeof q === "object" && q !== null)
      .map((q, i) => ({ ordinal: typeof q.ordinal === "number" ? q.ordinal : i, question: q.payloadJson }))
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((q) => q.question);
  } catch {
    return null;
  }
}

const changeSchema = Type.Object({
  kind: Type.Union([Type.Literal("added"), Type.Literal("changed"), Type.Literal("removed")]),
  key: Type.Number(),
  id: Type.String(),
  index: Type.Integer(),
  typeIndex: Type.Integer(),
  fields: Type.Optional(Type.Array(Type.String())),
  before: Type.Optional(Type.Unknown()),
  after: Type.Optional(Type.Unknown()),
  question: Type.Optional(Type.Unknown()),
});

const entrySchema = Type.Object({
  sequence: Type.Integer(),
  userId: Type.String(),
  displayName: Type.String(),
  at: Type.String(),
  changes: Type.Array(changeSchema),
  reordered: Type.Optional(Type.Literal(true)),
  order: Type.Optional(Type.Array(Type.Number())),
});

// How many of the rows, in reading order, fit in the byte budget: always at
// least one, however large, so paging moves on.
function rowsWithinBudget(rows: ReplaceRow[]): number {
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    bytes += rows[i].size;
    if (i > 0 && bytes > pageByteBudget.bytes) return i;
  }
  return rows.length;
}

// Read as text: Prisma's Json numbers can come back one ulp off, and keys
// must be compared as stored.
async function readQuestionLists(sessionId: string, sequences: number[]): Promise<Map<number, unknown[] | null>> {
  if (sequences.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ sequence: number; payload: string }[]>`
    SELECT "sequence", "payloadJson"::text AS "payload"
    FROM "Event"
    WHERE "sessionId" = ${sessionId} AND "sequence" = ANY(${sequences})
  `;
  return new Map(rows.map((r) => [r.sequence, questionsOf(r.payload)]));
}

// What each save changed, newest first. `saves` are oldest first; `baseline`
// is the list before the first of them.
function historyEntries(
  saves: ReplaceRow[],
  lists: Map<number, unknown[] | null>,
  baseline: unknown[],
): QuestionHistoryEntry[] {
  let previous = baseline;
  const entries: QuestionHistoryEntry[] = [];
  for (const save of saves) {
    const list = lists.get(save.sequence);
    // A malformed payload says nothing; compare the next save with the last good one.
    if (!list) continue;
    const diff = diffQuestionLists(previous, list);
    previous = list;
    if (diff.changes.length === 0 && !diff.reordered) continue;
    entries.push({
      sequence: save.sequence,
      userId: save.userId,
      displayName: save.displayName ?? save.userId,
      at: save.serverReceivedAt.toISOString(),
      changes: diff.changes,
      ...(diff.reordered ? { reordered: true as const } : {}),
      ...(diff.prevOrder ? { order: diff.prevOrder } : {}),
    });
  }
  return entries.reverse();
}

export async function questionHistoryRoutes(app: FastifyInstance) {
  // GET /sessions/:sessionId/questions/history?before=<sequence>&limit=<1..200>
  // GET /sessions/:sessionId/questions/history?after=<sequence>&limit=<1..200>
  // Who changed which question and when, newest first: a page of older saves
  // (`before`, or the newest page), or the saves since one already read
  // (`after`). Built only from `questions.replace` events: hider positions
  // and drawings stay out of it.
  app.get(
    "/:sessionId/questions/history",
    {
      schema: {
        params: Type.Object({ sessionId: Type.String() }),
        querystring: Type.Object({
          before: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483647 })),
          after: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
        }),
        response: {
          200: Type.Object({
            entries: Type.Array(entrySchema),
            nextBefore: Type.Union([Type.Integer(), Type.Null()]),
            newest: Type.Union([Type.Integer(), Type.Null()]),
            more: Type.Optional(Type.Literal(true)),
          }),
        },
      },
    },
    async (req): Promise<QuestionHistoryResponse> => {
      const { user } = await resolveSession(req);
      const { sessionId } = req.params as { sessionId: string };
      // Spectators may read it too: it holds no hider position.
      await resolveSessionAccess(sessionId, user.discordId);

      const query = req.query as Query;
      if (query.before !== undefined && query.after !== undefined) {
        throw Object.assign(new Error("Pass before or after, not both"), { statusCode: 400 });
      }
      const limit = query.limit ?? DEFAULT_LIMIT;
      const saves = Prisma.sql`
        SELECT e."sequence", e."userId", u."displayName", e."serverReceivedAt",
               pg_column_size(e."payloadJson")::int AS "size"
        FROM "Event" e
        LEFT JOIN "User" u ON u."discordId" = e."userId"
        WHERE e."sessionId" = ${sessionId}
          AND e."type" = 'questions.replace'
      `;

      if (query.after !== undefined) {
        const after = query.after;
        const rows = await prisma.$queryRaw<ReplaceRow[]>`
          ${saves} AND e."sequence" > ${after}
          ORDER BY e."sequence" ASC
          LIMIT ${limit + 1}
        `;
        if (rows.length > limit || rowsWithinBudget(rows) < rows.length) {
          return { entries: [], nextBefore: null, newest: null, more: true };
        }
        if (rows.length === 0) return { entries: [], nextBefore: null, newest: null };
        const [baseline] = await prisma.$queryRaw<{ payload: string }[]>`
          SELECT "payloadJson"::text AS "payload"
          FROM "Event"
          WHERE "sessionId" = ${sessionId} AND "type" = 'questions.replace' AND "sequence" <= ${after}
          ORDER BY "sequence" DESC
          LIMIT 1
        `;
        const lists = await readQuestionLists(
          sessionId,
          rows.map((r) => r.sequence),
        );
        return {
          entries: historyEntries(rows, lists, (baseline && questionsOf(baseline.payload)) || []),
          nextBefore: null,
          newest: rows[rows.length - 1].sequence,
        };
      }

      // One more than the page: the save before the page's oldest is what
      // that one is compared with.
      const beforeClause =
        query.before === undefined ? Prisma.empty : Prisma.sql`AND e."sequence" < ${query.before}`;
      const rows = await prisma.$queryRaw<ReplaceRow[]>`
        ${saves} ${beforeClause}
        ORDER BY e."sequence" DESC
        LIMIT ${limit + 1}
      `;
      const page = rows.slice(0, rowsWithinBudget(rows.slice(0, limit)));
      const baseline = rows[page.length];
      const lists = await readQuestionLists(
        sessionId,
        rows.slice(0, page.length + 1).map((r) => r.sequence),
      );
      return {
        entries: historyEntries(
          [...page].reverse(),
          lists,
          (baseline && lists.get(baseline.sequence)) || [],
        ),
        nextBefore: baseline && page.length > 0 ? page[page.length - 1].sequence : null,
        newest: rows[0]?.sequence ?? null,
      };
    },
  );
}
