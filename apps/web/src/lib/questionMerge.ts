// A question list is saved whole, and the server replaces its list with it.
// A list made on an older base (offline, or while another device saved)
// would undo the other's changes, so it is merged first: three-way, against
// the server's list it was made from.

type Question = unknown;

// Questions are told apart by their `key`, which a question keeps for life.
function keyOf(question: Question): string {
    const key = (question as { key?: unknown } | null)?.key;
    return typeof key === "number" ? `key:${key}` : `json:${stableJson(question)}`;
}

// Stored payloads come back with their keys reordered (Postgres jsonb), so
// compare by content, not by how it is written.
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value)
            .sort()
            .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
            .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

export function sameQuestion(a: Question, b: Question): boolean {
    return stableJson(a) === stableJson(b);
}

export function sameQuestionList(a: readonly Question[], b: readonly Question[]): boolean {
    return a.length === b.length && a.every((q, i) => sameQuestion(q, b[i]));
}

/**
 * Merge `local`, made from `base`, into `server`'s current list. Ours: the
 * questions we added, changed or removed since `base`. Theirs: everything
 * else, so questions added, changed or removed elsewhere stay that way. A
 * question both sides changed keeps our version; one we removed that they
 * changed is kept with their change. Our order comes first, then their
 * additions in theirs.
 */
export function mergeQuestionLists<Q>(
    base: readonly Q[],
    local: readonly Q[],
    server: readonly Q[],
): Q[] {
    const baseByKey = new Map(base.map((q) => [keyOf(q), q]));
    const serverByKey = new Map(server.map((q) => [keyOf(q), q]));
    const localKeys = new Set(local.map(keyOf));
    const merged: Q[] = [];
    for (const question of local) {
        const key = keyOf(question);
        const was = baseByKey.get(key);
        if (!was || !sameQuestion(question, was)) {
            merged.push(question);
            continue;
        }
        const now = serverByKey.get(key);
        if (now !== undefined) merged.push(now);
    }
    for (const question of server) {
        const key = keyOf(question);
        if (localKeys.has(key)) continue;
        const was = baseByKey.get(key);
        if (!was || !sameQuestion(question, was)) merged.push(question);
    }
    return merged;
}
