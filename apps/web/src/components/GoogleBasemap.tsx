import "leaflet.gridlayer.googlemutant";

import { useStore } from "@nanostores/react";
import L from "leaflet";
import { type ReactNode, useEffect, useState } from "react";
import { useMap } from "react-leaflet";

import {
    googleMapType,
    hideGooglePlaces,
    showGoogleTransit,
} from "@/lib/context";
import {
    type GoogleLook,
    googleLook,
    googleMapDrawn,
    googleMapTypeOf,
    googleStandingIn,
    HIDE_PLACES_STYLES,
    loadGoogleMapsApi,
    whenDrawn,
} from "@/lib/googleMaps";

// One layer for the whole page. GoogleMutant creates its google.maps.Map the
// first time the layer is added and keeps it when the layer is removed, and
// each new map is a billed map load. So switching basemaps, sessions or going
// offline and back reuses this one instead of loading another.
let layer: L.GridLayer | null = null;
let applyLook: ((look: GoogleLook) => void) | null = null;
// Whether the layer, Google's logo and its copyright are shown. They're hidden
// while CARTO stands in, so the two maps never show together.
let shown = false;

/** Shows or hides Google's map, logo and copyright. */
function showGoogle(googleMutant: any, show: boolean) {
    shown = show;
    googleMutant.setOpacity(show ? 1 : 0);
    for (const container of [
        googleMutant._logoContainer,
        googleMutant._attributionContainer,
    ])
        if (container) container.style.display = show ? "" : "none";
}

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
    // GoogleMutant moves the logo and copyright in once Google has drawn them
    // (after this listener, hence the microtask): hide them if it isn't shown.
    googleMutant.on("controls_ready", () =>
        queueMicrotask(() => showGoogle(googleMutant, shown)),
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

/** Whether every tile Leaflet shows for the current view has loaded. */
function currentViewLoaded(gridLayer: any): boolean {
    const current = Object.values(gridLayer._tiles ?? {}).filter(
        (tile: any) => tile.current,
    );
    return current.length > 0 && current.every((tile: any) => tile.loaded);
}

/**
 * Google Maps' own map as the basemap, with its logo and copyright. Until
 * Google has drawn the map's tiles it shows `children` (CARTO) instead, and
 * keeps doing so if Google never does: on a weak connection the loader, a
 * module or the tiles can take long or not come at all.
 */
export const GoogleBasemap = ({ children }: { children: ReactNode }) => {
    const map = useMap();
    const [drawn, setDrawn] = useState(false);
    const $googleMapType = useStore(googleMapType);
    const $showGoogleTransit = useStore(showGoogleTransit);
    const $hideGooglePlaces = useStore(hideGooglePlaces);

    useEffect(() => {
        let mounted = true;
        let stopWaiting = () => {};
        googleStandingIn.set(true);
        loadGoogleMapsApi()
            .then(() => {
                if (!mounted) return;
                const googleMutant = googleLayer() as any;
                showGoogle(googleMutant, false);
                // Before the layer is added: a look changed while it was off
                // the map clears the tiles GoogleMutant kept, rather than
                // drawing them first.
                applyLook?.(chosenLook());
                stopWaiting = whenDrawn(
                    googleMutant,
                    () => currentViewLoaded(googleMutant),
                    () => pendingRedraw !== null,
                    () => setDrawn(true),
                );
                googleMutant.addTo(map);
                keepGoogleAttribution(googleMutant);
            })
            // googleMapsProblem now says why, and the map falls back to CARTO.
            .catch(() => {});
        return () => {
            mounted = false;
            stopWaiting();
            googleStandingIn.set(false);
            if (layer && map.hasLayer(layer)) map.removeLayer(layer);
        };
    }, [map]);

    // CARTO goes in this commit's cleanup, and Google shows in the same task,
    // so the browser never paints both or neither.
    useEffect(() => {
        if (!drawn || !layer) return;
        showGoogle(layer, true);
        googleStandingIn.set(false);
        googleMapDrawn();
    }, [drawn]);

    // Only while the layer is on the map: Google draws nothing for a map
    // that isn't on the page, and the load above applies the settings when it
    // adds the layer.
    useEffect(() => {
        if (layer && map.hasLayer(layer)) applyLook?.(chosenLook());
    }, [map, $googleMapType, $showGoogleTransit, $hideGooglePlaces]);

    return drawn ? null : children;
};
