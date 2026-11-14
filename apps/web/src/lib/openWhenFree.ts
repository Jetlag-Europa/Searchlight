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
 * Whether `focused` takes typed text: a text field, a textarea or anything
 * contenteditable. On a phone its keyboard is up.
 */
export function isTypingIn(focused: Element | null): boolean {
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

// While a request waits on a field, how often to look again whether it is
// still focused. Safari and Firefox fire no focusout for a focused field
// taken off the page.
const RECHECK_MS = 1_000;
// A press held longer than this has lost its pointerup and pointercancel (a
// touch has no buttonless move to end it), so it no longer holds a window.
const PRESS_LOST_MS = 30_000;

/**
 * Opens a window that wasn't asked for only once the player is free to look
 * at it: with the page in view, and not while they type. Taking focus from
 * a field would close a phone's keyboard mid-word. A request made meanwhile
 * opens it when the page comes back into view, or when focus leaves the
 * field for something that isn't another one. If a press (a mouse button or
 * a pen) moved it there, the window waits for the press to end and its
 * click to land: opened in between, it would take the click instead.
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
    let recheck: ReturnType<typeof setInterval> | undefined;
    // Pointers pressed on the page now, with when they went down.
    const pressed = new Map<number, number>();
    const stopWaiting = () => {
        waiting = false;
        clearTimeout(timer);
        clearInterval(recheck);
        recheck = undefined;
    };
    const openIfFree = () => {
        if (!waiting) return;
        if (doc.visibilityState !== "visible") return;
        if (isTypingIn(doc.activeElement)) return;
        for (const [pointerId, since] of pressed) {
            if (Date.now() - since > PRESS_LOST_MS) pressed.delete(pointerId);
        }
        if (pressed.size > 0) return;
        stopWaiting();
        open();
    };
    // Focus moves on after focusout, and a click comes after pointerup:
    // wait for them.
    const onVisibilityChange = () => {
        // Hidden, the page may miss a press ending.
        if (doc.visibilityState !== "visible") pressed.clear();
        openIfFree();
    };
    const openSoon = () => {
        if (!waiting) return;
        clearTimeout(timer);
        timer = setTimeout(openIfFree, 0);
    };
    const onPointerDown = (event: Event) => {
        pressed.set((event as PointerEvent).pointerId, Date.now());
    };
    const onPointerUp = (event: Event) => {
        pressed.delete((event as PointerEvent).pointerId);
        openSoon();
    };
    // A pointerup missed (released outside the window, say): a move with
    // no button down ends the press too.
    const onPointerMove = (event: Event) => {
        const { buttons, pointerId } = event as PointerEvent;
        if (buttons === 0 && pressed.delete(pointerId)) openSoon();
    };
    // In the capture phase: the map stops some pointer events on their way up.
    const listeners: [string, (event: Event) => void, boolean][] = [
        ["visibilitychange", onVisibilityChange, false],
        ["focusout", openSoon, false],
        ["keyup", openSoon, false],
        ["pointerdown", onPointerDown, true],
        ["pointerup", onPointerUp, true],
        ["pointercancel", onPointerUp, true],
        ["pointermove", onPointerMove, true],
    ];
    for (const [type, listener, capture] of listeners)
        doc.addEventListener(type, listener, capture);
    return {
        request() {
            waiting = true;
            openIfFree();
            if (waiting && recheck === undefined)
                recheck = setInterval(openIfFree, RECHECK_MS);
        },
        cancel: stopWaiting,
        stop() {
            stopWaiting();
            for (const [type, listener, capture] of listeners)
                doc.removeEventListener(type, listener, capture);
        },
    };
}
