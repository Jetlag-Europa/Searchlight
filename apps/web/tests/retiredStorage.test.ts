import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
    removeRetiredStorage,
    RETIRED_CACHES,
    RETIRED_STORAGE_KEYS,
} from "@/lib/bootstrap";

afterEach(() => vi.unstubAllGlobals());

it("removes retired settings and OpenStreetMap caches, keeping the rest", () => {
    const store = new Map([
        ["mapGeoLocation", "{}"],
        ["customStations", "[]"],
        ["showTutorials", "true"],
        ["disabledStations", '["a"]'],
    ]);
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
    });
    const deleteCache = vi.fn<(name: string) => Promise<boolean>>(
        async () => true,
    );
    vi.stubGlobal("caches", { delete: deleteCache });

    removeRetiredStorage();

    expect([...store.keys()]).toEqual(["disabledStations"]);
    expect(deleteCache.mock.calls.map(([name]) => name)).toEqual(
        RETIRED_CACHES,
    );
});

it("tolerates storage that throws", () => {
    vi.stubGlobal("localStorage", {
        removeItem: () => {
            throw new DOMException(
                "The operation is insecure.",
                "SecurityError",
            );
        },
    });
    vi.stubGlobal("caches", {
        delete: () => Promise.reject(new DOMException("", "SecurityError")),
    });
    expect(() => removeRetiredStorage()).not.toThrow();
});

it("removes no key the app still stores", () => {
    const sources = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const path = resolve(dir, entry.name);
            if (entry.isDirectory()) return sources(path);
            return /\.tsx?$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
        });
    const live = new Set<string>();
    for (const source of sources(resolve(__dirname, "../src"))) {
        const patterns = [
            /persistent(?:Atom|Map)\s*(?:<[\s\S]*?>)?\s*\(\s*"([^"]+)"/g,
            /Storage\(\s*"localStorage",\s*"([^"]+)"/g,
            /localStorage\.\w+\(\s*"([^"]+)"/g,
        ];
        for (const pattern of patterns) {
            for (const [, key] of source.matchAll(pattern)) live.add(key);
        }
    }
    expect(live).toContain("disabledStations");
    expect(RETIRED_STORAGE_KEYS.filter((key) => live.has(key))).toEqual([]);
});
