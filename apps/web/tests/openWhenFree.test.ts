import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { isTypingIn, openWhenFree } from "@/lib/openWhenFree";

// Just what isTypingIn reads of an element.
const el = (props: Record<string, unknown>) => props as unknown as Element;
const textField = el({ tagName: "INPUT", type: "text" });
const otherField = el({ tagName: "TEXTAREA" });
const button = el({ tagName: "BUTTON" });

// A page: what's focused, whether it's in view, and its events.
class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
    activeElement: Element | null = null;
    focus(element: Element | null) {
        if (this.activeElement) this.dispatchEvent(new Event("focusout"));
        this.activeElement = element;
    }
    show(state: DocumentVisibilityState) {
        this.visibilityState = state;
        this.dispatchEvent(new Event("visibilitychange"));
    }
    pointer(type: string, pointerId = 1, buttons = 0) {
        this.dispatchEvent(
            Object.assign(new Event(type), { pointerId, buttons }),
        );
    }
    // A mouse click on `element`: the press moves focus, the click comes
    // after the release, in the same task.
    press(element: Element | null) {
        this.pointer("pointerdown", 1, 1);
        this.focus(element);
    }
    release(onClick: () => void) {
        this.pointer("pointerup");
        onClick();
    }
}

describe("isTypingIn", () => {
    test("text fields, textareas and contenteditable", () => {
        expect(isTypingIn(textField)).toBe(true);
        expect(isTypingIn(el({ tagName: "INPUT", type: "number" }))).toBe(true);
        expect(isTypingIn(el({ tagName: "INPUT", type: "search" }))).toBe(true);
        expect(isTypingIn(otherField)).toBe(true);
        expect(
            isTypingIn(el({ tagName: "DIV", isContentEditable: true })),
        ).toBe(true);
    });

    test("not buttons, checkboxes, or fields that can't be typed in", () => {
        expect(isTypingIn(null)).toBe(false);
        expect(isTypingIn(button)).toBe(false);
        expect(isTypingIn(el({ tagName: "INPUT", type: "checkbox" }))).toBe(
            false,
        );
        expect(isTypingIn(el({ tagName: "INPUT", type: "range" }))).toBe(false);
        expect(
            isTypingIn(el({ tagName: "INPUT", type: "text", readOnly: true })),
        ).toBe(false);
        expect(isTypingIn(el({ tagName: "TEXTAREA", disabled: true }))).toBe(
            false,
        );
    });

    test("looks into shadow roots", () => {
        const host = el({
            tagName: "ARCGIS-SEARCH",
            shadowRoot: { activeElement: textField },
        });
        expect(isTypingIn(host)).toBe(true);
        expect(
            isTypingIn(
                el({ tagName: "X", shadowRoot: { activeElement: button } }),
            ),
        ).toBe(false);
    });
});

describe("openWhenFree", () => {
    let doc: FakeDocument;
    let open: ReturnType<typeof vi.fn<() => void>>;
    let opener: ReturnType<typeof openWhenFree>;

    beforeEach(() => {
        vi.useFakeTimers();
        doc = new FakeDocument();
        open = vi.fn<() => void>();
        opener = openWhenFree(doc, open);
    });
    afterEach(() => {
        opener.stop();
        vi.useRealTimers();
    });

    test("opens at once when the page is in view and nothing is typed in", () => {
        doc.focus(button);
        opener.request();
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("waits while a field has focus, and opens once focus leaves it", () => {
        doc.focus(textField);
        opener.request();
        expect(open).not.toHaveBeenCalled();

        // Typing on, from field to field: still waits.
        doc.focus(otherField);
        vi.advanceTimersByTime(1);
        expect(open).not.toHaveBeenCalled();

        doc.focus(button);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
        // Only once per request.
        doc.focus(textField);
        doc.focus(null);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a hidden page opens it when it's back in view, unless typing", () => {
        doc.show("hidden");
        opener.request();
        expect(open).not.toHaveBeenCalled();

        doc.activeElement = textField;
        doc.show("visible");
        expect(open).not.toHaveBeenCalled();

        doc.focus(null);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("focus leaving the field while the page is hidden waits for the page", () => {
        doc.focus(textField);
        opener.request();
        doc.show("hidden");
        doc.focus(null);
        vi.advanceTimersByTime(1);
        expect(open).not.toHaveBeenCalled();
        doc.show("visible");
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a cancelled or stopped request doesn't open", () => {
        doc.focus(textField);
        opener.request();
        opener.cancel();
        doc.focus(null);
        vi.advanceTimersByTime(1);
        expect(open).not.toHaveBeenCalled();

        doc.focus(textField);
        opener.request();
        opener.stop();
        doc.focus(null);
        vi.advanceTimersByTime(1);
        doc.show("visible");
        expect(open).not.toHaveBeenCalled();
    });

    test("a press that takes focus from the field opens it after its click", () => {
        const clicked = vi.fn(() => {
            // The window would be over the button by now.
            expect(open).not.toHaveBeenCalled();
        });
        doc.focus(textField);
        opener.request();

        doc.press(button);
        // The player holds the button down for a while.
        vi.advanceTimersByTime(3_000);
        expect(open).not.toHaveBeenCalled();

        doc.release(clicked);
        expect(clicked).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a cancelled press, or one released off the page, ends too", () => {
        doc.focus(textField);
        opener.request();
        doc.press(null);
        doc.pointer("pointercancel");
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);

        doc.focus(textField);
        opener.request();
        doc.press(null);
        // Still held: moves with the button down don't end it.
        doc.pointer("pointermove", 1, 1);
        vi.advanceTimersByTime(1_000);
        expect(open).toHaveBeenCalledTimes(1);
        // Back over the page with the button up.
        doc.pointer("pointermove", 1, 0);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(2);
    });

    test("doesn't open mid-press even when nothing is typed in", () => {
        doc.pointer("pointerdown", 1, 1);
        opener.request();
        expect(open).not.toHaveBeenCalled();
        doc.pointer("pointerup");
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a focused field taken off the page, without a focusout", () => {
        doc.focus(textField);
        opener.request();
        // As Safari and Firefox do: focus is back on the page, silently.
        doc.activeElement = null;
        vi.advanceTimersByTime(999);
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a key let go after the field went opens it sooner", () => {
        doc.focus(textField);
        opener.request();
        doc.activeElement = null;
        doc.dispatchEvent(new Event("keyup"));
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("stops looking again once it opened or was cancelled", () => {
        doc.focus(textField);
        opener.request();
        opener.cancel();
        doc.activeElement = null;
        vi.advanceTimersByTime(5_000);
        expect(open).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        doc.focus(textField);
        opener.request();
        doc.focus(null);
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});
