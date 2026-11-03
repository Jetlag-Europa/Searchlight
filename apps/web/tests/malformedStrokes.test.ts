import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { loadStrokesFromServer } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    applyPendingEventsToState,
    applyUnsyncedEvents,
    CACHE_PREFIX,
    enqueueEvent,
    getCachedSession,
    type PendingEvent,
} from "@/lib/eventQueue";

const SID = "malformed-session";

function stroke(clientUuid: string): StrokeFeature {
    return {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: [
                [8.54, 47.37],
                [8.55, 47.38],
            ],
        },
        properties: {
            tool: "pen",
            color: "#000000",
            widthMeters: 3,
            createdAt: 0,
            clientUuid,
        },
    };
}

// The server keeps any payload it was sent.
const MALFORMED = [
    null,
    3,
    "x",
    {},
    { properties: null },
    { properties: 1 },
    { properties: {} },
    { properties: {}, geometry: null },
    { properties: {}, geometry: { coordinates: null } },
    { properties: {}, geometry: { coordinates: [[8.54]] } },
    { properties: {}, geometry: { coordinates: [["8.54", 47.37]] } },
    { properties: {}, geometry: { coordinates: [null] } },
];

function created(payloadJson: unknown): PendingEvent {
    return {
        localId: `local-${Math.random()}`,
        sessionId: SID,
        type: "stroke.create",
        payloadJson,
        clientUuid: `stroke-create-${Math.random()}`,
        clientCreatedAt: 1,
        status: "pending",
    } as PendingEvent;
}

beforeEach(() => {
    store.clear();
    mockFetch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("malformed strokes", () => {
    test("loading the strokes skips the malformed ones", async () => {
        mockFetch.mockResolvedValue(
            Response.json({
                strokes: [
                    { clientUuid: "a", payloadJson: stroke("a") },
                    ...MALFORMED.map((payloadJson, i) => ({
                        clientUuid: `bad-${i}`,
                        payloadJson,
                    })),
                    null,
                    { clientUuid: "b", payloadJson: stroke("b") },
                ],
            }),
        );
        expect(await loadStrokesFromServer(SID)).toEqual([
            stroke("a"),
            stroke("b"),
        ]);
        expect(console.warn).toHaveBeenCalledTimes(MALFORMED.length + 1);
    });

    // The strokes replayed onto were read through isStrokeLike already.
    test("replaying edits skips malformed queued strokes", () => {
        const base = { strokes: [stroke("a")], questions: [] };
        const events = [
            ...MALFORMED.map(created),
            created(stroke("b")),
            {
                ...created(null),
                type: "stroke.delete",
                payloadJson: { clientUuid: "a" },
            } as PendingEvent,
            { ...created(null), type: "stroke.delete", payloadJson: null },
            {
                ...created(null),
                type: "stroke.delete",
                payloadJson: { clientUuid: 3 },
            },
        ] as PendingEvent[];
        expect(applyPendingEventsToState(base, events).strokes).toEqual([
            stroke("b"),
        ]);
    });

    test("a malformed stroke kept here doesn't stop the board showing", () => {
        store.set(
            `${CACHE_PREFIX}${SID}`,
            JSON.stringify({
                sessionId: SID,
                strokes: [stroke("a"), ...MALFORMED],
                questions: [],
            }),
        );
        const cached = getCachedSession(SID);
        expect(cached?.strokes).toEqual([stroke("a")]);
        enqueueEvent({
            sessionId: SID,
            type: "stroke.create",
            payloadJson: stroke("b"),
            clientUuid: "stroke-create-b",
            clientCreatedAt: 1,
        });
        expect(applyUnsyncedEvents(SID, cached!).strokes).toEqual([
            stroke("a"),
            stroke("b"),
        ]);
    });
});
