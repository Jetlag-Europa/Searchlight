import type { Feature, LineString } from "geojson";

export type AnnotationTool = "pen" | "eraser" | "crossout";

export type StrokeWidthPreset = "thin" | "thick";

export interface StrokeProperties {
    tool: "pen" | "crossout";
    color: string;
    widthMeters: number;
    createdAt: number;
    clientUuid: string;
}

export type StrokeFeature = Feature<LineString, StrokeProperties>;

/**
 * Whether a stroke from the server or this browser's copy has what drawing
 * and erasing it read: its properties, and its points as [lng, lat]. The
 * server keeps whatever it was sent.
 */
export function isStrokeLike(value: unknown): value is StrokeFeature {
    if (typeof value !== "object" || value === null) return false;
    const { properties, geometry } = value as {
        properties?: unknown;
        geometry?: { coordinates?: unknown } | null;
    };
    const points = geometry?.coordinates;
    return (
        typeof properties === "object" &&
        properties !== null &&
        Array.isArray(points) &&
        points.every(
            (point) =>
                Array.isArray(point) &&
                typeof point[0] === "number" &&
                typeof point[1] === "number",
        )
    );
}

export const PEN_COLORS: readonly string[] = [
    "#000000",
    "#ef4444",
    "#3b82f6",
    "#22c55e",
];

// Pixel widths converted to meters at draw time using current zoom + lat.
export const WIDTH_PIXELS: Record<StrokeWidthPreset, number> = {
    thin: 3,
    thick: 8,
};

export const CROSSOUT_COLOR = "#ef4444";
export const CROSSOUT_WIDTH_PIXELS = 12;

export const ERASER_RADIUS_PIXELS = 10;
