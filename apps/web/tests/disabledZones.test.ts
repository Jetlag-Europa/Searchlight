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
import {
    discardSessionData,
    getCachedSession,
    getPendingEvents,
    setCachedSession,
} from "@/lib/eventQueue";
import {
    activeSessionId,
    activeSessionRole,
    offlineUserId,
    verifiedUserId,
} from "@/lib/activeSession";
import {
    applyDisabledZonesEvent,
    becomeSpectator,
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

describe("disabled zones changed while playing offline", () => {
    const SID = "zones-offline";

    afterEach(() => {
        offlineUserId.set(null);
        verifiedUserId.set(null);
    });

    it("are queued for the account played as, and sent once /me verifies it", async () => {
        offlineUserId.set("u1");
        setDisabledZonesBase(SID, ["a"]);
        saveDisabledZonesDelta(SID, delta(["b"], ["a"]));
        // Offline the page may close any time: the change is queued now.
        await expect(flushDisabledZonesSave(SID, true)).rejects.toThrow();
        expect(requests).toEqual([]);
        expect(store.has(`taibled-pending-${SID}~u1`)).toBe(true);
        expect(store.has(`taibled-pending-${SID}`)).toBe(false);
        expect(disabledStations.get()).toEqual(["b"]);

        // A reload, still offline: the board shows it from the queue.
        disabledStations.set([]);
        setDisabledZonesBase(SID, ["a"]);
        expect(disabledStations.get()).toEqual(["b"]);

        // Another account on this browser neither sees nor sends it.
        offlineUserId.set(null);
        verifiedUserId.set("u2");
        setDisabledZonesBase(SID, ["a"]);
        expect(disabledStations.get()).toEqual(["a"]);
        await flushPendingEvents(SID);
        expect(requests).toEqual([]);

        // /me verifies the account it was made by.
        verifiedUserId.set("u1");
        await flushPendingEvents(SID);
        expect(requests.map(changeOf)).toEqual([delta(["b"], ["a"])]);
        expect(getPendingEvents(SID)).toEqual([]);
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

    // An API from before zones synced answers a save without the list.
    describe("as our own change is saved, answered without the list", () => {
        let reply: PromiseWithResolvers<Response>;
        let sending: Promise<void>;
        let clientUuid: string;

        beforeEach(() => {
            reply = Promise.withResolvers<Response>();
            vi.mocked(fetch).mockImplementation(async (_url, options) => {
                requests.push(options!);
                // Each request its own reply: one is read only once.
                return (await reply.promise).clone();
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

// Loads, events and the replies to our saves each bring the server's whole
// list with the event sequence it is as of, in any order.
describe("the newest list the server sent", () => {
    const SID = "zones-sequence";
    // A PATCH's reply: the session as saved.
    const saved = (ids: string[], sequence: number) =>
        Response.json({ disabledZoneIds: ids, disabledZonesSequence: sequence });
    // What this browser keeps of the session.
    const keep = (ids: string[], sequence: number, userId?: string) =>
        setCachedSession({
            sessionId: SID,
            userId,
            strokes: [],
            questions: [],
            disabledZoneIds: ids,
            disabledZonesSequence: sequence,
            lastSyncedAt: 0,
            lastSequence: sequence,
        });
    const keptZones = () => {
        const kept = getCachedSession(SID);
        return [kept?.disabledZoneIds, kept?.disabledZonesSequence];
    };
    let reply: PromiseWithResolvers<Response>;
    let sending: Promise<void>;
    let clientUuid: string;

    // The board was on another session before: nothing is known of this one.
    beforeEach(() => setDisabledZonesBase("another", []));

    // We disable "a" on a board made from `ids` as of `sequence`; the save
    // is on its way.
    const disableA = (ids: string[] = [], sequence = 0) => {
        reply = Promise.withResolvers<Response>();
        vi.mocked(fetch).mockImplementation(async (_url, options) => {
            requests.push(options!);
            return reply.promise;
        });
        keep(ids, sequence);
        setDisabledZonesBase(SID, ids, sequence);
        saveDisabledZonesDelta(SID, delta(["a"]));
        sending = flushDisabledZonesSave(SID);
        clientUuid = getPendingEvents(SID)[0].clientUuid;
    };

    it("is the board's from our save's reply on, whatever older comes after", async () => {
        disableA();
        // Another player's "b" was saved just before ours.
        reply.resolve(saved(["a", "b"], 2));
        await sending;
        expect(getPendingEvents(SID)).toEqual([]);
        expect(sorted(disabledStations.get())).toEqual(["a", "b"]);
        // The stream gets there later: nothing flickers back.
        const board = disabledStations.get();
        applyDisabledZonesEvent(SID, ["b"], "zones-disabled-theirs", 1);
        applyDisabledZonesEvent(SID, ["a", "b"], clientUuid, 2);
        expect(disabledStations.get()).toBe(board);
        applyDisabledZonesEvent(SID, ["b"], "zones-disabled-later", 3);
        expect(disabledStations.get()).toEqual(["b"]);
    });

    it("follows a later change when our reply comes after a load that had ours", async () => {
        disableA();
        // Saved as event 1, the reply slow. The session loads meanwhile:
        // its list has ours, and its stream starts after event 1.
        setDisabledZonesBase(SID, ["a"], 1);
        reply.resolve(saved(["a"], 1));
        await sending;
        expect(getPendingEvents(SID)).toEqual([]);
        expect(disabledStations.get()).toEqual(["a"]);
        // Another player enables it again: our echo never came, and never
        // will.
        applyDisabledZonesEvent(SID, [], "zones-disabled-theirs", 2);
        expect(disabledStations.get()).toEqual([]);
    });

    it("is asked for again when the reply to our save is cut off", async () => {
        disableA();
        // Saved as event 1. The session loads meanwhile, as above.
        setDisabledZonesBase(SID, ["a"], 1);
        reply.resolve(
            new Response(
                new ReadableStream({
                    start: (controller) =>
                        controller.error(new TypeError("terminated")),
                }),
                { headers: { "Content-Type": "application/json" } },
            ),
        );
        await expect(sending).rejects.toThrow("terminated");
        // Still queued under its ID, not taken for saved by an API from
        // before: nothing of ours would then follow the list.
        expect(getPendingEvents(SID).map((event) => event.clientUuid)).toEqual(
            [clientUuid],
        );
        // Another player enables it again, then the resend is answered.
        applyDisabledZonesEvent(SID, [], "zones-disabled-theirs", 2);
        vi.mocked(fetch).mockImplementation(async () => saved([], 2));
        await flushPendingEvents(SID);
        expect(getPendingEvents(SID)).toEqual([]);
        expect(disabledStations.get()).toEqual([]);
    });

    it("stays when the reply to our save is older", async () => {
        disableA();
        // Our echo, then another player's enable, both before the reply.
        applyDisabledZonesEvent(SID, ["a"], clientUuid, 1);
        applyDisabledZonesEvent(SID, [], "zones-disabled-theirs", 2);
        reply.resolve(saved(["a"], 1));
        await sending;
        expect(disabledStations.get()).toEqual([]);
    });

    it("stays when a session load read an older one", async () => {
        disableA();
        reply.resolve(saved(["a"], 1));
        await sending;
        // The load read the session before our save landed.
        setDisabledZonesBase(SID, [], 0);
        expect(disabledStations.get()).toEqual(["a"]);
        // The one a later load reads replaces it.
        setDisabledZonesBase(SID, ["b"], 4);
        expect(disabledStations.get()).toEqual(["b"]);
    });

    it("has a resent change as the server has it now", async () => {
        disableA();
        // Applied the first time (the reply was lost); another player
        // enabled "a" and disabled "b" since.
        reply.resolve(saved(["b"], 3));
        await sending;
        expect(disabledStations.get()).toEqual(["b"]);
    });

    it("is kept before our save's echo, for a reload without the server", async () => {
        disableA();
        reply.resolve(saved(["a"], 1));
        await sending;
        expect(getPendingEvents(SID)).toEqual([]);
        expect(keptZones()).toEqual([["a"], 1]);

        // A reload offline: only what's in storage is left.
        disabledStations.set([]);
        setDisabledZonesBase("another", []);
        const kept = getCachedSession(SID)!;
        setDisabledZonesBase(SID, kept.disabledZoneIds!, kept.disabledZonesSequence);
        expect(disabledStations.get()).toEqual(["a"]);
    });

    it("is kept for a session left before its save was answered", async () => {
        disableA();
        // Another session is on the board by the time the reply comes.
        setDisabledZonesBase("another", ["x"], 7);
        reply.resolve(saved(["a"], 1));
        await sending;
        expect(disabledStations.get()).toEqual(["x"]);
        expect(keptZones()).toEqual([["a"], 1]);
    });

    it("is not replaced in what's kept by an older reply or an older load", async () => {
        disableA();
        // The stream is ahead: another player's change is kept already.
        keep(["b"], 5);
        reply.resolve(saved(["a"], 1));
        await sending;
        expect(keptZones()).toEqual([["b"], 5]);

        // A load that read the session before that change.
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.endsWith("/events/cursor")) return Response.json({ sequence: 4 });
                if (url.endsWith("/questions")) return Response.json({ questions: [] });
                if (url.endsWith("/strokes")) return Response.json({ strokes: [] });
                return Response.json({
                    id: SID,
                    gameId: "game",
                    gameRevisionId: "rev",
                    name: "Session",
                    disabledZoneIds: ["a"],
                    disabledZonesSequence: 4,
                });
            }),
        );
        await loadSessionContent(SID, "user");
        expect(keptZones()).toEqual([["b"], 5]);
    });

    it("isn't shown to another account that signed in before the reply", async () => {
        verifiedUserId.set("u1");
        activeSessionId.set(SID);
        try {
            disableA();
            // Signing out clears the board; another account signs in.
            activeSessionId.set("");
            verifiedUserId.set("u2");
            reply.resolve(saved(["a"], 1));
            await sending;
            expect(disabledStations.get()).toEqual([]);
            // The first account's change stays queued for it: sent again
            // when it's back, and recognised.
            expect(getPendingEvents(SID)).toEqual([]);
            verifiedUserId.set("u1");
            expect(getPendingEvents(SID)).toHaveLength(1);
        } finally {
            activeSessionId.set("");
            verifiedUserId.set(null);
        }
    });
});

describe("a read-only board", () => {
    const SID = "zones-read-only";

    beforeEach(() => {
        activeSessionId.set(SID);
        activeSessionRole.set(null);
        setDisabledZonesBase(SID, ["a"]);
    });

    afterEach(() => {
        activeSessionRole.set(null);
        activeSessionId.set("");
    });

    it("keeps showing the session's zones when a spectator taps one", async () => {
        activeSessionRole.set("viewer");
        const edits: ZonesDelta[] = [];
        const stop = onDisabledZonesEdit((d) => edits.push(d));
        try {
            toggleDisabledZone("b");
            disableZones(["c"]);
            setDisabledStations([]);
        } finally {
            stop();
        }
        expect(disabledStations.get()).toEqual(["a"]);
        expect(edits).toEqual([]);
        // Nor is a change saved that reached the save some other way.
        saveDisabledZonesDelta(SID, delta(["b"]));
        await flushDisabledZonesSave(SID);
        expect(getPendingEvents(SID)).toEqual([]);
        expect(requests).toEqual([]);
        expect(disabledStations.get()).toEqual(["a"]);
    });

    it("still follows the other players' changes", () => {
        activeSessionRole.set("viewer");
        applyDisabledZonesEvent(SID, ["a", "b"], "zones-disabled-theirs");
        expect(sorted(disabledStations.get())).toEqual(["a", "b"]);
    });

    it("drops a player's unsent changes once they only spectate", async () => {
        // One queued (its send fails), one still in the debounce.
        vi.mocked(fetch).mockImplementationOnce(async () => {
            throw new TypeError("offline");
        });
        saveDisabledZonesDelta(SID, delta(["b"]));
        await flushDisabledZonesSave(SID).catch(() => {});
        saveDisabledZonesDelta(SID, delta(["c"]));
        expect(sorted(disabledStations.get())).toEqual(["a", "b", "c"]);
        expect(getPendingEvents(SID)).toHaveLength(1);

        becomeSpectator(SID);

        expect(getPendingEvents(SID)).toEqual([]);
        expect(disabledStations.get()).toEqual(["a"]);
        await flushDisabledZonesSave(SID);
        expect(requests).toEqual([]);
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
            // What a load needs to read the details as a session.
            session = {
                id: "one",
                gameId: "game",
                gameRevisionId: "rev",
                name: "One",
                disabledZoneIds: [],
            };
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

        // The board first opened on this build without the server: it
        // shows the device's list, which a load adds to the session later.
        describe("after a zone of theirs was enabled without the server", () => {
            const stored = () => JSON.parse(store.get("disabledZones") ?? "{}");

            beforeEach(async () => {
                // The server applies each change it is sent.
                session.disabledZoneIds = [];
                const online = vi.mocked(fetch).getMockImplementation()!;
                vi.mocked(fetch).mockImplementation(async (url, options) => {
                    if (options?.method === "PATCH") {
                        session.disabledZoneIds = applyZonesDelta(
                            session.disabledZoneIds!,
                            changeOf(options),
                        );
                    }
                    return online(url, options);
                });
                store.set("disabledZones", JSON.stringify({ one: ["a", "b"] }));
                setDisabledZonesBase("one", legacyDisabledZones("one"));
                vi.mocked(fetch).mockImplementationOnce(async () => {
                    throw new TypeError("offline");
                });
                saveDisabledZonesDelta("one", delta([], ["a"]));
                await flushDisabledZonesSave("one").catch(() => {});
                expect(disabledStations.get()).toEqual(["b"]);
            });

            it("adds the rest, not the zone enabled since", async () => {
                expect(stored()).toEqual({ one: ["b"] });
                // A reload, still without the server, shows the same.
                setDisabledZonesBase("one", legacyDisabledZones("one"));
                expect(disabledStations.get()).toEqual(["b"]);

                // Back online, the load sends the enable, then adds the list.
                await flushPendingEvents("one");
                await loadSessionContent("one", "user");
                await flushPendingEvents("one");

                expect(session.disabledZoneIds).toEqual(["b"]);
                expect(patches).toMatchObject([delta([], ["a"]), delta(["b"])]);
                expect(store.has("disabledZones")).toBe(false);
            });

            it("adds nothing once every zone of theirs was enabled", async () => {
                saveDisabledZonesDelta("one", delta([], ["b"]));
                await flushDisabledZonesSave("one");
                expect(store.has("disabledZones")).toBe(false);

                await loadSessionContent("one", "user");
                await flushPendingEvents("one");

                expect(session.disabledZoneIds).toEqual([]);
            });

            it("still adds a zone enabled and disabled again before it was saved", async () => {
                vi.useFakeTimers();
                saveDisabledZonesDelta("one", delta([], ["b"]));
                saveDisabledZonesDelta("one", delta(["b"]));
                await vi.advanceTimersByTimeAsync(1000);
                expect(stored()).toEqual({ one: ["b"] });
            });
        });

        it("sends nothing when the session has them all", async () => {
            session.disabledZoneIds = ["a"];
            store.set("disabledZones", JSON.stringify({ one: ["a"] }));

            await loadSessionContent("one", "user");

            expect(getPendingEvents("one")).toEqual([]);
            expect(store.has("disabledZones")).toBe(false);
        });

        it("keeps a spectator's on the device, unsent", async () => {
            session.role = "viewer";
            store.set("disabledZones", JSON.stringify({ one: ["a"] }));

            await loadSessionContent("one", "user");

            expect(getPendingEvents("one")).toEqual([]);
            expect(patches).toEqual([]);
            expect(store.has("disabledZones")).toBe(true);
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
