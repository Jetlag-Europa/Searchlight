import type { Feature, LineString } from "geojson";

export type AnnotationTool = "pen" | "eraser" | "crossout";

export type StrokeWidthPreset = "thin" | "thick";

export interface StrokeProperties {
    tool: "pen" | "crossout";
    color: string;
    widthMeters: number;
    createdAt: number;
}

export type StrokeFeature = Feature<LineString, StrokeProperties>;

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
