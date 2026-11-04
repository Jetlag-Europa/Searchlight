// Question history: what each save of a session's question list changed,
// worked out by comparing it with the list before it. The API builds it from
// the `questions.replace` events; the web turns it into lines to read.
//
// Session questions are stored unparsed, so nothing here may assume a shape:
// entries without a numeric key are skipped, and nothing throws.

type QuestionChangeKind = "added" | "changed" | "removed";

export interface QuestionChange {
  kind: QuestionChangeKind;
  /** The question's key, its only stable identity. */
  key: number;
  /** The question type: "radius", "thermometer", … */
  id: string;
  /** Position in the list after the save (added, changed) or before it (removed). */
  index: number;
  /** 1-based position among questions of the same type in that list, as in "Radius 2". */
  typeIndex: number;
  /** Changed data fields; never `collapsed`. */
  fields?: string[];
  /**
   * The question's data before and after, with `geo` and `places` replaced by
   * `{ omitted: true }`. For "changed", only the changed fields, the name, and
   * both coordinates of a moved pin.
   */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /**
   * Removed only: the full question, so it can be put back. A spectator, who
   * can't, gets only `before` instead: its data, `geo` and `places` omitted.
   */
  question?: unknown;
}

export interface QuestionHistoryEntry {
  sequence: number;
  userId: string;
  displayName: string;
  /** When the save reached the server (ISO). */
  at: string;
  changes: QuestionChange[];
  /** The questions kept by the save are in a different order. */
  reordered?: true;
  /** Keys of the list before the save, when it removed something: where to put a restored question back. */
  order?: number[];
}

export interface QuestionHistoryResponse {
  /** Newest first. */
  entries: QuestionHistoryEntry[];
  /** Pass as `?before=` for older entries; null when there are none. */
  nextBefore: number | null;
  /**
   * The newest save this response read, even one that changed nothing: pass
   * it as `?after=` for what came since. Null when it read none.
   */
  newest: number | null;
  /** With `?after=`: more saves came since than one response holds. Load the newest page instead. */
  more?: true;
}

// Synced, but a per-device fold: a save that only folds a card changes nothing.
const DEVICE_FIELDS: readonly string[] = ["collapsed"];

/** Custom zones, points and tentacle places: large, and repeated in every save. */
export const BULKY_QUESTION_FIELDS: readonly string[] = ["geo", "places"];

/** A pin's coordinates, which go together: a pin moved along one axis still has both. */
const PIN_FIELD_PAIRS: readonly (readonly [lat: string, lng: string])[] = [
  ["lat", "lng"],
  ["latA", "lngA"],
  ["latB", "lngB"],
];

const OMITTED = { omitted: true } as const;

/**
 * Keys and coordinates can be one ulp off the original: Prisma can store or
 * read a 17-digit double slightly wrong, and a client then saves that. Such
 * numbers are the same. Well under the step between new question keys
 * (1e-15) and anything a player enters.
 */
export const sameNumber = (a: number, b: number) =>
  a === b || Math.abs(a - b) <= 4e-16 * Math.max(Math.abs(a), Math.abs(b));

const sameQuestionKey = (a: unknown, b: unknown): boolean =>
  typeof a === "number" && typeof b === "number" && sameNumber(a, b);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep equality that ignores field order, treats a missing field as
 * undefined, and compares numbers with the same tolerance as keys.
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return sameNumber(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJsonValue(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!sameJsonValue(a[key], b[key])) return false;
    }
    return true;
  }
  return a === b;
}

/** A question's data with `geo` and `places` replaced by `{ omitted: true }`. */
export function stripBulkyData(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const stripped: Record<string, unknown> = { ...data };
  for (const field of BULKY_QUESTION_FIELDS) {
    if (stripped[field] !== undefined) stripped[field] = OMITTED;
  }
  return stripped;
}

interface ListedQuestion {
  key: number;
  id: string;
  data: Record<string, unknown>;
  raw: Record<string, unknown>;
  index: number;
  typeIndex: number;
}

// The entries that are questions at all, with their positions.
function listQuestions(list: unknown): ListedQuestion[] {
  if (!Array.isArray(list)) return [];
  const perType = new Map<string, number>();
  const listed: ListedQuestion[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.key !== "number" || !Number.isFinite(item.key)) continue;
    const id = typeof item.id === "string" ? item.id : "unknown";
    const typeIndex = (perType.get(id) ?? 0) + 1;
    perType.set(id, typeIndex);
    listed.push({
      key: item.key,
      id,
      data: isRecord(item.data) ? item.data : {},
      raw: item,
      index: listed.length,
      typeIndex,
    });
  }
  return listed;
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter(
    (field) => !DEVICE_FIELDS.includes(field) && !sameJsonValue(before[field], after[field]),
  );
}

// The changed fields, plus what a reader needs to make sense of them.
function pickFields(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const wanted = new Set(fields);
  wanted.add("name");
  for (const group of PIN_FIELD_PAIRS) {
    if (group.some((field) => wanted.has(field))) group.forEach((field) => wanted.add(field));
  }
  const picked: Record<string, unknown> = {};
  for (const field of wanted) {
    if (data[field] !== undefined) picked[field] = data[field];
  }
  return stripBulkyData(picked);
}

interface QuestionListDiff {
  changes: QuestionChange[];
  /** The questions in both lists are in a different order. */
  reordered: boolean;
  /** Keys of the previous list, when something was removed. */
  prevOrder?: number[];
}

// Each question of `after` that was in `before`, with what it was there.
// Exact keys first, then near ones for what's left, so a list holding two
// nearly equal keys still pairs each with its own. A key whose type changed
// isn't the same question.
function pairQuestions(before: ListedQuestion[], after: ListedQuestion[]): Map<ListedQuestion, ListedQuestion> {
  const pairs = new Map<ListedQuestion, ListedQuestion>();
  const matched = new Set<ListedQuestion>();
  for (const same of [(a: number, b: number) => a === b, sameQuestionKey]) {
    for (const question of after) {
      if (pairs.has(question)) continue;
      const old = before.find((q) => !matched.has(q) && q.id === question.id && same(q.key, question.key));
      if (!old) continue;
      pairs.set(question, old);
      matched.add(old);
    }
  }
  return pairs;
}

/** What changed from one saved question list to the next. */
export function diffQuestionLists(prev: unknown, next: unknown): QuestionListDiff {
  const before = listQuestions(prev);
  const after = listQuestions(next);
  const pairs = pairQuestions(before, after);
  const matched = new Set(pairs.values());

  const changes: QuestionChange[] = [];
  // Positions in the previous list of the questions kept, in their new order.
  const keptPositions: number[] = [];
  for (const question of after) {
    const old = pairs.get(question);
    if (!old) {
      changes.push({
        kind: "added",
        key: question.key,
        id: question.id,
        index: question.index,
        typeIndex: question.typeIndex,
        after: stripBulkyData(question.data),
      });
      continue;
    }
    keptPositions.push(old.index);
    const fields = changedFields(old.data, question.data);
    if (fields.length === 0) continue;
    changes.push({
      kind: "changed",
      key: question.key,
      id: question.id,
      index: question.index,
      typeIndex: question.typeIndex,
      fields,
      before: pickFields(old.data, fields),
      after: pickFields(question.data, fields),
    });
  }

  const removed = before.filter((q) => !matched.has(q));
  for (const question of removed) {
    changes.push({
      kind: "removed",
      key: question.key,
      id: question.id,
      index: question.index,
      typeIndex: question.typeIndex,
      question: question.raw,
    });
  }

  const reordered = keptPositions.some((position, i) => i > 0 && position < keptPositions[i - 1]);
  return {
    changes,
    reordered,
    ...(removed.length > 0 ? { prevOrder: before.map((q) => q.key) } : {}),
  };
}
