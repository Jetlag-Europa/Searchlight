import type * as L from "leaflet";

const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Web-Mercator scale at the given latitude/zoom: meters per CSS pixel.
function metersPerPixel(map: L.Map, lat: number): number {
    const zoom = map.getZoom();
    return (
        (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) /
        Math.pow(2, zoom + 8)
    );
}

export function pixelsToMeters(
    map: L.Map,
    pixels: number,
    lat: number,
): number {
    return pixels * metersPerPixel(map, lat);
}

export function metersToPixels(
    map: L.Map,
    meters: number,
    lat: number,
): number {
    const mpp = metersPerPixel(map, lat);
    if (mpp === 0) return 0;
    return meters / mpp;
}
