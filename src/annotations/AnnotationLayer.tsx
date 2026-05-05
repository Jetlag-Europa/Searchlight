import { useStore } from "@nanostores/react";
import * as L from "leaflet";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
    addStroke,
    allowFingerDrawing,
    color as colorStore,
    drawingEnabled,
    removeStrokes,
    strokes as strokesStore,
    tool as toolStore,
    widthPreset as widthPresetStore,
} from "@/annotations/hooks/useAnnotationStore";
import { usePointerCapture } from "@/annotations/hooks/usePointerCapture";
import { SvgStrokeRenderer } from "@/annotations/render/SvgStrokeRenderer";
import {
    CROSSOUT_COLOR,
    CROSSOUT_WIDTH_PIXELS,
    ERASER_RADIUS_PIXELS,
    type StrokeFeature,
    WIDTH_PIXELS,
} from "@/annotations/types";
import { strokeIntersectsErasePoint } from "@/annotations/utils/eraserHit";
import { pixelsToMeters } from "@/annotations/utils/geoMath";

interface ActiveStrokeState {
    points: L.LatLng[];
    color: string;
    widthMeters: number;
    tool: "pen" | "crossout";
    createdAt: number;
}

const ANNOT_STYLE_ID = "annot-style-tag";

function ensureStyleTag() {
    if (typeof document === "undefined") return;
    if (document.getElementById(ANNOT_STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = ANNOT_STYLE_ID;
    tag.textContent = `
.annot-drawing-active, .annot-drawing-active * { touch-action: none !important; }
.annot-drawing-active .leaflet-marker-icon,
.annot-drawing-active .leaflet-marker-shadow { pointer-events: none !important; }
`;
    document.head.appendChild(tag);
}

export function AnnotationLayer({ map }: { map: L.Map | null }) {
    const $tool = useStore(toolStore);
    const $color = useStore(colorStore);
    const $widthPreset = useStore(widthPresetStore);
    const $drawingEnabled = useStore(drawingEnabled);
    const $allowFinger = useStore(allowFingerDrawing);
    const $strokes = useStore(strokesStore);

    const [active, setActive] = useState<ActiveStrokeState | null>(null);
    const activeRef = useRef<ActiveStrokeState | null>(null);
    activeRef.current = active;

    ensureStyleTag();

    const shouldCapture = useCallback(
        (e: PointerEvent): boolean => {
            if (!map) return false;
            if (!$drawingEnabled) return false;
            if (e.pointerType === "touch" && !$allowFinger) return false;
            // Don't fight Leaflet over its own UI controls.
            const target = e.target as Element | null;
            if (target?.closest(".leaflet-control")) return false;
            return true;
        },
        [map, $drawingEnabled, $allowFinger],
    );

    const onStart = useCallback(
        (_e: PointerEvent, latlng: L.LatLng) => {
            if (!map) return;
            if ($tool === "eraser") {
                const rect = map.getContainer().getBoundingClientRect();
                const px = {
                    x: _e.clientX - rect.left,
                    y: _e.clientY - rect.top,
                };
                removeStrokes((s) =>
                    strokeIntersectsErasePoint(
                        s,
                        map,
                        px,
                        ERASER_RADIUS_PIXELS,
                    ),
                );
                // Eraser keeps an "active" sentinel so onMove knows to keep erasing.
                setActive({
                    points: [latlng],
                    color: "transparent",
                    widthMeters: 0,
                    tool: "pen",
                    createdAt: Date.now(),
                });
                return;
            }

            const isCrossout = $tool === "crossout";
            const widthPx = isCrossout
                ? CROSSOUT_WIDTH_PIXELS
                : WIDTH_PIXELS[$widthPreset];
            const strokeColor = isCrossout ? CROSSOUT_COLOR : $color;
            const widthMeters = pixelsToMeters(map, widthPx, latlng.lat);

            setActive({
                points: [latlng],
                color: strokeColor,
                widthMeters,
                tool: isCrossout ? "crossout" : "pen",
                createdAt: Date.now(),
            });
        },
        [map, $tool, $color, $widthPreset],
    );

    const onMove = useCallback(
        (events: PointerEvent[], latlngs: L.LatLng[]) => {
            if (!map) return;
            const cur = activeRef.current;
            if (!cur) return;

            if ($tool === "eraser") {
                const rect = map.getContainer().getBoundingClientRect();
                for (const e of events) {
                    const px = {
                        x: e.clientX - rect.left,
                        y: e.clientY - rect.top,
                    };
                    removeStrokes((s) =>
                        strokeIntersectsErasePoint(
                            s,
                            map,
                            px,
                            ERASER_RADIUS_PIXELS,
                        ),
                    );
                }
                return;
            }

            const next: ActiveStrokeState = {
                ...cur,
                points: cur.points.concat(latlngs),
            };
            activeRef.current = next;
            setActive(next);
        },
        [map, $tool],
    );

    const onEnd = useCallback(() => {
        const cur = activeRef.current;
        activeRef.current = null;
        setActive(null);
        if (!cur) return;
        if ($tool === "eraser") return;
        if (cur.points.length < 1) return;

        const feature: StrokeFeature = {
            type: "Feature",
            geometry: {
                type: "LineString",
                coordinates: cur.points.map((ll) => [ll.lng, ll.lat]),
            },
            properties: {
                tool: cur.tool,
                color: cur.color,
                widthMeters: cur.widthMeters,
                createdAt: cur.createdAt,
            },
        };
        addStroke(feature);
    }, [$tool]);

    const callbacks = useMemo(
        () => ({ shouldCapture, onStart, onMove, onEnd }),
        [shouldCapture, onStart, onMove, onEnd],
    );

    usePointerCapture(map, callbacks);

    if (!map) return null;

    const renderActive =
        active && $tool !== "eraser" && active.color !== "transparent"
            ? {
                  points: active.points,
                  color: active.color,
                  widthMeters: active.widthMeters,
                  tool: active.tool,
              }
            : null;

    return createPortal(
        <SvgStrokeRenderer
            map={map}
            strokes={$strokes}
            active={renderActive}
        />,
        map.getContainer(),
    );
}
