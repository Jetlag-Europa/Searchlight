import * as L from "leaflet";
import { useEffect, useRef } from "react";

interface CaptureCallbacks {
    shouldCapture: (e: PointerEvent) => boolean;
    onStart: (e: PointerEvent, latlng: L.LatLng) => void;
    onMove: (events: PointerEvent[], latlngs: L.LatLng[]) => void;
    onEnd: (e: PointerEvent, cancelled: boolean) => void;
}

const DRAW_ACTIVE_CLASS = "annot-drawing-active";

// Capture-phase pointer listeners on the leaflet container. Capture phase runs
// before Leaflet's bubble listeners, so we can choose to swallow the event
// (drawing) or let it propagate (finger pan when finger drawing is off).
export function usePointerCapture(
    map: L.Map | null,
    callbacks: CaptureCallbacks,
): void {
    // Keep a ref so event listeners always call the latest callbacks without
    // the effect needing to re-register. If the effect depended on `callbacks`
    // directly, any dep change (color, tool, drawingEnabled, etc.) would tear
    // down and re-add listeners mid-stroke, resetting activePointerId to null
    // and causing pointerup to be silently ignored.
    const cbRef = useRef(callbacks);
    cbRef.current = callbacks;

    useEffect(() => {
        if (!map) return;
        const container = map.getContainer();

        let activePointerId: number | null = null;

        const release = (e: PointerEvent, cancelled: boolean) => {
            if (activePointerId !== e.pointerId) return;
            activePointerId = null;
            try {
                map.dragging.enable();
            } catch {
                // ignore
            }
            container.classList.remove(DRAW_ACTIVE_CLASS);
            cbRef.current.onEnd(e, cancelled);
        };

        const onDown = (e: PointerEvent) => {
            if (!cbRef.current.shouldCapture(e)) return;
            if (activePointerId !== null) return;

            e.preventDefault();
            e.stopPropagation();
            activePointerId = e.pointerId;

            try {
                map.dragging.disable();
            } catch {
                // ignore
            }
            container.classList.add(DRAW_ACTIVE_CLASS);

            try {
                (e.target as Element)?.setPointerCapture?.(e.pointerId);
            } catch {
                // ignore
            }

            const rect = container.getBoundingClientRect();
            const latlng = map.containerPointToLatLng([
                e.clientX - rect.left,
                e.clientY - rect.top,
            ]);
            cbRef.current.onStart(e, latlng);
        };

        const onMove = (e: PointerEvent) => {
            if (activePointerId === null) return;
            if (e.pointerId !== activePointerId) return;

            e.preventDefault();
            e.stopPropagation();

            const rect = container.getBoundingClientRect();
            const events =
                typeof e.getCoalescedEvents === "function"
                    ? e.getCoalescedEvents()
                    : [];
            const sample = events.length > 0 ? events : [e];
            const latlngs = sample.map((ev) =>
                map.containerPointToLatLng([
                    ev.clientX - rect.left,
                    ev.clientY - rect.top,
                ]),
            );
            cbRef.current.onMove(sample, latlngs);
        };

        const onUp = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            e.preventDefault();
            e.stopPropagation();
            release(e, false);
        };

        const onCancel = (e: PointerEvent) => {
            if (e.pointerId !== activePointerId) return;
            release(e, true);
        };

        const opts: AddEventListenerOptions = { capture: true };
        container.addEventListener("pointerdown", onDown, opts);
        container.addEventListener("pointermove", onMove, opts);
        container.addEventListener("pointerup", onUp, opts);
        container.addEventListener("pointercancel", onCancel, opts);

        return () => {
            container.removeEventListener("pointerdown", onDown, opts);
            container.removeEventListener("pointermove", onMove, opts);
            container.removeEventListener("pointerup", onUp, opts);
            container.removeEventListener("pointercancel", onCancel, opts);
            container.classList.remove(DRAW_ACTIVE_CLASS);
            try {
                map.dragging.enable();
            } catch {
                // ignore
            }
        };
    }, [map]); // only depends on map — callbacks are always current via cbRef
}
