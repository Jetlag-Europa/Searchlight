// Pointer Events button codes for a pen. The eraser (the flipped end, or an
// eraser button on pens like the Lenovo Pen Pro or Surface Pen) reports
// button 5 / buttons bit 32. Barrel (side) buttons report as the secondary
// button (button 2 / buttons bit 2) or, for a second barrel button as on
// Wacom pens, the middle one (button 1 / buttons bit 4). `button` names the
// button that changed on this event and `buttons` the ones held, so check
// both: pressing a button while the pen already touches the screen fires a
// pointermove that shows it only in `buttons`.
const ERASER_BUTTON = 5;
const ERASER_BUTTONS_BIT = 32;
const BARREL_BUTTONS = [2, 1];
const BARREL_BUTTONS_BITS = 2 | 4;

type ButtonState = Pick<PointerEvent, "pointerType" | "button" | "buttons">;

// A pen held with a barrel button pressed.
export function isPenBarrel(e: ButtonState): boolean {
    if (e.pointerType !== "pen") return false;
    return (
        BARREL_BUTTONS.includes(e.button) ||
        (e.buttons & BARREL_BUTTONS_BITS) !== 0
    );
}

// A pen held to erase: its eraser end or eraser button, or a barrel button,
// which erases too as it does in most drawing apps.
export function isPenErasing(e: ButtonState): boolean {
    if (e.pointerType !== "pen") return false;
    return (
        e.button === ERASER_BUTTON ||
        (e.buttons & ERASER_BUTTONS_BIT) !== 0 ||
        isPenBarrel(e)
    );
}

// A mouse button other than the left one. Those open the map's context menu
// rather than draw.
export function isSecondaryMouseButton(e: ButtonState): boolean {
    return e.pointerType === "mouse" && e.button !== 0;
}
