// A question list is saved whole, and the server replaces its list with it.
// A list made on an older base (offline, or while another device saved)
// would undo the other's changes, so it is merged first: three-way, against
// the server's list it was made from.

type Question = unknown;
type Fields = Record<string, unknown>;

// Fields that only say how one device shows a question (folded, or its
// marker locked). They merge on their own and never decide which side's
// question wins, or whether an edit or a removal does.
const DEVICE_FIELDS = new Set(["collapsed", "drag"]);

// Until the API wrote payloads exactly, every number in them that needed all
// 17 digits could come back one unit in the last place off (a key
// 0.47550004144641034 as 0.4755000414464103, a latitude likewise). Numbers
// this close are the same number. That's well under the step between new
// question keys (1e-15, see newQuestionKey) and anything a player enters.
const RELATIVE_TOLERANCE = 4e-16;

function sameNumber(a: number, b: number): boolean {
    return a === b || Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

// Content equality, whatever order the fields come in (Postgres jsonb
// reorders them), with numbers compared within rounding.
function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === "number" && typeof b === "number") return sameNumber(a, b);
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((v, i) => sameValue(v, b[i]))
        );
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const field of fields) {
            if (!sameValue((a as Fields)[field], (b as Fields)[field])) return false;
        }
        return true;
    }
    // A missing field reads as undefined, the same as an undefined one.
    return a === b;
}

function numericKey(question: Question): number | undefined {
    const key = (question as { key?: unknown } | null)?.key;
    return typeof key === "number" && Number.isFinite(key) ? key : undefined;
}

/** Whether two keys name the same question. */
export function sameQuestionKey(a: number, b: number): boolean {
    return sameNumber(a, b);
}

// A stable text for a question without a key, which is told apart by content.
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .filter((k) => (value as Fields)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${stableJson((value as Fields)[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

/** Ids for questions, by key: the same for keys within rounding. */
function questionIds() {
    const seen: number[] = [];
    return (question: Question): string => {
        const key = numericKey(question);
        if (key === undefined) return `json:${stableJson(question)}`;
        const same = seen.find((k) => sameNumber(k, key));
        if (same !== undefined) return `key:${same}`;
        seen.push(key);
        return `key:${key}`;
    };
}

/** The same question with the same content (numbers within rounding). */
export function sameQuestion(a: Question, b: Question): boolean {
    return sameValue(a, b);
}

export function sameQuestionList(a: readonly Question[], b: readonly Question[]): boolean {
    return a.length === b.length && a.every((q, i) => sameQuestion(q, b[i]));
}

function dataOf(question: Question): Fields {
    const data = (question as { data?: unknown } | null)?.data;
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Fields) : {};
}

// The question without its device fields and key: what it asks, and its
// answer.
function substance(question: Question): Fields {
    const rest: Fields = { ...(question as Fields) };
    delete rest.key;
    rest.data = Object.fromEntries(
        Object.entries(dataOf(question)).filter(([k]) => !DEVICE_FIELDS.has(k)),
    );
    return rest;
}

function changedInSubstance(question: Question, base: Question): boolean {
    return !sameValue(substance(question), substance(base));
}

// Three-way. A question's substance (what it asks and its answer) is taken
// whole from one side, since its fields only make sense together (a
// tentacle's places and its kind, a radius and its unit): the side that
// changed it, or ours if both did, as this save is the newest edit, made by
// someone who saw `base`. The device fields (folded, locked) merge one by
// one: ours where we changed them, else theirs. The question keeps the
// server's key.
function mergeQuestion(base: Question, ours: Question, theirs: Question): Question {
    const winner = changedInSubstance(ours, base) ? ours : theirs;
    const data: Fields = { ...dataOf(winner) };
    for (const field of DEVICE_FIELDS) {
        const value = !sameValue(dataOf(ours)[field], dataOf(base)[field])
            ? dataOf(ours)[field]
            : dataOf(theirs)[field];
        if (value === undefined) delete data[field];
        else data[field] = value;
    }
    const merged: Fields = { ...(winner as Fields), key: (theirs as Fields).key };
    if ("data" in (winner as Fields) || Object.keys(data).length > 0) merged.data = data;
    return merged;
}

/**
 * Merge `local`, made from `base`, into `server`'s current list. Ours: what
 * we added, changed or removed since `base`; theirs: everything else, so
 * what was added, changed or removed elsewhere stays that way. A question
 * changed on both sides merges as mergeQuestion says. One we removed that
 * they changed in substance is kept with their change, and one they removed
 * that we changed in substance is kept with ours; a change to how it's shown
 * (folded, locked) alone doesn't keep it. Our order comes first, then their
 * additions in theirs.
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
