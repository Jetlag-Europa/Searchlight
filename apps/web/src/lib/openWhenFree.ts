// Inputs that take no typed text, so no keyboard comes up for them.
const UNTYPED_INPUTS = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
]);

/**
 * Whether `element`, the focused one, takes typed text: a text field, a
 * textarea or anything contenteditable, looking into open shadow roots
 * (ArcGIS's search box). On a phone its keyboard is up.
 */
export function isTypingIn(element: Element | null): boolean {
    let focused = element;
    while (focused?.shadowRoot?.activeElement)
        focused = focused.shadowRoot.activeElement;
    if (!focused) return false;
    if ((focused as HTMLElement).isContentEditable) return true;
    const field = focused as HTMLInputElement | HTMLTextAreaElement;
    if (field.readOnly || field.disabled) return false;
    if (focused.tagName === "TEXTAREA") return true;
    return (
        focused.tagName === "INPUT" &&
        !UNTYPED_INPUTS.has((field as HTMLInputElement).type)
    );
}

export interface OpenWhenFree {
    /** Open now if the player is free, or else as soon as they are. */
    request(): void;
    /** Don't open for an earlier request after all. */
    cancel(): void;
    /** Stop listening. */
    stop(): void;
}

/**
 * Opens a window that wasn't asked for only once the player is free to look
 * at it: with the page in view, and not while they type. Taking focus from
 * a field would close a phone's keyboard mid-word. A request made meanwhile
 * opens it when the page comes back into view, or when focus leaves the
 * field for something that isn't another one.
 */
export function openWhenFree(
    doc: Pick<
        Document,
        | "visibilityState"
        | "activeElement"
        | "addEventListener"
        | "removeEventListener"
    >,
    open: () => void,
): OpenWhenFree {
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const openIfFree = () => {
        if (!waiting) return;
        if (doc.visibilityState !== "visible") return;
        if (isTypingIn(doc.activeElement)) return;
        waiting = false;
        open();
    };
    // Focus moves on after focusout: wait for where it lands.
    const onFocusOut = () => {
        clearTimeout(timer);
        timer = setTimeout(openIfFree, 0);
    };
    doc.addEventListener("visibilitychange", openIfFree);
    doc.addEventListener("focusout", onFocusOut);
    return {
        request() {
            waiting = true;
            openIfFree();
        },
        cancel() {
            waiting = false;
        },
        stop() {
            waiting = false;
            clearTimeout(timer);
            doc.removeEventListener("visibilitychange", openIfFree);
            doc.removeEventListener("focusout", onFocusOut);
        },
    };
}
