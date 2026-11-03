import "leaflet.gridlayer.googlemutant";

import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { toast } from "react-toastify";

import { loadGoogleMapsApi, printingWithoutGoogle } from "@/lib/googleMaps";

// One layer for the whole page. GoogleMutant creates its google.maps.Map the
// first time the layer is added and keeps it when the layer is removed, and
// each new map is a billed map load. So switching basemaps, sessions or going
// offline and back reuses this one instead of loading another.
let layer: L.GridLayer | null = null;

function googleLayer(): L.GridLayer {
    layer ??= (L.gridLayer as any).googleMutant({
        type: "roadmap",
        maxZoom: 21,
        minZoom: 2,
        noWrap: true,
        // Google's own copyright comes with the map; this is ours, as on the
        // other basemaps.
        attribution: "Powered by Esri and Turf.js",
        // Hidden when the browser prints the page (globals.css).
        className: "google-basemap",
    }) as L.GridLayer;
    return layer;
}

/**
 * GoogleMutant moves Google's logo and copyright into the map's corners once
 * Google has drawn them, and only once: if the layer was removed in between,
 * it never does. Ask again, so a re-added layer always carries them.
 */
function keepGoogleAttribution(googleMutant: any) {
    if (googleMutant._mutant && !googleMutant._logoContainer) {
        googleMutant._waitControls();
        googleMutant.once(
            "controls_ready",
            googleMutant._setupAttribution,
            googleMutant,
        );
    }
}

// How long CARTO stays in for a print the user hasn't started yet, and for
// one that started but never reported back (easyPrint only reports success).
const PRINT_WAIT_MS = 60_000;
const PRINT_RUN_MS = 5 * 60_000;

/**
 * Google's terms don't allow keeping its map outside the API, and a print
 * is an image of the map. So choosing a print size switches the map to CARTO
 * first; the user picks the size again once it's drawn. Google comes back
 * when the print is done, or after a minute without one.
 */
function printWithCarto(map: L.Map) {
    return (event: MouseEvent) => {
        const target = event.target as Element | null;
        if (!target?.closest(".leaflet-control-easyPrint .easyPrintSizeMode"))
            return;
        event.stopPropagation();
        event.preventDefault();
        let timer = setTimeout(() => restore(), PRINT_WAIT_MS);
        const started = () => {
            clearTimeout(timer);
            timer = setTimeout(() => restore(), PRINT_RUN_MS);
        };
        const restore = () => {
            clearTimeout(timer);
            map.off("easyPrint-start", started);
            map.off("easyPrint-finished", restore);
            printingWithoutGoogle.set(false);
        };
        map.on("easyPrint-start", started);
        map.on("easyPrint-finished", restore);
        printingWithoutGoogle.set(true);
        toast.info(
            "Google Maps can't be printed, so the print uses CARTO Voyager. Choose the size again to print.",
        );
    };
}

/** Google Maps' own map as the basemap, with its logo and copyright. */
export const GoogleBasemap = () => {
    const map = useMap();

    useEffect(() => {
        let mounted = true;
        // On the map's container: the print control may be added after this.
        const onClick = printWithCarto(map) as EventListener;
        const container = map.getContainer();
        container.addEventListener("click", onClick, { capture: true });
        loadGoogleMapsApi()
            .then(() => {
                if (!mounted) return;
                googleLayer().addTo(map);
                keepGoogleAttribution(layer);
            })
            // googleMapsProblem now says why, and the map falls back to CARTO.
            .catch(() => {});
        return () => {
            mounted = false;
            container.removeEventListener("click", onClick, { capture: true });
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        };
    }, [map]);

    return null;
};
