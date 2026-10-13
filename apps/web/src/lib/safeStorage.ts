// Web Storage is best-effort: privacy modes and blocked site data can make the
// `localStorage`/`sessionStorage` getters themselves throw (so `typeof` checks
// don't help), as well as their methods. Callers keep working in memory.

type StorageName = "sessionStorage" | "localStorage";

export function readStorage(store: StorageName, key: string): string | null {
    try {
        return globalThis[store]?.getItem(key) ?? null;
    } catch {
        return null;
    }
}

export function writeStorage(
    store: StorageName,
    key: string,
    value: string,
): void {
    try {
        globalThis[store]?.setItem(key, value);
    } catch {
        // Persistence is best-effort.
    }
}

export function removeStorage(store: StorageName, key: string): void {
    try {
        globalThis[store]?.removeItem(key);
    } catch {
        // Persistence is best-effort.
    }
}
