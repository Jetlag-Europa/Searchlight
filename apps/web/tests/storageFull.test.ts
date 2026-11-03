// Browser storage too full to queue an edit: the player is told, with
// Retry, and the edit isn't lost meanwhile. From the 2026-11-03 release audit
// (sync-engine-opus S1, SYNC-07).
import type { EventRecord } from "@searchlight/shared";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// localStorage with a quota (in UTF-16 chars, like browsers count it).
const store = new Map<string, string>();
let capacity = Infinity;
const used = () => {
    let n = 0;
    for (const [k, v] of store) n += k.length + v.length;
    return n;
};
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
        const before = store.get(k);
        const next =
            used() - (before ? k.length + before.length : 0) + k.length + v.length;
        if (next > capacity) throw new DOMException("quota", "QuotaExceededError");
        store.set(k, v);
    },
    removeItem: (k: string) => {
        store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
        return store.size;
    },
});
class MockEventSource {
    static CLOSED = 2;
    static last: MockEventSource | null = null;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    readyState = 1;
    close() {}
    constructor() {
        MockEventSource.last = this;
    }
}
vi.stubGlobal("EventSource", MockEventSource);
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { toast } from "react-toastify";

import { addStroke, strokes } from "@/annotations/hooks/useAnnotationStore";
import { clearStrokeTombstones } from "@/annotations/storage/serverStore";
import type { StrokeFeature } from "@/annotations/types";
import {
    activeSessionId,
    activeSessionRole,
    editingInOtherTab,
    verifiedUserId,
} from "@/lib/activeSession";
import { questions } from "@/lib/context";
import { getPendingEvents, setCachedSession } from "@/lib/eventQueue";
import {
    becomeSpectator,
    cancelPendingQuestionSave,
    hasScheduledQuestionSave,
    saveQuestionsDebounced,
} from "@/lib/sessionState";
import { startSSE, stopSSE } from "@/lib/sseManager";
import type { Questions } from "@/maps/schema";

const SID = "quota-session";
const STORAGE_FULL = "This device's storage is full, so your last change wasn't saved.";

// One custom-zone-like question with a large polygon.
function bigList(tag: string, chars: number): Questions {
    const coords = Array.from({ length: Math.ceil(chars / 40) }, (_, i) => [
        i / 7,
        i / 13,
    ]);
    return [
        { id: "matching", key: 0.5, data: { type: "custom-zone", tag, geo: coords } },
    ] as unknown as Questions;
}

// The toast's own close, as Retry calls it.
const closeToast = vi.fn();

// The Retry button of the toast shown, if it has one.
function retryButton(): (() => void) | undefined {
    const content = vi.mocked(toast.error).mock.lastCall?.[0];
    if (typeof content !== "function") return undefined;
    const find = (node: ReactNode): (() => void) | undefined => {
        if (!node || typeof node !== "object") return undefined;
        if (Array.isArray(node)) {
            for (const child of node) {
                const found = find(child);
                if (found) return found;
            }
            return undefined;
        }
        const { type, props } = node as ReactElement<{
            children?: ReactNode;
            onClick?: () => void;
        }>;
        if (type === "button" && props.children === "Retry") return props.onClick;
        return find(props.children);
    };
    return find(
        (content as (p: { closeToast: () => void }) => ReactNode)({ closeToast }),
    );
}

beforeEach(() => {
    store.clear();
    capacity = Infinity;
    closeToast.mockClear();
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    vi.useFakeTimers();
    vi.spyOn(toast, "error").mockImplementation(() => "toast");
    vi.spyOn(toast, "dismiss").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    verifiedUserId.set("me");
    activeSessionId.set(SID);
    strokes.set([]);
});
afterEach(() => {
    stopSSE();
    cancelPendingQuestionSave();
    clearStrokeTombstones();
    activeSessionId.set("");
    activeSessionRole.set(null);
    verifiedUserId.set(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("an edit the queue has no room for", () => {
    // The board's list is on the server at 5; there is room for one more
    // copy of it, but a queued list keeps its base too.
    function nearlyFull() {
        const onServer = bigList("server", 300_000);
        setCachedSession({
            sessionId: SID,
            userId: "me",
            strokes: [],
            questions: onServer,
            serverQuestions: { sequence: 5, questions: onServer },
            lastSyncedAt: 0,
            lastSequence: 5,
        });
        capacity = used() + 450_000;
    }

    test("is said, and kept on the board waiting, with no timer left behind", () => {
        nearlyFull();
        const edited = bigList("edited", 300_000);
        questions.set(edited);
        saveQuestionsDebounced(SID, edited);
        vi.advanceTimersByTime(600);

        expect(getPendingEvents(SID)).toHaveLength(0);
        expect(toast.error).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        // Still to be saved: another player's list doesn't replace it.
        expect(hasScheduledQuestionSave(SID)).toBe(true);
        startSSE(SID);
        const other: EventRecord = {
            id: "e6",
            sessionId: SID,
            userId: "other",
            sequence: 6,
            type: "questions.replace",
            payloadJson: {
                replacementId: "r-other",
                questions: [
                    { clientUuid: "c1", ordinal: 0, payloadJson: { id: "radius", key: 0.7, data: {} } },
                ],
            },
            clientUuid: "questions-replace-r-other",
            clientCreatedAt: new Date().toISOString(),
            serverReceivedAt: new Date().toISOString(),
        };
        MockEventSource.last!.onmessage!({ data: JSON.stringify(other) } as MessageEvent);
        expect(questions.get()).toBe(edited);
    });

    test("is queued by Retry once there's room, made from what the board was made from", () => {
        nearlyFull();
        const edited = bigList("edited", 300_000);
        questions.set(edited);
        saveQuestionsDebounced(SID, edited);
        vi.advanceTimersByTime(600);
        const retry = retryButton();
        expect(retry).toBeTypeOf("function");

        // Still full: the toast stays, and so does the edit.
        retry!();
        expect(closeToast).not.toHaveBeenCalled();
        expect(getPendingEvents(SID)).toHaveLength(0);
        expect(hasScheduledQuestionSave(SID)).toBe(true);

        capacity = Infinity;
        retry!();
        expect(closeToast).toHaveBeenCalledOnce();
        const queued = getPendingEvents(SID);
        expect(queued).toHaveLength(1);
        expect(queued[0].payloadJson).toMatchObject({ base: { sequence: 5 } });
        expect(hasScheduledQuestionSave(SID)).toBe(false);
    });

    test("stays up until Retry: no close button, no swipe", () => {
        nearlyFull();
        saveQuestionsDebounced(SID, bigList("edited", 300_000));
        vi.advanceTimersByTime(600);
        expect(vi.mocked(toast.error).mock.lastCall?.[1]).toMatchObject({
            autoClose: false,
            closeButton: false,
            closeOnClick: false,
            draggable: false,
        });
    });

    test("Retry acts for the session shown, whichever session the toast was shown for", () => {
        nearlyFull();
        saveQuestionsDebounced(SID, bigList("edited", 300_000));
        vi.advanceTimersByTime(600);
        // The toast stays as it was shown (react-toastify keeps one per id).
        const retry = retryButton()!;
        // To another session, whose edit doesn't fit either (the switch
        // dropped this one's).
        cancelPendingQuestionSave();
        const other = "other-session";
        setCachedSession({
            sessionId: other,
            userId: "me",
            strokes: [],
            questions: [],
            serverQuestions: { sequence: 1, questions: [] },
            lastSyncedAt: 0,
            lastSequence: 1,
        });
        activeSessionId.set(other);
        // Nothing fits now, even once other copies are dropped.
        capacity = 0;
        saveQuestionsDebounced(other, bigList("other", 1_000));
        vi.advanceTimersByTime(600);
        retry();
        expect(closeToast).not.toHaveBeenCalled();
        expect(hasScheduledQuestionSave(other)).toBe(true);
        capacity = Infinity;
        retry();
        expect(closeToast).toHaveBeenCalledOnce();
        expect(getPendingEvents(other)).toHaveLength(1);
    });

    test("Retry closes once no edit waits: a demotion dropped it", () => {
        nearlyFull();
        saveQuestionsDebounced(SID, bigList("edited", 300_000));
        vi.advanceTimersByTime(600);
        becomeSpectator(SID);
        retryButton()!();
        expect(closeToast).toHaveBeenCalledOnce();
    });

    test("waits on Retry in a tab another one took the session over from", () => {
        nearlyFull();
        const edited = bigList("edited", 300_000);
        questions.set(edited);
        saveQuestionsDebounced(SID, edited);
        vi.advanceTimersByTime(600);
        editingInOtherTab.set(true);
        capacity = Infinity;
        retryButton()!();
        // Not taken as saved: nothing was queued.
        expect(closeToast).not.toHaveBeenCalled();
        expect(getPendingEvents(SID)).toHaveLength(0);
        expect(hasScheduledQuestionSave(SID)).toBe(true);
        editingInOtherTab.set(false);
    });

    test("is replaced by the next edit, which is queued once there's room", () => {
        nearlyFull();
        saveQuestionsDebounced(SID, bigList("edited", 300_000));
        vi.advanceTimersByTime(600);
        capacity = Infinity;
        const next = bigList("next", 1_000);
        saveQuestionsDebounced(SID, next);
        vi.advanceTimersByTime(600);
        const queued = getPendingEvents(SID);
        expect(queued).toHaveLength(1);
        expect(
            (queued[0].payloadJson as { questions: Array<{ payloadJson: unknown }> })
                .questions[0].payloadJson,
        ).toEqual(next[0]);
    });
});

test("a drawing the queue has no room for is said", async () => {
    capacity = used();
    const stroke = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        properties: { tool: "pen", color: "#000000", widthMeters: 3, createdAt: 0, clientUuid: "s1" },
    } as unknown as StrokeFeature;
    addStroke(stroke);
    await vi.advanceTimersByTimeAsync(0);
    expect(getPendingEvents(SID)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(STORAGE_FULL, expect.anything());
});
