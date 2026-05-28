import { describe, expect, test, vi } from "vitest";
import { broadcast, subscribe } from "./broadcaster.js";
import type { EventRecord } from "@taibled/shared";

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
    return {
        id: "ev-1",
        sessionId: "sess-1",
        userId: "user-1",
        type: "stroke.create",
        payloadJson: {},
        clientUuid: "uuid-1",
        clientCreatedAt: "2025-01-01T00:00:00.000Z",
        serverReceivedAt: "2025-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("broadcast", () => {
    test("delivers event to a subscribed listener", () => {
        const listener = vi.fn();
        const ev = makeEvent({ sessionId: "s-deliver" });
        const unsub = subscribe("s-deliver", listener);
        broadcast("s-deliver", ev);
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(ev);
        unsub();
    });

    test("delivers to all listeners for the same session", () => {
        const l1 = vi.fn();
        const l2 = vi.fn();
        const ev = makeEvent({ sessionId: "s-multi" });
        const u1 = subscribe("s-multi", l1);
        const u2 = subscribe("s-multi", l2);
        broadcast("s-multi", ev);
        expect(l1).toHaveBeenCalledOnce();
        expect(l2).toHaveBeenCalledOnce();
        u1();
        u2();
    });

    test("does not deliver to listeners on a different session", () => {
        const listener = vi.fn();
        const unsub = subscribe("s-isolation-a", listener);
        broadcast("s-isolation-b", makeEvent({ sessionId: "s-isolation-b" }));
        expect(listener).not.toHaveBeenCalled();
        unsub();
    });

    test("is a no-op when no listeners are subscribed", () => {
        expect(() => broadcast("s-empty", makeEvent())).not.toThrow();
    });
});

describe("subscribe / unsubscribe", () => {
    test("unsubscribing stops delivery", () => {
        const listener = vi.fn();
        const unsub = subscribe("s-unsub", listener);
        unsub();
        broadcast("s-unsub", makeEvent({ sessionId: "s-unsub" }));
        expect(listener).not.toHaveBeenCalled();
    });

    test("unsubscribing one listener does not affect others on the same session", () => {
        const l1 = vi.fn();
        const l2 = vi.fn();
        const ev = makeEvent({ sessionId: "s-partial-unsub" });
        const u1 = subscribe("s-partial-unsub", l1);
        const u2 = subscribe("s-partial-unsub", l2);
        u1();
        broadcast("s-partial-unsub", ev);
        expect(l1).not.toHaveBeenCalled();
        expect(l2).toHaveBeenCalledOnce();
        u2();
    });

    test("re-subscribing after full unsubscribe works correctly", () => {
        const l1 = vi.fn();
        const l2 = vi.fn();
        const sess = "s-resubscribe";
        const u1 = subscribe(sess, l1);
        u1(); // fully removes session entry
        const u2 = subscribe(sess, l2);
        broadcast(sess, makeEvent({ sessionId: sess }));
        expect(l1).not.toHaveBeenCalled();
        expect(l2).toHaveBeenCalledOnce();
        u2();
    });
});
