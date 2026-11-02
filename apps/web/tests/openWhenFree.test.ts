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
        vi.runAllTimers();
        expect(open).not.toHaveBeenCalled();

        doc.focus(button);
        vi.runAllTimers();
        expect(open).toHaveBeenCalledTimes(1);
        // Only once per request.
        doc.focus(textField);
        doc.focus(null);
        vi.runAllTimers();
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
        vi.runAllTimers();
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("focus leaving the field while the page is hidden waits for the page", () => {
        doc.focus(textField);
        opener.request();
        doc.show("hidden");
        doc.focus(null);
        vi.runAllTimers();
        expect(open).not.toHaveBeenCalled();
        doc.show("visible");
        expect(open).toHaveBeenCalledTimes(1);
    });

    test("a cancelled or stopped request doesn't open", () => {
        doc.focus(textField);
        opener.request();
        opener.cancel();
        doc.focus(null);
        vi.runAllTimers();
        expect(open).not.toHaveBeenCalled();

        doc.focus(textField);
        opener.request();
        opener.stop();
        doc.focus(null);
        vi.runAllTimers();
        doc.show("visible");
        expect(open).not.toHaveBeenCalled();
    });
});
