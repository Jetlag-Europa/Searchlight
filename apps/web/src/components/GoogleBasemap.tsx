import "leaflet.gridlayer.googlemutant";

import { useStore } from "@nanostores/react";
import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import { toast } from "react-toastify";

import { activeSessionId } from "@/lib/activeSession";
import {
    googleMapType,
    hideGooglePlaces,
    showGoogleTransit,
} from "@/lib/context";
import {
    type GoogleLook,
    googleLook,
    googleMapTypeOf,
    HIDE_PLACES_STYLES,
    loadGoogleMapsApi,
    printingWithoutGoogle,
    reportGoogleMapLoad,
} from "@/lib/googleMaps";

// One layer for the whole page. GoogleMutant creates its google.maps.Map the
// first time the layer is added and keeps it when the layer is removed, and
// each new map is a billed map load. So switching basemaps, sessions or going
// offline and back reuses this one instead of loading another.
let layer: L.GridLayer | null = null;
let applyLook: ((look: GoogleLook) => void) | null = null;

// GoogleMutant's own default. Google's map stops short of it where it has no
// closer imagery, and GoogleMutant then enlarges the closest tiles it has.
const MAX_NATIVE_ZOOM = 21;

function chosenLook(): GoogleLook {
    return {
        type: googleMapTypeOf(googleMapType.get()),
        transit: showGoogleTransit.get(),
        hidePlaces: hideGooglePlaces.get(),
    };
}

function googleLayer(): L.GridLayer {
    if (layer) return layer;
    // Created as chosen, so the first tiles are the right ones. Transit lines
    // come with the first applyLook.
    const initial = { ...chosenLook(), transit: false };
    layer = (L.gridLayer as any).googleMutant({
        type: initial.type,
        styles: initial.hidePlaces ? HIDE_PLACES_STYLES : [],
        maxZoom: 21,
        minZoom: 2,
        noWrap: true,
        // Google's own copyright comes with the map; this is ours, as on the
        // other basemaps.
        attribution: "Powered by Esri and Turf.js",
        // Hidden when the browser prints the page (globals.css).
        className: "google-basemap",
    }) as L.GridLayer;
    const googleMutant = layer as any;
    // GoogleMutant creates the map once, on the layer's first add.
    googleMutant.once("spawned", () =>
        reportGoogleMapLoad(activeSessionId.get()),
    );
    applyLook = googleLook(
        {
            setMapType: (type) =>
                googleMutant.whenReady(() => {
                    googleMutant.options.type = type;
                    // The new type may have closer tiles than the last one.
                    googleMutant.options.maxNativeZoom = MAX_NATIVE_ZOOM;
                    googleMutant._mutant.setMapTypeId(type);
                }),
            setStyles: (styles) =>
                googleMutant.whenReady(() =>
                    googleMutant._mutant.setOptions({ styles }),
                ),
            addGoogleLayer: (name) => googleMutant.addGoogleLayer(name),
            removeGoogleLayer: (name) => googleMutant.removeGoogleLayer(name),
        },
        () => redrawWhenLoaded(googleMutant),
        initial,
    );
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

/**
 * Replaces the tiles on the map once Google has drawn its new ones, after a
 * change to what Google's map shows (GoogleLook). GoogleMutant copies Google's tile images
 * and keeps the last hundred to reuse; those show the map as it was, so they
 * go. Until Google is done, the old tiles stay rather than blank ones.
 */
let pendingRedraw: { remove(): void } | null = null;

function redrawWhenLoaded(googleMutant: any) {
    googleMutant.whenReady(() => {
        googleMutant._lru.clear();
        // One redraw for any number of quick changes.
        pendingRedraw?.remove();
        pendingRedraw = (window as any).google.maps.event.addListenerOnce(
            googleMutant._mutant,
            "tilesloaded",
            () => {
                pendingRedraw = null;
                googleMutant.redraw();
            },
        );
    });
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
            // Not top-right, where it would cover the print button.
            { position: "top-center" },
        );
    };
}

/** Google Maps' own map as the basemap, with its logo and copyright. */
export const GoogleBasemap = () => {
    const map = useMap();
    const $googleMapType = useStore(googleMapType);
    const $showGoogleTransit = useStore(showGoogleTransit);
    const $hideGooglePlaces = useStore(hideGooglePlaces);

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
                applyLook?.(chosenLook());
            })
            // googleMapsProblem now says why, and the map falls back to CARTO.
            .catch(() => {});
        return () => {
            mounted = false;
            container.removeEventListener("click", onClick, { capture: true });
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        };
    }, [map]);

    // Only while the layer is on the map: Google draws nothing for a map
    // that isn't on the page, and the load above applies the settings when it
    // adds the layer.
    useEffect(() => {
        if (layer && map.hasLayer(layer)) applyLook?.(chosenLook());
    }, [map, $googleMapType, $showGoogleTransit, $hideGooglePlaces]);

    return null;
};
