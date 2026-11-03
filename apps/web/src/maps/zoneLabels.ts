import * as L from "leaflet";

/**
 * A hiding zone's name on the map, drawn like a centred permanent Leaflet
 * tooltip. A tooltip measures itself when added and on every zoom, forcing a
 * layout per label; this one is centred by CSS instead.
 */
export function zoneNameLabel(latlng: L.LatLng, name: string): L.Marker {
    const label = document.createElement("div");
    label.className = "leaflet-tooltip zone-name-label leaflet-tooltip-center";
    // Names come from the game definition: Leaflet renders a string as HTML,
    // so pass it as text.
    const text = document.createElement("span");
    text.textContent = name;
    label.append(text);
    return L.marker(latlng, {
        pane: "tooltipPane",
        interactive: false,
        // Otherwise Leaflet makes the label a focusable button.
        keyboard: false,
        // A tooltip's default.
        opacity: 0.9,
        icon: L.divIcon({
            html: label,
            className: "zone-name-marker",
            // @ts-expect-error null stops Leaflet sizing the icon 12×12; the types don't allow it
            iconSize: null,
        }),
    });
}
