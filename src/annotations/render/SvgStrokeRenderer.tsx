import type * as L from "leaflet";
import { useEffect, useReducer } from "react";

import type { StrokeFeature, StrokeProperties } from "@/annotations/types";
import { metersToPixels } from "@/annotations/utils/geoMath";

interface ActiveStroke {
    points: L.LatLng[];
    color: string;
    widthMeters: number;
    tool: "pen" | "crossout";
}

interface Props {
    map: L.Map;
    strokes: StrokeFeature[];
    active: ActiveStroke | null;
}

interface XY {
    x: number;
    y: number;
}

// Quadratic Bézier through midpoints — Procreate-style smoothing,
// gives a clean look with one pass over the points.
function buildSmoothPath(pts: XY[]): string {
    if (pts.length === 0) return "";
    if (pts.length === 1) {
        return `M${pts[0].x},${pts[0].y} L${pts[0].x + 0.01},${pts[0].y}`;
    }
    if (pts.length === 2) {
        return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
    }
    let d = `M${(pts[0].x + pts[1].x) / 2},${(pts[0].y + pts[1].y) / 2}`;
    for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        d += ` Q${pts[i].x},${pts[i].y} ${mx},${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${last.x},${last.y}`;
    return d;
}

function projectLatLngs(map: L.Map, latlngs: L.LatLng[]): XY[] {
    return latlngs.map((ll) => map.latLngToContainerPoint(ll));
}

function projectGeoJson(
    map: L.Map,
    coords: GeoJSON.Position[],
): { pts: XY[]; midLat: number } {
    const pts: XY[] = new Array(coords.length);
    let latSum = 0;
    for (let i = 0; i < coords.length; i++) {
        const [lng, lat] = coords[i];
        pts[i] = map.latLngToContainerPoint([lat, lng]);
        latSum += lat;
    }
    return { pts, midLat: coords.length > 0 ? latSum / coords.length : 0 };
}

function renderStrokeFeature(
    map: L.Map,
    feature: StrokeFeature,
    key: string,
): React.ReactNode {
    const { pts, midLat } = projectGeoJson(map, feature.geometry.coordinates);
    if (pts.length === 0) return null;
    const props: StrokeProperties = feature.properties;
    const widthPx = Math.max(1, metersToPixels(map, props.widthMeters, midLat));
    return (
        <path
            key={key}
            d={buildSmoothPath(pts)}
            stroke={props.color}
            strokeWidth={widthPx}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
        />
    );
}

export function SvgStrokeRenderer({ map, strokes, active }: Props) {
    const [, force] = useReducer((c: number) => c + 1, 0);

    useEffect(() => {
        const handler = () => force();
        map.on("move zoom zoomanim viewreset resize", handler);
        return () => {
            map.off("move zoom zoomanim viewreset resize", handler);
        };
    }, [map]);

    const size = map.getSize();

    let activePath: React.ReactNode = null;
    if (active && active.points.length > 0) {
        const pts = projectLatLngs(map, active.points);
        let latSum = 0;
        for (const ll of active.points) latSum += ll.lat;
        const midLat = latSum / active.points.length;
        const widthPx = Math.max(
            1,
            metersToPixels(map, active.widthMeters, midLat),
        );
        activePath = (
            <path
                d={buildSmoothPath(pts)}
                stroke={active.color}
                strokeWidth={widthPx}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
            />
        );
    }

    return (
        <svg
            width={size.x}
            height={size.y}
            viewBox={`0 0 ${size.x} ${size.y}`}
            style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                zIndex: 450,
            }}
        >
            {strokes.map((s, i) =>
                renderStrokeFeature(
                    map,
                    s,
                    `stroke-${i}-${s.properties.createdAt}`,
                ),
            )}
            {activePath}
        </svg>
    );
}
