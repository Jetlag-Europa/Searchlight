import { describe, expect, test, vi } from "vitest";
import { broadcast, subscribe, registerUserStream, closeUserStreams, closeSessionStreams, closeAllStreams } from "./broadcaster.js";
import type { EventRecord } from "@searchlight/shared";

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
    return {
        id: "ev-1",
        sessionId: "sess-1",
        userId: "user-1",
        sequence: 1,
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

describe("registerUserStream / closeUserStreams / closeSessionStreams", () => {
    test("closeUserStreams calls close callback for matching session and user", () => {
        const closeFn1 = vi.fn();
        const closeFn2 = vi.fn();
        const closeFnOtherUser = vi.fn();

        registerUserStream("sess-1", "user-1", closeFn1);
        registerUserStream("sess-1", "user-1", closeFn2);
        registerUserStream("sess-1", "user-2", closeFnOtherUser);

        closeUserStreams("sess-1", "user-1");

        expect(closeFn1).toHaveBeenCalledOnce();
        expect(closeFn2).toHaveBeenCalledOnce();
        expect(closeFnOtherUser).not.toHaveBeenCalled();
    });

    test("unregistered stream callback is not called on closeUserStreams", () => {
        const closeFn = vi.fn();
        const unregister = registerUserStream("sess-unreg", "user-1", closeFn);
        unregister();

        closeUserStreams("sess-unreg", "user-1");
        expect(closeFn).not.toHaveBeenCalled();
    });

    test("closeSessionStreams closes all streams for that session", () => {
        const closeFn1 = vi.fn();
        const closeFn2 = vi.fn();
        registerUserStream("sess-all", "user-1", closeFn1);
        registerUserStream("sess-all", "user-2", closeFn2);

        closeSessionStreams("sess-all");
        expect(closeFn1).toHaveBeenCalledOnce();
        expect(closeFn2).toHaveBeenCalledOnce();
    });
});

// Last in the file: closeAllStreams marks the process as shutting down for good.
describe("closeAllStreams", () => {
    test("closes every stream of every session, once", () => {
        const closeFn1 = vi.fn();
        const closeFn2 = vi.fn();
        const closeFn3 = vi.fn();
        registerUserStream("sess-shutdown-a", "user-1", closeFn1);
        registerUserStream("sess-shutdown-a", "user-2", closeFn2);
        registerUserStream("sess-shutdown-b", "user-1", closeFn3);

        closeAllStreams();
        closeAllStreams();
        expect(closeFn1).toHaveBeenCalledOnce();
        expect(closeFn2).toHaveBeenCalledOnce();
        expect(closeFn3).toHaveBeenCalledOnce();
    });

    test("closes a stream registered after it ran right away", () => {
        const closeFn = vi.fn();
        const unregister = registerUserStream("sess-shutdown-late", "user-1", closeFn);
        expect(closeFn).toHaveBeenCalledOnce();
        expect(() => unregister()).not.toThrow();
        closeUserStreams("sess-shutdown-late", "user-1");
        expect(closeFn).toHaveBeenCalledOnce();
    });
});
