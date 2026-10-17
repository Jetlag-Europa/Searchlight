import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import {
    deleteStrokeFromServer,
    saveStrokeToServer,
} from "@/annotations/storage/serverStore";
import type {
    AnnotationTool,
    StrokeFeature,
    StrokeWidthPreset,
} from "@/annotations/types";
import { PEN_COLORS } from "@/annotations/types";
import { activeSessionId } from "@/lib/activeSession";

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

// True while a pen's eraser or barrel button erases, so the toolbar can show
// the eraser as the tool in use without changing the chosen tool.
export const penEraserActive = atom(false);

// Strokes are populated by the SessionManager when a session is loaded.
// They are no longer backed by localStorage.
export const strokes = atom<StrokeFeature[]>([]);

export function addStroke(s: StrokeFeature): void {
    strokes.set([...strokes.get(), s]);

    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    saveStrokeToServer(sessionId, s).catch((err) => {
        console.warn("[annotations] failed to save stroke to server:", err);
    });
}

export function removeStrokes(predicate: (s: StrokeFeature) => boolean): void {
    const current = strokes.get();
    const removed = current.filter(predicate);
    const next = current.filter((s) => !predicate(s));
    if (next.length === current.length) return;

    strokes.set(next);

    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    for (const s of removed) {
        deleteStrokeFromServer(sessionId, s.properties.clientUuid).catch((err) => {
            console.warn("[annotations] failed to delete stroke from server:", err);
        });
    }
}

export function clearAllStrokes(): void {
    const current = strokes.get();
    strokes.set([]);

    const sessionId = activeSessionId.get();
    if (!sessionId) return;
    for (const s of current) {
        deleteStrokeFromServer(sessionId, s.properties.clientUuid).catch((err) => {
            console.warn("[annotations] failed to delete stroke from server:", err);
        });
    }
}
