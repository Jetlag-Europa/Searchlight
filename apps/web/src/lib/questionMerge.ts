// A question list is saved whole, and the server replaces its list with it.
// A list made on an older base (offline, or while another device saved)
// would undo the other's changes, so it is merged first: three-way, against
// the server's list it was made from.

type Question = unknown;
type Fields = Record<string, unknown>;

// Fields that only say how one device shows a question (folded, or its
// marker locked). They never decide whether an edit or a removal wins.
const DEVICE_FIELDS = new Set(["collapsed", "drag"]);

// Questions are told apart by their `key`, which a question keeps for life.
// Keys used to be any double from Math.random(), and the API stored them
// with up to one unit in the last place lost (its query engine parsed JSON
// numbers inexactly; it no longer does): 0.47550004144641034 came back as
// 0.4755000414464103. Keys this close are the same key. Random keys are
// never this close: two among a thousand questions have about a 1e-9
// chance.
const KEY_TOLERANCE = 1e-15;

function numericKey(question: Question): number | undefined {
    const key = (question as { key?: unknown } | null)?.key;
    return typeof key === "number" && Number.isFinite(key) ? key : undefined;
}

/** Ids for questions, the same for keys that differ only by rounding. */
function questionIds() {
    const seen: number[] = [];
    return (question: Question): string => {
        const key = numericKey(question);
        if (key === undefined) return `json:${stableJson(question)}`;
        const same = seen.find(
            (k) => Math.abs(k - key) <= KEY_TOLERANCE * Math.max(1, Math.abs(k)),
        );
        if (same !== undefined) return `key:${same}`;
        seen.push(key);
        return `key:${key}`;
    };
}

/** Whether two keys name the same question. */
export function sameQuestionKey(a: number, b: number): boolean {
    return Math.abs(a - b) <= KEY_TOLERANCE * Math.max(1, Math.abs(a));
}

// Stored payloads come back with their keys reordered (Postgres jsonb), so
// compare by content, not by how it is written. Keys compare by id.
function stableJson(value: unknown, depth = 0): string {
    if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, depth + 1)).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .filter((k) => (value as Fields)[k] !== undefined)
            .filter((k) => !(depth === 0 && k === "key"))
            .map((k) => `${JSON.stringify(k)}:${stableJson((value as Fields)[k], depth + 1)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

const same = (a: unknown, b: unknown) => stableJson(a, 1) === stableJson(b, 1);

/** The same question with the same content (keys within rounding). */
export function sameQuestion(a: Question, b: Question): boolean {
    const ka = numericKey(a);
    const kb = numericKey(b);
    if ((ka === undefined) !== (kb === undefined)) return false;
    if (ka !== undefined && kb !== undefined && !sameQuestionKey(ka, kb)) return false;
    return stableJson(a) === stableJson(b);
}

export function sameQuestionList(a: readonly Question[], b: readonly Question[]): boolean {
    return a.length === b.length && a.every((q, i) => sameQuestion(q, b[i]));
}

function dataOf(question: Question): Fields {
    const data = (question as { data?: unknown } | null)?.data;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Fields) : {};
}

// Changed beyond how it's shown on one device.
function changedInSubstance(question: Question, base: Question): boolean {
    const strip = (q: Question) => {
        const data = Object.fromEntries(
            Object.entries(dataOf(q)).filter(([k]) => !DEVICE_FIELDS.has(k)),
        );
        return { ...(q as Fields), data };
    };
    return !sameQuestion(strip(question), strip(base));
}

// Three-way, field by field: what we changed since `base` is ours, the rest
// theirs. Fields inside `data` (an answer, a radius, a location, the lock)
// each count apart. A field both sides changed keeps our value: this save is
// the newest edit, made by someone who saw `base`. The question keeps the
// server's key.
function mergeQuestion(base: Question, ours: Question, theirs: Question): Question {
    const pick = (b: Fields, o: Fields, t: Fields): Fields => {
        const merged: Fields = {};
        for (const field of new Set([...Object.keys(t), ...Object.keys(o)])) {
            const value = !same(o[field], b[field]) ? o[field] : t[field];
            if (value !== undefined) merged[field] = value;
        }
        return merged;
    };
    const b = base as Fields;
    const o = ours as Fields;
    const t = theirs as Fields;
    const merged = pick(
        { ...b, key: t.key, data: undefined },
        { ...o, key: t.key, data: undefined },
        { ...t, data: undefined },
    );
    if ("data" in t || "data" in o) merged.data = pick(dataOf(base), dataOf(ours), dataOf(theirs));
    return merged;
}

/**
 * Merge `local`, made from `base`, into `server`'s current list. Ours: what
 * we added, changed or removed since `base`; theirs: everything else, so
 * what was added, changed or removed elsewhere stays that way. A question
 * changed on both sides merges field by field (see mergeQuestion). One we
 * removed that they changed in substance is kept with their change, and one
 * they removed that we changed in substance is kept with ours; a change to
 * how it's shown (folded, locked) alone doesn't keep it. Our order comes
 * first, then their additions in theirs.
 */
export function mergeQuestionLists<Q>(
    base: readonly Q[],
    local: readonly Q[],
    server: readonly Q[],
): Q[] {
    const idOf = questionIds();
    const baseById = new Map(base.map((q) => [idOf(q), q]));
    const serverById = new Map(server.map((q) => [idOf(q), q]));
    const localIds = new Set(local.map(idOf));
    const merged: Q[] = [];
    for (const question of local) {
        const id = idOf(question);
        const was = baseById.get(id);
        const now = serverById.get(id);
        if (was === undefined) {
            merged.push(question);
        } else if (now !== undefined) {
            merged.push(mergeQuestion(was, question, now) as Q);
        } else if (changedInSubstance(question, was)) {
            merged.push(question);
        }
    }
    for (const question of server) {
        const id = idOf(question);
        if (localIds.has(id)) continue;
        const was = baseById.get(id);
        if (was === undefined || changedInSubstance(question, was)) merged.push(question);
    }
    return merged;
}
