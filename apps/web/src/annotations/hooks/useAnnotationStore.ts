import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import {
    loadStrokes,
    saveStrokesDebounced,
} from "@/annotations/storage/localStorage";
import type {
    AnnotationTool,
    StrokeFeature,
    StrokeWidthPreset,
} from "@/annotations/types";
import { PEN_COLORS } from "@/annotations/types";

export const tool = persistentAtom<AnnotationTool>("annot-tool", "pen");

export const color = persistentAtom<string>("annot-color", PEN_COLORS[0]);

export const widthPreset = persistentAtom<StrokeWidthPreset>(
    "annot-width",
    "thin",
);

export const drawingEnabled = persistentAtom<boolean>(
    "annot-drawing-enabled",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

export const detectPencilOnly = persistentAtom<boolean>(
    "annot-detect-pencil",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

export const penToolbarVisible = persistentAtom<boolean>(
    "annot-toolbar-visible",
    true,
    { encode: JSON.stringify, decode: JSON.parse },
);

export const strokes = atom<StrokeFeature[]>(loadStrokes());

strokes.listen((value) => {
    saveStrokesDebounced(value);
});

export function addStroke(s: StrokeFeature): void {
    strokes.set([...strokes.get(), s]);
}

export function removeStrokes(predicate: (s: StrokeFeature) => boolean): void {
    const next = strokes.get().filter((s) => !predicate(s));
    if (next.length !== strokes.get().length) {
        strokes.set(next);
    }
}

export function clearAllStrokes(): void {
    strokes.set([]);
}
