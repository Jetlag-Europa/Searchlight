// Pointer Events button codes for a pen. The eraser (the flipped end, or an
// eraser button on pens like the Lenovo Pen Pro or Surface Pen) reports
// button 5 / buttons bit 32; the barrel (side) button reports button 2 /
// buttons bit 2. `button` names the button that changed on this event and
// `buttons` the ones held, so check both: pressing the button while the pen
// already touches the screen shows up only in `buttons`.
const ERASER_BUTTON = 5;
const ERASER_BUTTONS_BIT = 32;
const BARREL_BUTTON = 2;
const BARREL_BUTTONS_BIT = 2;

type ButtonState = Pick<PointerEvent, "pointerType" | "button" | "buttons">;

// A pen held as an eraser: its eraser end or eraser button, or the barrel
// button, which erases too as it does in most drawing apps.
export function isPenEraser(e: ButtonState): boolean {
    if (e.pointerType !== "pen") return false;
    return (
        e.button === ERASER_BUTTON ||
        e.button === BARREL_BUTTON ||
        (e.buttons & (ERASER_BUTTONS_BIT | BARREL_BUTTONS_BIT)) !== 0
    );
}

// A mouse button other than the left one. Those open the map's context menu
// rather than draw.
export function isSecondaryMouseButton(e: ButtonState): boolean {
    return e.pointerType === "mouse" && e.button !== 0;
}
