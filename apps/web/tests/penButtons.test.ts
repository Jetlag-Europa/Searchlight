import { describe, expect, it } from "vitest";

import {
    isPenBarrel,
    isPenEraser,
    isSecondaryMouseButton,
} from "../src/annotations/utils/penButtons";

const pen = (button: number, buttons: number) => ({
    pointerType: "pen",
    button,
    buttons,
});

describe("pen eraser detection", () => {
    it("draws with a plain pen tip", () => {
        expect(isPenEraser(pen(0, 1))).toBe(false);
    });

    it("erases with the eraser end or eraser button", () => {
        expect(isPenEraser(pen(5, 32))).toBe(true);
        // Pressed while the tip already touches: a pointermove with only
        // `buttons` changed.
        expect(isPenEraser(pen(-1, 33))).toBe(true);
        expect(isPenBarrel(pen(5, 32))).toBe(false);
    });

    it("erases with the barrel button", () => {
        expect(isPenEraser(pen(2, 2))).toBe(true);
        expect(isPenEraser(pen(0, 3))).toBe(true);
        expect(isPenEraser(pen(-1, 3))).toBe(true);
        expect(isPenBarrel(pen(-1, 3))).toBe(true);
    });

    it("erases with a second barrel button reported as the middle one", () => {
        expect(isPenEraser(pen(1, 4))).toBe(true);
        expect(isPenEraser(pen(-1, 5))).toBe(true);
    });

    it("stops erasing once the button is released mid-stroke", () => {
        expect(isPenEraser(pen(-1, 1))).toBe(false);
    });

    it("ignores the same buttons on a mouse or finger", () => {
        expect(
            isPenEraser({ pointerType: "mouse", button: 2, buttons: 2 }),
        ).toBe(false);
        expect(
            isPenEraser({ pointerType: "touch", button: 0, buttons: 32 }),
        ).toBe(false);
        expect(
            isPenBarrel({ pointerType: "mouse", button: 2, buttons: 2 }),
        ).toBe(false);
    });
});

describe("secondary mouse buttons", () => {
    it("leaves the left button and other pointers drawing", () => {
        expect(
            isSecondaryMouseButton({
                pointerType: "mouse",
                button: 0,
                buttons: 1,
            }),
        ).toBe(false);
        expect(isSecondaryMouseButton(pen(2, 2))).toBe(false);
    });

    it("catches right and middle clicks", () => {
        expect(
            isSecondaryMouseButton({
                pointerType: "mouse",
                button: 2,
                buttons: 2,
            }),
        ).toBe(true);
        expect(
            isSecondaryMouseButton({
                pointerType: "mouse",
                button: 1,
                buttons: 4,
            }),
        ).toBe(true);
    });
});
