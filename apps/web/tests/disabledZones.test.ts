import type { GameSessionSummary } from "@searchlight/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    applyZonesDelta,
    diffZoneIds,
    disabledStations,
    disableZones,
    forgetLegacyDisabledZones,
    legacyDisabledZones,
    onDisabledZonesEdit,
    sameZoneIds,
    setDisabledStations,
    toggleDisabledZone,
    type ZonesDelta,
} from "@/lib/disabledZones";
import { discardSessionData, getPendingEvents } from "@/lib/eventQueue";
import { activeSessionId } from "@/lib/activeSession";
import {
    applyDisabledZonesEvent,
    cancelPendingDisabledZonesSave,
    flushDisabledZonesSave,
    flushSessionSaves,
    loadSessionContent,
    saveDisabledZonesDelta,
    setDisabledZonesBase,
} from "@/lib/sessionState";
import { flushPendingEvents } from "@/lib/syncManager";

let store: Map<string, string>;
let requests: RequestInit[];

const delta = (
    disableZoneIds: string[],
    enableZoneIds: string[] = [],
): ZonesDelta => ({ disableZoneIds, enableZoneIds });
const sorted = (ids: readonly string[]) => [...ids].sort();
// A PATCH's zone change, without the change's ID.
const changeOf = (request: RequestInit): ZonesDelta => {
    const { disableZoneIds, enableZoneIds } = JSON.parse(request.body as string);
    return { disableZoneIds, enableZoneIds };
};

beforeEach(() => {
    store = new Map();
    requests = [];
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, options?: RequestInit) => {
            if (options) requests.push(options);
            return Response.json({});
        }),
    );
    disabledStations.set([]);
});

afterEach(() => {
    cancelPendingDisabledZonesSave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("compares zone lists in any order", () => {
    expect(sameZoneIds(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameZoneIds(["a"], ["a", "b"])).toBe(false);
    expect(sameZoneIds([], [])).toBe(true);
});

describe("zone deltas", () => {
    it("are what changed between two lists", () => {
        expect(diffZoneIds(["a", "b"], ["b", "c"])).toEqual(delta(["c"], ["a"]));
        expect(diffZoneIds(["a"], ["a"])).toEqual(delta([]));
    });

    it("apply as set operations", () => {
        expect(sorted(applyZonesDelta(["a", "b"], delta(["c", "a"], ["b", "x"])))).toEqual([
            "a",
            "c",
        ]);
    });

});

describe("the player's edits", () => {
    it("are reported as the change to what the board showed", () => {
        const edits: ZonesDelta[] = [];
        const stop = onDisabledZonesEdit((d) => edits.push(d));
        try {
            disabledStations.set(["a", "b"]);
            setDisabledStations(["b", "c"]);
            setDisabledStations(["c", "b"]);
            expect(edits).toEqual([delta(["c"], ["a"])]);
        } finally {
            stop();
        }
    });

    it("toggle a zone against the current list, not one read earlier", () => {
        const edits: ZonesDelta[] = [];
        const stop = onDisabledZonesEdit((d) => edits.push(d));
        try {
            // The sidebar rendered with ["a"]; another player's "b" then
            // landed before the toggle ran.
            disabledStations.set(["a", "b"]);
            toggleDisabledZone("c");
            expect(sorted(disabledStations.get())).toEqual(["a", "b", "c"]);
            toggleDisabledZone("a");
            expect(disabledStations.get()).toEqual(["b", "c"]);
            expect(edits).toEqual([delta(["c"]), delta([], ["a"])]);
        } finally {
            stop();
        }
    });

    it("Disable All keeps the zones already disabled", () => {
        const edits: ZonesDelta[] = [];
        const stop = onDisabledZonesEdit((d) => edits.push(d));
        try {
            // "x" was disabled, then the questions ruled it out, so it isn't
            // listed any more.
            disabledStations.set(["x", "a"]);
            disableZones(["a", "b", "c"]);
            expect(sorted(disabledStations.get())).toEqual(["a", "b", "c", "x"]);
            expect(edits).toEqual([delta(["b", "c"])]);
        } finally {
            stop();
        }
    });
});

describe("saving disabled zones", () => {
    const SID = "zones-save";

    beforeEach(() => {
        setDisabledZonesBase(SID, []);
    });

    it("merges edits made within the debounce into one delta", async () => {
        vi.useFakeTimers();
        saveDisabledZonesDelta(SID, delta(["a"]));
        saveDisabledZonesDelta(SID, delta(["b"]));
        saveDisabledZonesDelta(SID, delta([], ["a", "z"]));
        expect(getPendingEvents(SID)).toEqual([]);
        await vi.advanceTimersByTimeAsync(300);
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe("PATCH");
        // Enabling "z", which isn't disabled, is no change.
        expect(changeOf(requests[0])).toEqual(delta(["b"]));
        expect(JSON.parse(requests[0].body as string).zonesClientUuid).toMatch(
            /^zones-disabled-[0-9a-f-]+$/,
        );
        expect(getPendingEvents(SID)).toEqual([]);
    });

    it("saves nothing for a zone toggled back and forth", async () => {
        vi.useFakeTimers();
        saveDisabledZonesDelta(SID, delta(["a"]));
        saveDisabledZonesDelta(SID, delta([], ["a"]));
        await vi.advanceTimersByTimeAsync(1000);
        expect(requests).toEqual([]);
    });

    it("keeps an enable when another player disabled the zone meanwhile", async () => {
        vi.useFakeTimers();
        setDisabledZonesBase(SID, []);
        saveDisabledZonesDelta(SID, delta(["a"]));
        applyDisabledZonesEvent(SID, ["a"], "zones-disabled-theirs");
        saveDisabledZonesDelta(SID, delta([], ["a"]));
        expect(disabledStations.get()).toEqual([]);
        await vi.advanceTimersByTimeAsync(300);
        expect(requests.map(changeOf)).toEqual([delta([], ["a"])]);
    });

    it("sends each queued delta, in order", async () => {
        const first = Promise.withResolvers<Response>();
        vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
            requests.push(options!);
            return first.promise;
        });
        saveDisabledZonesDelta(SID, delta(["a"]));
        const sendingFirst = flushDisabledZonesSave(SID);
        saveDisabledZonesDelta(SID, delta(["b"]));
        const sendingSecond = flushDisabledZonesSave(SID);
        // Both stay queued: neither replaces the other.
        expect(getPendingEvents(SID)).toHaveLength(2);
        expect(requests).toHaveLength(1);
        first.resolve(Response.json({}));
        await Promise.all([sendingFirst, sendingSecond]);
        expect(requests.map(changeOf)).toEqual([delta(["a"]), delta(["b"])]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    it("never sends a delta ahead of an earlier one that failed", async () => {
        // A server applying changes in the order they arrive.
        let server = new Set<string>();
        const statuses = [503];
        vi.mocked(fetch).mockImplementation(async (_url, options) => {
            requests.push(options!);
            const status = statuses.shift() ?? 200;
            if (status === 200) {
                const change = changeOf(options!);
                server = new Set(applyZonesDelta([...server], change));
            }
            return Response.json({}, { status });
        });
        setDisabledZonesBase(SID, []);
        saveDisabledZonesDelta(SID, delta(["a"]));
        await expect(flushDisabledZonesSave(SID)).rejects.toThrow();
        expect(disabledStations.get()).toEqual(["a"]);

        saveDisabledZonesDelta(SID, delta([], ["a"]));
        await flushDisabledZonesSave(SID);
        expect(requests.map(changeOf)).toEqual([
            delta(["a"]),
            delta(["a"]),
            delta([], ["a"]),
        ]);
        expect([...server]).toEqual([]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    it("waits behind an earlier delta that keeps failing", async () => {
        vi.mocked(fetch).mockImplementation(async (_url, options) => {
            requests.push(options!);
            return Response.json({}, { status: 503 });
        });
        saveDisabledZonesDelta(SID, delta(["a"]));
        await expect(flushDisabledZonesSave(SID)).rejects.toThrow();
        saveDisabledZonesDelta(SID, delta(["b"]));
        await flushDisabledZonesSave(SID);
        expect(requests.map(changeOf)).toEqual([delta(["a"]), delta(["a"])]);
        expect(getPendingEvents(SID).map((e) => e.payloadJson)).toEqual([
            delta(["a"]),
            delta(["b"]),
        ]);
    });

    it("rejects instead of throwing when storage is full", async () => {
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => {
                throw new DOMException("full", "QuotaExceededError");
            },
            removeItem: () => {},
        });
        saveDisabledZonesDelta(SID, delta(["a"]));
        let flushing: Promise<void> | undefined;
        expect(() => {
            flushing = flushDisabledZonesSave(SID);
        }).not.toThrow();
        await expect(flushing).rejects.toThrow();
        expect(() => flushSessionSaves(SID)).not.toThrow();
    });

    it("resends the same delta after a lost reply", async () => {
        vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
            requests.push(options!);
            throw new TypeError("connection lost after commit");
        });
        saveDisabledZonesDelta(SID, delta(["a"]));
        await expect(flushDisabledZonesSave(SID)).rejects.toThrow();
        await flushPendingEvents(SID);
        expect(requests.map(changeOf)).toEqual([delta(["a"]), delta(["a"])]);
        // The same ID both times, so the server applies it once.
        const ids = requests.map((r) => JSON.parse(r.body as string).zonesClientUuid);
        expect(ids[0]).toBe(ids[1]);
        expect(getPendingEvents(SID)).toEqual([]);
    });

    it("sends with keepalive only within the browser's budget", async () => {
        saveDisabledZonesDelta(SID, delta(["a"]));
        await flushDisabledZonesSave(SID, true);
        const many = Array.from({ length: 2000 }, (_, i) => `zone-${"x".repeat(40)}-${i}`);
        saveDisabledZonesDelta(SID, delta(many));
        await flushDisabledZonesSave(SID, true);
        expect(requests.map((r) => r.keepalive)).toEqual([true, false]);
    });

    it("drops a refused delta from the board", async () => {
        vi.mocked(fetch).mockImplementationOnce(async () =>
            Response.json({}, { status: 400 }),
        );
        setDisabledZonesBase(SID, ["a"]);
        saveDisabledZonesDelta(SID, delta(["b"]));
        expect(sorted(disabledStations.get())).toEqual(["a", "b"]);
        await expect(flushDisabledZonesSave(SID)).rejects.toThrow();
        expect(getPendingEvents(SID)).toEqual([]);
        expect(disabledStations.get()).toEqual(["a"]);
    });
});

describe("the board", () => {
    const SID = "zones-board";

    it("shows unsaved deltas on top of the server's list after a reload", async () => {
        vi.mocked(fetch).mockImplementation(async () => {
            throw new TypeError("offline");
        });
        setDisabledZonesBase(SID, ["a", "b"]);
        saveDisabledZonesDelta(SID, delta(["c"], ["a"]));
        await expect(flushDisabledZonesSave(SID)).rejects.toThrow();

        // A reload: only what's queued in storage is left.
        disabledStations.set([]);
        setDisabledZonesBase(SID, ["a", "b", "d"]);
        expect(sorted(disabledStations.get())).toEqual(["b", "c", "d"]);
    });

    it("never shows another session's base", () => {
        setDisabledZonesBase("other", ["x"]);
        setDisabledZonesBase(SID, []);
        expect(disabledStations.get()).toEqual([]);
    });

    it("is cleared with the active session", () => {
        activeSessionId.set(SID);
        setDisabledZonesBase(SID, ["a"]);
        activeSessionId.set("");
        expect(disabledStations.get()).toEqual([]);
        // The base went too.
        saveDisabledZonesDelta(SID, delta(["b"]));
        expect(disabledStations.get()).toEqual([]);
    });

    describe("as our own change is saved", () => {
        let reply: PromiseWithResolvers<Response>;
        let sending: Promise<void>;
        let clientUuid: string;

        beforeEach(() => {
            reply = Promise.withResolvers<Response>();
            vi.mocked(fetch).mockImplementation(async (_url, options) => {
                requests.push(options!);
                return reply.promise;
            });
            setDisabledZonesBase(SID, []);
            saveDisabledZonesDelta(SID, delta(["a"]));
            sending = flushDisabledZonesSave(SID);
            clientUuid = getPendingEvents(SID)[0].clientUuid;
            expect(disabledStations.get()).toEqual(["a"]);
        });

        it("follows the server once its echo came first", async () => {
            applyDisabledZonesEvent(SID, ["a"], clientUuid);
            expect(getPendingEvents(SID)).toEqual([]);
            applyDisabledZonesEvent(SID, [], "zones-disabled-theirs");
            expect(disabledStations.get()).toEqual([]);
            reply.resolve(Response.json({}));
            await sending;
            expect(disabledStations.get()).toEqual([]);
        });

        it("keeps it shown from the reply until its echo, then follows the server", async () => {
            reply.resolve(Response.json({}));
            await sending;
            expect(getPendingEvents(SID)).toEqual([]);
            expect(disabledStations.get()).toEqual(["a"]);
            // Another player's change, made before ours.
            applyDisabledZonesEvent(SID, ["b"], "zones-disabled-earlier");
            expect(sorted(disabledStations.get())).toEqual(["a", "b"]);
            applyDisabledZonesEvent(SID, ["a", "b"], clientUuid);
            applyDisabledZonesEvent(SID, ["b"], "zones-disabled-later");
            expect(disabledStations.get()).toEqual(["b"]);
        });

        it("keeps a later change's enable until its own echo", async () => {
            reply.resolve(Response.json({}));
            await sending;
            saveDisabledZonesDelta(SID, delta([], ["a"]));
            await flushDisabledZonesSave(SID);
            const enable = JSON.parse(requests[1].body as string).zonesClientUuid;
            expect(disabledStations.get()).toEqual([]);
            // An unrelated change committed before both.
            applyDisabledZonesEvent(SID, ["b"], "zones-disabled-earlier");
            expect(disabledStations.get()).toEqual(["b"]);
            applyDisabledZonesEvent(SID, ["a", "b"], clientUuid);
            expect(disabledStations.get()).toEqual(["b"]);
            applyDisabledZonesEvent(SID, ["b"], enable);
            expect(disabledStations.get()).toEqual(["b"]);
            applyDisabledZonesEvent(SID, [], "zones-disabled-later");
            expect(disabledStations.get()).toEqual([]);
        });
    });
});

describe("disabled zones kept on the device before they synced", () => {
    it("reads a session's valid IDs, keeping other sessions' until the key is empty", () => {
        store.set(
            "disabledZones",
            JSON.stringify({
                one: ["a", "", 5, null, "x".repeat(1001), "x".repeat(1000), "a"],
                two: ["b"],
            }),
        );

        expect(legacyDisabledZones("one")).toEqual(["a", "x".repeat(1000)]);
        forgetLegacyDisabledZones("one");
        expect(JSON.parse(store.get("disabledZones")!)).toEqual({ two: ["b"] });
        expect(legacyDisabledZones("one")).toEqual([]);

        forgetLegacyDisabledZones("two");
        expect(store.has("disabledZones")).toBe(false);
    });

    it("reads nothing from a corrupt entry, and drops it", () => {
        store.set("disabledZones", "{");
        expect(legacyDisabledZones("one")).toEqual([]);
        forgetLegacyDisabledZones("one");
        expect(store.has("disabledZones")).toBe(false);

        store.set("disabledZones", JSON.stringify({ one: "a" }));
        expect(legacyDisabledZones("one")).toEqual([]);
    });

    it("drops a discarded session's entry", () => {
        store.set("disabledZones", JSON.stringify({ one: ["a"] }));
        discardSessionData("one");
        expect(store.has("disabledZones")).toBe(false);
    });

    describe("on session load", () => {
        let session: Partial<GameSessionSummary>;
        let patches: unknown[];

        beforeEach(() => {
            session = { id: "one", disabledZoneIds: [] };
            patches = [];
            vi.stubGlobal(
                "fetch",
                vi.fn(async (url: string, options?: RequestInit) => {
                    if (options?.method === "PATCH") {
                        patches.push(JSON.parse(options.body as string));
                        return Response.json(session);
                    }
                    if (url.endsWith("/events/cursor")) {
                        return Response.json({ sequence: 0 });
                    }
                    if (url.endsWith("/questions")) {
                        return Response.json({ questions: [] });
                    }
                    if (url.endsWith("/strokes")) {
                        return Response.json({ strokes: [] });
                    }
                    return Response.json(session);
                }),
            );
        });

        it("adds them to the session's own, whatever it has", async () => {
            session.disabledZoneIds = ["c", "a"];
            store.set("disabledZones", JSON.stringify({ one: ["a", "b", ""] }));

            const loaded = await loadSessionContent("one", "user");

            // Queued durably before the device's copy is gone, without what
            // the session already has.
            expect(getPendingEvents("one")).toMatchObject([
                {
                    type: "zones.disabled",
                    payloadJson: delta(["b"]),
                },
            ]);
            expect(store.has("disabledZones")).toBe(false);
            setDisabledZonesBase("one", loaded.session.disabledZoneIds);
            expect(sorted(disabledStations.get())).toEqual(["a", "b", "c"]);
            await vi.waitFor(() => expect(patches).toMatchObject([delta(["b"])]));
        });

        it("sends nothing when the session has them all", async () => {
            session.disabledZoneIds = ["a"];
            store.set("disabledZones", JSON.stringify({ one: ["a"] }));

            await loadSessionContent("one", "user");

            expect(getPendingEvents("one")).toEqual([]);
            expect(store.has("disabledZones")).toBe(false);
        });

        it("keeps them while the server doesn't sync disabled zones", async () => {
            delete session.disabledZoneIds;
            store.set("disabledZones", JSON.stringify({ one: ["a"] }));

            await loadSessionContent("one", "user");

            expect(getPendingEvents("one")).toEqual([]);
            expect(store.has("disabledZones")).toBe(true);
        });
    });
});
