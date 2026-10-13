// Cache keys used to embed the whole play area via JSON.stringify, serializing
// megabytes of coordinates on every lookup and retaining that string per key.
// Play areas are replaced, never mutated, so object identity is a valid key.
const ids = new WeakMap<object, number>();
let nextId = 0;

export function identityKey(value: unknown): number | null {
    if (typeof value !== "object" || value === null) return null;
    let id = ids.get(value);
    if (id === undefined) {
        id = ++nextId;
        ids.set(value, id);
    }
    return id;
}

/** Set a Map entry, evicting the oldest entries beyond `limit`. */
export function setBounded<K, V>(
    cache: Map<K, V>,
    key: K,
    value: V,
    limit: number,
): void {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > limit) cache.delete(cache.keys().next().value!);
}
