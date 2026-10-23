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

/**
 * Whether two versions of a question ask the same and have the same answer,
 * however each device shows it (folded, locked). Null is a removed one.
 */
export function sameQuestionSubstance(a: Question | null, b: Question | null): boolean {
    if (a === null || b === null) return a === b;
    return !changedInSubstance(a, b);
}

/** A question's key, if it has one (questions without are told apart by content). */
export function questionKey(question: Question): number | undefined {
    return numericKey(question);
}

/** `question` as `shown` shows it: its device fields (folded, locked) from there. */
export function withDeviceFieldsOf<Q>(question: Q, shown: unknown): Q {
    const data: Fields = { ...dataOf(question) };
    for (const field of DEVICE_FIELDS) {
        const value = dataOf(shown)[field];
        if (value === undefined) delete data[field];
        else data[field] = value;
    }
    return { ...(question as Fields), data } as Q;
}

// Three-way. A question's substance (what it asks and its answer) is taken
// whole from one side, since its fields only make sense together (a
// tentacle's places and its kind, a radius and its unit): the side that
// changed it, or `prefer` if both did. The device fields (folded, locked)
// merge one by one: ours where we changed them, else theirs. The question
// keeps the server's key.
function mergeQuestion(
    base: Question,
    ours: Question,
    theirs: Question,
    prefer: "ours" | "theirs",
): Question {
    const oursChanged = changedInSubstance(ours, base);
    const winner =
        oursChanged && (prefer === "ours" || !changedInSubstance(theirs, base))
            ? ours
            : theirs;
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
 * A question both sides changed since the base, differently: both edited
 * what it asks or its answer (`both-changed`), we edited it and they removed
 * it (`they-deleted`), or we removed it and they edited it (`we-deleted`).
 */
export interface DetectedQuestionConflict<Q> {
    key: number;
    kind: "both-changed" | "they-deleted" | "we-deleted";
    mine: Q | null;
    theirs: Q | null;
    base: Q;
    // The key of the question before it on that side (null: it was first;
    // undefined: that side doesn't have it), to put it back where it was.
    mineAfterKey?: number | null;
    theirsAfterKey?: number | null;
}

/** The key of the nearest question with a key before `index` (null: none). */
export function keyBefore(list: readonly Question[], index: number): number | null {
    for (let i = index - 1; i >= 0; i--) {
        const key = numericKey(list[i]);
        if (key !== undefined) return key;
    }
    return null;
}

function mergeLists<Q>(
    base: readonly Q[],
    local: readonly Q[],
    server: readonly Q[],
    hold: false | { own: readonly Q[] },
): { merged: Q[]; conflicts: DetectedQuestionConflict<Q>[] } {
    const idOf = questionIds();
    // A question with a key, changed there to a version we may have saved
    // ourselves, isn't another's change to ask about.
    const holds = (question: Q, theirs: Q | undefined): boolean =>
        hold !== false &&
        numericKey(question) !== undefined &&
        !(
            theirs !== undefined &&
            hold.own.some((own) => {
                const ownKey = numericKey(own);
                const theirKey = numericKey(theirs);
                return (
                    ownKey !== undefined &&
                    theirKey !== undefined &&
                    sameNumber(ownKey, theirKey) &&
                    !changedInSubstance(own, theirs)
                );
            })
        );
    const baseById = new Map(base.map((q) => [idOf(q), q]));
    const serverIndex = new Map(server.map((q, i) => [idOf(q), i]));
    const localIds = new Set(local.map(idOf));
    const merged: Q[] = [];
    const conflicts: DetectedQuestionConflict<Q>[] = [];
    // Only a question with a key is the same question on both sides; one
    // without is told apart by content, so a change makes it another one.
    const conflict = (
        kind: DetectedQuestionConflict<Q>["kind"],
        was: Q,
        mine: { question: Q; index: number } | null,
        theirs: { question: Q; index: number } | null,
    ) => {
        const key = numericKey((theirs ?? mine)!.question)!;
        conflicts.push({
            key,
            kind,
            mine: mine?.question ?? null,
            theirs: theirs?.question ?? null,
            base: was,
            ...(mine ? { mineAfterKey: keyBefore(local, mine.index) } : {}),
            ...(theirs ? { theirsAfterKey: keyBefore(server, theirs.index) } : {}),
        });
    };
    local.forEach((question, index) => {
        const id = idOf(question);
        const was = baseById.get(id);
        const at = serverIndex.get(id);
        const now = at === undefined ? undefined : server[at];
        if (was === undefined) {
            merged.push(question);
        } else if (now !== undefined) {
            const both =
                changedInSubstance(question, was) &&
                changedInSubstance(now, was) &&
                changedInSubstance(question, now);
            const held = both && holds(question, now);
            merged.push(mergeQuestion(was, question, now, held ? "theirs" : "ours") as Q);
            if (held) {
                conflict("both-changed", was, { question, index }, { question: now, index: at! });
            }
        } else if (changedInSubstance(question, was)) {
            // Removed there, edited here: held, the removal stands for now.
            if (holds(question, undefined)) {
                conflict("they-deleted", was, { question, index }, null);
            } else {
                merged.push(question);
            }
        }
    });
    server.forEach((question, index) => {
        const id = idOf(question);
        if (localIds.has(id)) return;
        const was = baseById.get(id);
        if (was === undefined || changedInSubstance(question, was)) {
            merged.push(question);
            if (was !== undefined && holds(question, question)) {
                conflict("we-deleted", was, null, { question, index });
            }
        }
    });
    return { merged, conflicts };
}

/**
 * Merge `local`, made from `base`, into `server`'s current list. Ours: what
 * we added, changed or removed since `base`; theirs: everything else, so
 * what was added, changed or removed elsewhere stays that way. A question
 * changed on both sides merges as mergeQuestion says, ours winning. One we
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
    return mergeLists(base, local, server, false).merged;
}

/**
 * Merge as mergeQuestionLists does, except for a question with a key that
 * both sides changed in substance, differently (an identical change, or a
 * change to how it's shown, isn't one): which version stands is the
 * player's to decide, so it is held. Until then the merged list has the
 * server's version, as if we hadn't touched it: theirs, with the device
 * fields merged as usual; left out if they removed it; kept if we removed
 * it. Each held question comes back in `conflicts`, in list order.
 *
 * `own`: versions of questions that lists of ours sent before may have
 * saved (their answer never came). The server having one of those is our
 * own earlier edit, not another's, and merges as before.
 */
export function mergeQuestionListsWithConflicts<Q>(
    base: readonly Q[],
    local: readonly Q[],
    server: readonly Q[],
    own: readonly Q[] = [],
): { merged: Q[]; conflicts: DetectedQuestionConflict<Q>[] } {
    return mergeLists(base, local, server, { own });
}

/** The index of the question with `key` in `list`, or -1. */
export function indexOfQuestionKey(list: readonly Question[], key: number): number {
    return list.findIndex((q) => {
        const k = numericKey(q);
        return k !== undefined && sameNumber(k, key);
    });
}

/**
 * `list` with its question with `key` as `question`: replaced where it is,
 * or, if the list lacks it, put after the question with `afterKey` (first
 * for null, or when the list lacks that one too, where it is likeliest to
 * be seen), or removed for null.
 */
export function placeQuestion<Q>(
    list: readonly Q[],
    key: number,
    question: Q | null,
    afterKey?: number | null,
): Q[] {
    const at = indexOfQuestionKey(list, key);
    if (question === null) return at === -1 ? [...list] : list.filter((_, i) => i !== at);
    if (at !== -1) return list.map((q, i) => (i === at ? question : q));
    const after = afterKey == null ? -1 : indexOfQuestionKey(list, afterKey);
    return [...list.slice(0, after + 1), question, ...list.slice(after + 1)];
}
