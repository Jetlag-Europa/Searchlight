import type { FeatureCollection } from "geojson";

import type { StrokeFeature } from "@/annotations/types";

const STORAGE_KEY = "jetlag-annotations-v1";
const STORAGE_VERSION = 1;

interface PersistedShape {
    version: number;
    strokes: FeatureCollection;
}

export function loadStrokes(): StrokeFeature[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as PersistedShape;
        if (parsed?.version !== STORAGE_VERSION) return [];
        const features = parsed?.strokes?.features;
        if (!Array.isArray(features)) return [];
        return features as StrokeFeature[];
    } catch (e) {
        console.warn("[annotations] failed to load:", e);
        return [];
    }
}

function writeStrokes(strokes: StrokeFeature[]): void {
    try {
        const fc: FeatureCollection = {
            type: "FeatureCollection",
            features: strokes,
        };
        const payload: PersistedShape = {
            version: STORAGE_VERSION,
            strokes: fc,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
        console.warn(
            "[annotations] failed to save (storage full or unavailable):",
            e,
        );
    }
}

let timer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300;

export function saveStrokesDebounced(strokes: StrokeFeature[]): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        writeStrokes(strokes);
    }, DEBOUNCE_MS);
}

export function flushStrokes(strokes: StrokeFeature[]): void {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    writeStrokes(strokes);
}
