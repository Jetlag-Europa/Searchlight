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
        ["jetlag-annotations-v1", '{"version":1,"strokes":{}}'],
        ["disabledStations", '["a"]'],
        ["disabledZones", '{"s":["a"]}'],
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

    expect([...store.keys()]).toEqual(["disabledZones"]);
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
        // A key is a string, or a constant defined in the same module.
        const constants = new Map(
            [...source.matchAll(/const (\w+) = "([^"]+)"/g)].map(
                ([, name, value]) => [name, value],
            ),
        );
        const key = String.raw`(?:"([^"]+)"|(\w+))`;
        const patterns = [
            String.raw`persistent(?:Atom|Map)\s*(?:<[\s\S]*?>)?\s*\(\s*${key}`,
            String.raw`Storage\(\s*"localStorage",\s*${key}`,
            String.raw`localStorage\.\w+\(\s*${key}`,
        ];
        for (const pattern of patterns) {
            for (const [, literal, name] of source.matchAll(
                new RegExp(pattern, "g"),
            )) {
                const value = literal ?? constants.get(name);
                if (value) live.add(value);
            }
        }
    }
    expect(live).toContain("disabledZones");
    expect(live).toContain("lastGameView");
    // Defined as a constant.
    expect(live).toContain("taibled-last-session");
    expect(RETIRED_STORAGE_KEYS.filter((key) => live.has(key))).toEqual([]);
});
