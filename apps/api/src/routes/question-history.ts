import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { Type } from "@sinclair/typebox";
import {
  BULKY_QUESTION_FIELDS,
  diffQuestionLists,
  isRecord,
  stripBulkyData,
  type QuestionHistoryEntry,
  type QuestionHistoryResponse,
} from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { resolveSession } from "../lib/session.js";
import { resolveSessionAccess } from "../lib/session-access.js";

type Query = { before?: number; after?: number; limit?: number };

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

// Every save stores the whole list. Read without its bulky fields
// (listWithoutBulk), that's a few hundred bytes a question. Stop reading a
// page once what's read passes this many bytes, which only lists far longer
// than games have do; the client asks for the rest with the next page. An
// object so tests can shrink it.
export const pageByteBudget = { bytes: 4 * 1024 * 1024 };

// What's read is small, but the database still decompresses each save and
// fingerprints its bulky fields, every point of every custom zone. So a page
// also stops once the saves passed this many bytes as stored (compressed):
// a hundred saves of most sessions, a dozen or two with several large zones.
export const pageStoredBudget = { bytes: 32 * 1024 * 1024 };

interface ReplaceRow {
  sequence: number;
  userId: string;
  displayName: string | null;
  serverReceivedAt: Date;
  /** Bytes as stored. */
  stored: number;
}

// Each save's list as listWithoutBulk reads it, by sequence.
type Lists = Map<number, string | null>;

// Where a question was read: the save, and its place in that save's list.
interface Origin {
  sequence: number;
  index: number;
}

// A save's question list as JSON text, with each `geo` and `places` (a
// custom zone's boundary can be tens of thousands of points, in every save)
// replaced by a fingerprint of its text: the diff still sees them change,
// and only the fingerprints leave the database. Each entry also gets its
// place in the stored list, to read it in full later (readInFull). Null when
// the payload holds no list. For an Event row `e`.
const listWithoutBulk = Prisma.sql`
  CASE WHEN jsonb_typeof(e."payloadJson"->'questions') = 'array' THEN COALESCE((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(l.q) <> 'object' THEN l.q
      ELSE CASE
        WHEN jsonb_typeof(l.q->'payloadJson'->'data') = 'object' THEN
          jsonb_set(l.q, '{payloadJson,data}', l.q->'payloadJson'->'data' || COALESCE((
            SELECT jsonb_object_agg(f.key, jsonb_build_object('fingerprint', md5(f.value::text)))
            FROM jsonb_each(l.q->'payloadJson'->'data') AS f
            WHERE f.key = ANY(${[...BULKY_QUESTION_FIELDS]}) AND jsonb_typeof(f.value) IN ('object', 'array')
          ), '{}'))
        ELSE l.q END
        -- Last, so an "index" the entry was stored with doesn't win.
        || jsonb_build_object('index', l.i - 1)
      END
      ORDER BY l.i)
    FROM jsonb_array_elements(e."payloadJson"->'questions') WITH ORDINALITY AS l(q, i)
  ), '[]')::text END
`;

// The questions of a list read with listWithoutBulk, in saved order, or null
// when it isn't one. Notes where each question was read.
function questionsOf(listText: string | null, sequence: number, origins: WeakMap<object, Origin>): unknown[] | null {
  if (listText === null) return null;
  try {
    const list = JSON.parse(listText) as unknown;
    if (!Array.isArray(list)) return null;
    return list
      .filter(
        (q): q is { ordinal?: unknown; payloadJson?: unknown; index?: unknown } => typeof q === "object" && q !== null,
      )
      .map((q, i) => ({ ordinal: typeof q.ordinal === "number" ? q.ordinal : i, question: q.payloadJson, index: q.index }))
      .sort((a, b) => a.ordinal - b.ordinal)
      .map(({ question, index }) => {
        if (isRecord(question) && typeof index === "number") origins.set(question, { sequence, index });
        return question;
      });
  } catch {
    return null;
  }
}

// Read as text, by place, so the questions are what was stored. Null when
// it isn't there.
async function readInFull(sessionId: string, wanted: { origin: Origin }[]): Promise<(string | null)[]> {
  if (wanted.length === 0) return [];
  const places = JSON.stringify(wanted.map(({ origin }, n) => ({ n, sequence: origin.sequence, i: origin.index })));
  const rows = await prisma.$queryRaw<{ n: number; value: string | null }[]>`
    SELECT w.n, (e."payloadJson"->'questions'->w.i->'payloadJson')::text AS "value"
    FROM jsonb_to_recordset(${places}::jsonb) AS w(n int, sequence int, i int)
    JOIN "Event" e ON e."sessionId" = ${sessionId} AND e."sequence" = w.sequence
  `;
  const values: (string | null)[] = wanted.map(() => null);
  for (const row of rows) values[row.n] = row.value;
  return values;
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

// The session's saves after `filter` (on "Event"), newest or oldest first, at
// most `count`: who saved, when, and how large it is as stored, which is
// known without reading it.
function readSaves(sessionId: string, filter: Prisma.Sql, first: "newest" | "oldest", count: number) {
  const order = first === "newest" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return prisma.$queryRaw<ReplaceRow[]>`
    SELECT e."sequence", e."userId", u."displayName", e."serverReceivedAt",
           pg_column_size(e."payloadJson")::int AS "stored"
    FROM "Event" e
    LEFT JOIN "User" u ON u."discordId" = e."userId"
    WHERE e."sessionId" = ${sessionId} AND e."type" = 'questions.replace' ${filter}
    ORDER BY e."sequence" ${order}
    LIMIT ${count}
  `;
}

// These saves' lists, without their bulky fields.
async function readLists(sessionId: string, saves: ReplaceRow[]): Promise<Lists> {
  if (saves.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ sequence: number; questions: string | null }[]>`
    SELECT e."sequence", ${listWithoutBulk} AS "questions"
    FROM "Event" e
    WHERE e."sessionId" = ${sessionId} AND e."sequence" = ANY(${saves.map((s) => s.sequence)})
  `;
  return new Map(rows.map((r) => [r.sequence, r.questions]));
}

// How many of the rows, in reading order, fit in a budget: always at least
// one, however large, so paging moves on.
function withinBudget<T>(rows: T[], size: (row: T) => number, budget: number): number {
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    bytes += size(rows[i]);
    if (i > 0 && bytes > budget) return i;
  }
  return rows.length;
}

const storedSize = (row: ReplaceRow) => row.stored;
const readSize = (lists: Lists) => (row: ReplaceRow) => Buffer.byteLength(lists.get(row.sequence) ?? "");

// What each save changed, newest first. `saves` are oldest first; `baseline`
// is the save before the first of them, if any.
async function historyEntries(
  sessionId: string,
  saves: ReplaceRow[],
  read: Lists,
  baseline: ReplaceRow | undefined,
  // Whether the reader can put deleted questions back.
  canRestore: boolean,
): Promise<QuestionHistoryEntry[]> {
  const origins = new WeakMap<object, Origin>();
  const listOf = (save: ReplaceRow) => questionsOf(read.get(save.sequence) ?? null, save.sequence, origins);
  const first = (baseline && listOf(baseline)) || [];
  const lists = saves.map(listOf);

  let previous = first;
  const entries: QuestionHistoryEntry[] = [];
  saves.forEach((save, i) => {
    const list = lists[i];
    // A malformed payload says nothing; compare the next save with the last good one.
    if (!list) return;
    const diff = diffQuestionLists(previous, list);
    previous = list;
    if (diff.changes.length === 0 && !diff.reordered) return;
    entries.push({
      sequence: save.sequence,
      userId: save.userId,
      displayName: save.displayName ?? save.userId,
      at: save.serverReceivedAt.toISOString(),
      changes: diff.changes,
      ...(diff.reordered ? { reordered: true as const } : {}),
      ...(diff.prevOrder ? { order: diff.prevOrder } : {}),
    });
  });

  // A deleted question goes back whole, so it's read in full from the last
  // save that had it. One that can't be read isn't offered at all. A
  // spectator can't restore: what it was is enough to name it.
  const removed = entries.flatMap((e) => e.changes).filter((c) => c.kind === "removed");
  if (!canRestore) {
    for (const change of removed) {
      change.before = stripBulkyData(isRecord(change.question) ? change.question.data : undefined);
      delete change.question;
    }
    return entries.reverse();
  }
  const located = removed.flatMap((change) => {
    const origin = isRecord(change.question) ? origins.get(change.question) : undefined;
    if (!origin) delete change.question;
    return origin ? [{ change, origin }] : [];
  });
  const texts = await readInFull(sessionId, located);
  located.forEach(({ change }, i) => {
    const text = texts[i];
    if (text === null) delete change.question;
    else change.question = JSON.parse(text);
  });
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
      const { role } = await resolveSessionAccess(sessionId, user.discordId);
      const canRestore = role !== "viewer";

      const query = req.query as Query;
      if (query.before !== undefined && query.after !== undefined) {
        throw Object.assign(new Error("Pass before or after, not both"), { statusCode: 400 });
      }
      const limit = query.limit ?? DEFAULT_LIMIT;

      if (query.after !== undefined) {
        const rows = await readSaves(sessionId, Prisma.sql`AND e."sequence" > ${query.after}`, "oldest", limit + 1);
        if (rows.length > limit || withinBudget(rows, storedSize, pageStoredBudget.bytes) < rows.length) {
          return { entries: [], nextBefore: null, newest: null, more: true };
        }
        if (rows.length === 0) return { entries: [], nextBefore: null, newest: null };
        const [baseline] = await readSaves(sessionId, Prisma.sql`AND e."sequence" <= ${query.after}`, "newest", 1);
        const lists = await readLists(sessionId, baseline ? [baseline, ...rows] : rows);
        if (withinBudget(rows, readSize(lists), pageByteBudget.bytes) < rows.length) {
          return { entries: [], nextBefore: null, newest: null, more: true };
        }
        return {
          entries: await historyEntries(sessionId, rows, lists, baseline, canRestore),
          nextBefore: null,
          newest: rows[rows.length - 1].sequence,
        };
      }

      // One more than the page: the save before the page's oldest is what
      // that one is compared with. Only the saves within what's stored are
      // read, with the one before them.
      const beforeClause = query.before === undefined ? Prisma.empty : Prisma.sql`AND e."sequence" < ${query.before}`;
      const rows = await readSaves(sessionId, beforeClause, "newest", limit + 1);
      const fit = withinBudget(rows.slice(0, limit), storedSize, pageStoredBudget.bytes);
      const lists = await readLists(sessionId, rows.slice(0, fit + 1));
      const page = rows.slice(0, withinBudget(rows.slice(0, fit), readSize(lists), pageByteBudget.bytes));
      const baseline = rows[page.length];
      return {
        entries: await historyEntries(sessionId, [...page].reverse(), lists, baseline, canRestore),
        nextBefore: baseline && page.length > 0 ? page[page.length - 1].sequence : null,
        newest: rows[0]?.sequence ?? null,
      };
    },
  );
}
