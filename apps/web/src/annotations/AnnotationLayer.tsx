import { useStore } from "@nanostores/react";
import * as L from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
    addStroke,
    color as colorStore,
    detectPencilOnly,
    drawingEnabled,
    penEraserActive,
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
import {
    isPenBarrel,
    isPenEraser,
    isSecondaryMouseButton,
} from "@/annotations/utils/penButtons";
import { randomUUID } from "@/lib/utils";

interface ActiveStrokeState {
    points: L.LatLng[];
    color: string;
    widthMeters: number;
    tool: "pen" | "crossout";
    createdAt: number;
}

const ANNOT_STYLE_ID = "annot-style-tag";

// How long after a pen lifts to swallow a context menu, when its barrel
// button was held. Windows sends that button as a right-click on lift.
const PEN_CONTEXT_MENU_GRACE_MS = 1000;

function ensureStyleTag() {
    if (typeof document === "undefined") return;
    if (document.getElementById(ANNOT_STYLE_ID)) return;
    const tag = document.createElement("style");
    tag.id = ANNOT_STYLE_ID;
    // .annot-drawing-active is toggled mid-stroke (between pointerdown/up).
    // .annot-pen-mode is toggled whenever drawing is enabled — used to block
    // marker/overlay clicks so a tap doesn't toggle a hiding-zone station.
    tag.textContent = `
.annot-drawing-active, .annot-drawing-active * { touch-action: none !important; }
.annot-pen-mode .leaflet-marker-pane,
.annot-pen-mode .leaflet-overlay-pane,
.annot-pen-mode .leaflet-marker-icon,
.annot-pen-mode .leaflet-marker-shadow,
.annot-pen-mode .leaflet-clickable,
.annot-pen-mode .leaflet-interactive { pointer-events: none !important; }
`;
    document.head.appendChild(tag);
}

export function AnnotationLayer({ map }: { map: L.Map | null }) {
    const $tool = useStore(toolStore);
    const $color = useStore(colorStore);
    const $widthPreset = useStore(widthPresetStore);
    const $drawingEnabled = useStore(drawingEnabled);
    const $detectPencil = useStore(detectPencilOnly);
    const $strokes = useStore(strokesStore);

    const [active, setActive] = useState<ActiveStrokeState | null>(null);
    const activeRef = useRef<ActiveStrokeState | null>(null);
    activeRef.current = active;
    // Erasing: the eraser tool, or a pen's eraser or barrel button held,
    // whatever the tool.
    const erasingRef = useRef(false);
    // The pen's barrel button was held during this gesture, so Windows will
    // send a right-click when the pen lifts.
    const barrelUsedRef = useRef(false);
    const suppressContextMenuUntilRef = useRef(0);

    ensureStyleTag();

    // Toggle the pen-mode class on the map container so marker / overlay
    // clicks are suppressed while drawing is enabled.
    useEffect(() => {
        if (!map) return;
        const container = map.getContainer();
        if ($drawingEnabled) {
            container.classList.add("annot-pen-mode");
        } else {
            container.classList.remove("annot-pen-mode");
        }
        return () => {
            container.classList.remove("annot-pen-mode");
        };
    }, [map, $drawingEnabled]);

    // A pen's barrel button doubles as a right-click, which would open the
    // map's context menu over what was just erased.
    useEffect(() => {
        if (!map) return;
        const container = map.getContainer();
        const onContextMenu = (e: MouseEvent) => {
            // Browsers that send contextmenu as a PointerEvent say where it
            // came from; leave the mouse's and fingers' menus alone.
            const pointerType = (e as Partial<PointerEvent>).pointerType;
            if (pointerType && pointerType !== "pen") return;
            if (
                !barrelUsedRef.current &&
                Date.now() > suppressContextMenuUntilRef.current
            ) {
                return;
            }
            suppressContextMenuUntilRef.current = 0;
            e.preventDefault();
            // Capture listeners run first even on the container itself, so
            // this stops Leaflet's own listener there too.
            e.stopImmediatePropagation();
        };
        const opts: AddEventListenerOptions = { capture: true };
        container.addEventListener("contextmenu", onContextMenu, opts);
        return () => {
            container.removeEventListener("contextmenu", onContextMenu, opts);
            penEraserActive.set(false);
        };
    }, [map]);

    const shouldCapture = useCallback(
        (e: PointerEvent): boolean => {
            if (!map) return false;
            if (!$drawingEnabled) return false;
            if (e.pointerType === "touch" && $detectPencil) return false;
            if (isSecondaryMouseButton(e)) return false;
            // Don't fight Leaflet over its own UI controls.
            const target = e.target as Element | null;
            if (target?.closest(".leaflet-control")) return false;
            return true;
        },
        [map, $drawingEnabled, $detectPencil],
    );

    const eraseAt = useCallback(
        (events: PointerEvent[]) => {
            if (!map) return;
            const rect = map.getContainer().getBoundingClientRect();
            const pxs = events.map((e) => ({
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            }));
            removeStrokes((s) =>
                pxs.some((px) =>
                    strokeIntersectsErasePoint(
                        s,
                        map,
                        px,
                        ERASER_RADIUS_PIXELS,
                    ),
                ),
            );
        },
        [map],
    );

    // A gesture is a run of segments: pressing or releasing a pen's eraser
    // or barrel button mid-gesture ends one segment and starts the other.
    const beginSegment = useCallback(
        (e: PointerEvent, latlng: L.LatLng) => {
            if (!map) return;
            const penEraser = isPenEraser(e);
            if (isPenBarrel(e)) barrelUsedRef.current = true;
            erasingRef.current = $tool === "eraser" || penEraser;
            penEraserActive.set(penEraser);
            if (erasingRef.current) {
                eraseAt([e]);
                return;
            }

            const isCrossout = $tool === "crossout";
            const widthPx = isCrossout
                ? CROSSOUT_WIDTH_PIXELS
                : WIDTH_PIXELS[$widthPreset];
            const strokeColor = isCrossout ? CROSSOUT_COLOR : $color;
            const widthMeters = pixelsToMeters(map, widthPx, latlng.lat);

            const initial: ActiveStrokeState = {
                points: [latlng],
                color: strokeColor,
                widthMeters,
                tool: isCrossout ? "crossout" : "pen",
                createdAt: Date.now(),
            };
            activeRef.current = initial;
            setActive(initial);
        },
        [map, $tool, $color, $widthPreset, eraseAt],
    );

    const endSegment = useCallback(() => {
        if (erasingRef.current) {
            erasingRef.current = false;
            penEraserActive.set(false);
            return;
        }
        const cur = activeRef.current;
        activeRef.current = null;
        setActive(null);
        if (!cur) return;
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
                clientUuid: randomUUID(),
            },
        };
        addStroke(feature);
    }, []);

    const onStart = useCallback(
        (e: PointerEvent, latlng: L.LatLng) => {
            barrelUsedRef.current = false;
            beginSegment(e, latlng);
        },
        [beginSegment],
    );

    const onMove = useCallback(
        (events: PointerEvent[], latlngs: L.LatLng[]) => {
            if (!map) return;
            const last = events[events.length - 1];
            if (last && isPenBarrel(last)) barrelUsedRef.current = true;
            const erase = $tool === "eraser" || (!!last && isPenEraser(last));
            if (last && erase !== erasingRef.current) {
                endSegment();
                beginSegment(last, latlngs[latlngs.length - 1]);
                return;
            }
            if (erasingRef.current) {
                eraseAt(events);
                return;
            }
            const cur = activeRef.current;
            if (!cur) return;

            const next: ActiveStrokeState = {
                ...cur,
                points: cur.points.concat(latlngs),
            };
            activeRef.current = next;
            setActive(next);
        },
        [map, $tool, eraseAt, beginSegment, endSegment],
    );

    const onEnd = useCallback(() => {
        endSegment();
        if (barrelUsedRef.current) {
            barrelUsedRef.current = false;
            suppressContextMenuUntilRef.current =
                Date.now() + PEN_CONTEXT_MENU_GRACE_MS;
        }
    }, [endSegment]);

    usePointerCapture(map, { shouldCapture, onStart, onMove, onEnd });

    if (!map) return null;

    return createPortal(
        <SvgStrokeRenderer map={map} strokes={$strokes} active={active} />,
        map.getContainer(),
    );
}
