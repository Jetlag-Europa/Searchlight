import "leaflet/dist/leaflet.css";
import "leaflet-contextmenu/dist/leaflet.contextmenu.css";
import "leaflet-contextmenu";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { FeatureCollection, Polygon } from "geojson";
import * as L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { MapContainer, ScaleControl, TileLayer } from "react-leaflet";
import { toast } from "react-toastify";

import { AnnotationLayer } from "@/annotations";
import { compiledGameAtom } from "@/game-definition/store";
import { activeSessionId } from "@/lib/activeSession";
import { bootstrapDefaults } from "@/lib/bootstrapCustomStations";
import {
    additionalMapGeoLocations,
    addQuestion,
    animateMapMovements,
    autoZoom,
    baseTileLayer,
    followMe,
    gameDefinitionReady,
    hiderMode,
    leafletMapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    perQuestionMapData,
    planningModeEnabled,
    polyGeoJSON,
    questionFinishedMapData,
    questions,
    setScopedLoading,
    thunderforestApiKey,
    triggerLocalRefresh,
} from "@/lib/context";
import { currentGameId, isGameSwitchPending } from "@/lib/games";
import { createLatestTask } from "@/lib/latestTask";
import { installTestHook } from "@/lib/testHook";
import { cn } from "@/lib/utils";
import {
    computePerQuestionRegions,
    determinePlanningPolygon,
} from "@/maps";
import { hiderifyQuestion } from "@/maps";
import {
    BLANK_GEOJSON,
    clearCache,
    determineMapBoundaries,
} from "@/maps/api";
import {
    requestGeometry,
    SupersededError,
} from "@/maps/geo-utils/geometryClient";

import { DraggableMarkers } from "./DraggableMarkers";
import { LeafletFullScreenButton } from "./LeafletFullScreenButton";
import { MapPrint } from "./MapPrint";
import { PolygonDraw } from "./PolygonDraw";

// CARTO requires an API key on raster basemap tiles; unkeyed requests are served
// with an "API KEY REQUIRED" watermark. Free key from
// https://carto.com/basemaps/apikey/. Plain constant on purpose: this is a
// client bundle, so the key ships to the browser wherever it is declared.
const CARTO_API_KEY = "cb1_2e23_1_bd24b1a55d41442abf180516";

const getTileLayer = (tileLayer: string, thunderforestApiKey: string) => {
    switch (tileLayer) {
        case "light":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
                    url={`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                    subdomains="abcd"
                    maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
                    minZoom={2}
                    noWrap
                />
            );

        case "dark":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
                    url={`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                    subdomains="abcd"
                    maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
                    minZoom={2}
                    noWrap
                />
            );

        case "transport":
            if (thunderforestApiKey)
                return (
                    <TileLayer
                        url={`https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`}
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="http://www.thunderforest.com/">Thunderforest</a>; Powered by Esri and Turf.js'
                        maxZoom={22}
                        minZoom={2}
                        noWrap
                    />
                );
            break;

        case "neighbourhood":
            if (thunderforestApiKey)
                return (
                    <TileLayer
                        url={`https://tile.thunderforest.com/neighbourhood/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`}
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="http://www.thunderforest.com/">Thunderforest</a>; Powered by Esri and Turf.js'
                        maxZoom={22}
                        minZoom={2}
                        noWrap
                    />
                );
            break;

        case "osmcarto":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; Powered by Esri and Turf.js'
                    url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                    maxZoom={19}
                    minZoom={2}
                    noWrap
                />
            );
    }

    return (
        <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
            url={`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
            subdomains="abcd"
            maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
            minZoom={2}
            noWrap
        />
    );
};

// The active game may not offer the requested question type.
const addQuestionFromMenu = (question: Parameters<typeof addQuestion>[0]) => {
    try {
        addQuestion(question);
    } catch (error) {
        toast.error((error as Error).message);
    }
};

export const Map = ({ className }: { className?: string }) => {
    useStore(additionalMapGeoLocations);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $questions = useStore(questions);
    const $baseTileLayer = useStore(baseTileLayer);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $hiderMode = useStore(hiderMode);
    const $planningMode = useStore(planningModeEnabled);
    const $compiledGame = useStore(compiledGameAtom);
    const $followMe = useStore(followMe);
    const $permanentOverlay = useStore(permanentOverlay);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $gameDefinitionReady = useStore(gameDefinitionReady);
    const map = useStore(leafletMapContext);
    const $currentGameId = useStore(currentGameId);
    const refreshQueue = useMemo(() => createLatestTask(), []);
    const renderedGameIdRef = useRef<string | null>(null);

    const clearQuestionLayers = (targetMap: L.Map) => {
        targetMap.eachLayer((layer) => {
            if (
                ("questionKey" in layer && layer.questionKey != null) ||
                ("eliminationGeoJSON" in layer && layer.eliminationGeoJSON)
            ) {
                targetMap.removeLayer(layer);
            }
        });
    };
    // Test-only: expose map/question state on window.__searchlight for Playwright
    // e2e (no-op unless PUBLIC_ENABLE_TEST_HOOK=1).
    useEffect(() => {
        installTestHook();
    }, []);

    const followMeMarkerRef = useMemo(
        () => ({ current: null as L.Marker | null }),
        [],
    );
    const geoWatchIdRef = useMemo(
        () => ({ current: null as number | null }),
        [],
    );

    const refreshQuestions = async (isLatest: () => boolean) => {
        if (!map) return;

        const sourceQuestions = questions.get();
        const planning = planningModeEnabled.get();
        const compiled = compiledGameAtom.get();
        const hider = hiderMode.get();
        const boundary = polyGeoJSON.get();
        const location = mapGeoLocation.get();
        const definitionReady = gameDefinitionReady.get();
        const activeGameId = currentGameId.get();

        // If switching to a new game (different game ID than what's rendered),
        // clear old layers immediately so old layers are not presented for a
        // different game.
        if (
            renderedGameIdRef.current !== null &&
            renderedGameIdRef.current !== activeGameId
        ) {
            clearQuestionLayers(map);
            renderedGameIdRef.current = null;
        }

        const isCurrent = () =>
            isLatest() &&
            currentGameId.get() === activeGameId &&
            questions.get() === sourceQuestions &&
            planningModeEnabled.get() === planning &&
            compiledGameAtom.get() === compiled &&
            hiderMode.get() === hider &&
            polyGeoJSON.get() === boundary &&
            mapGeoLocation.get() === location &&
            gameDefinitionReady.get() === definitionReady;

        if (sourceQuestions.length > 0 && !definitionReady) {
            // If switch failed (compiled is null and definitionReady is false), clear old layers
            if (
                renderedGameIdRef.current !== null &&
                !compiled &&
                !definitionReady
            ) {
                clearQuestionLayers(map);
                renderedGameIdRef.current = null;
            }
            return;
        }
        setScopedLoading("map", true);
        try {
            // Question cards and markers mutate data in place, even when auto-save
            // is off. Take an immutable view before any awaited geometry work.
            const snapshot = structuredClone(sourceQuestions);
            if (snapshot.length === 0) {
                await clearCache();
                if (!isCurrent()) return;
            }

            let mapGeoData = boundary ?? mapGeoJSON.get();
            if (!mapGeoData) {
                // A game brings its own play area, and every session has a
                // game: while one is selected, loading or being restored, wait
                // for it instead of fetching the free-play boundary.
                if (
                    currentGameId.get() ||
                    activeSessionId.get() ||
                    isGameSwitchPending()
                ) {
                    if (
                        renderedGameIdRef.current !== null &&
                        !compiled &&
                        !definitionReady
                    ) {
                        clearQuestionLayers(map);
                        renderedGameIdRef.current = null;
                    }
                    return;
                }
                mapGeoData = await toast.promise(determineMapBoundaries(), {
                    error: "Couldn't load map boundaries — Overpass API may be slow. Try again.",
                });
                if (!isCurrent()) return;
            }
            if (mapGeoJSON.get() !== mapGeoData) mapGeoJSON.set(mapGeoData);
            if (hider !== false) {
                for (const question of snapshot) {
                    await hiderifyQuestion(question);
                    if (!isCurrent()) return;
                }
            }

            const perQuestionRegions = await computePerQuestionRegions(
                snapshot,
                mapGeoData,
                planning,
            );
            if (!isCurrent()) return;

            // Build the replacement off-map. Never clear the visible result
            // while awaiting geometry, or let an obsolete refresh publish layers.
            const previews: L.GeoJSON[] = [];
            for (const question of snapshot) {
                const geometry = await determinePlanningPolygon(
                    question,
                    planning,
                );
                if (!isCurrent()) return;
                if (!geometry) continue;
                const layer = L.geoJSON(geometry);
                Object.assign(layer, { questionKey: question.key });
                previews.push(layer);
            }

            // Standalone regions already include the base boundary. Reuse them
            // rather than evaluating every question a second time for the map.
            if (perQuestionRegions.length) {
                mapGeoData = perQuestionRegions[0].region;
                for (
                    let index = 1;
                    index < perQuestionRegions.length;
                    index++
                ) {
                    const { region } = perQuestionRegions[index];
                    const intersection = await requestGeometry({
                        kind: "clip",
                        mapData: mapGeoData!,
                        modifications: region,
                        within: true,
                    });
                    if (!isCurrent()) return;
                    mapGeoData = turf.featureCollection(
                        intersection ? [intersection] : [],
                    );
                }
            }
            if (!isCurrent()) return;

            // Mask the remaining area off the main thread (same result as
            // holedMask) and keep the unmasked area for auto-zoom.
            const remaining = mapGeoData!;
            const mask = await requestGeometry({
                kind: "clip",
                mapData: BLANK_GEOJSON as FeatureCollection<Polygon>,
                modifications: remaining,
                within: false,
            });
            if (!isCurrent()) return;
            mapGeoData = {
                type: "FeatureCollection",
                features: [mask!],
            };
            const elimination = L.geoJSON(mapGeoData);
            Object.assign(elimination, { eliminationGeoJSON: true });

            clearQuestionLayers(map);
            for (const preview of previews) preview.addTo(map);
            elimination.addTo(map);
            renderedGameIdRef.current = activeGameId;
            if (hider !== false) {
                snapshot.forEach((question, index) => {
                    sourceQuestions[index].data = question.data;
                });
                triggerLocalRefresh.set(Math.random());
            }
            perQuestionMapData.set(perQuestionRegions);
            questionFinishedMapData.set(mapGeoData);

            if (autoZoom.get()) {
                if (!remaining.features.length) return;
                const bbox = turf.bbox(remaining);
                const bounds: L.LatLngBoundsExpression = [
                    [bbox[1], bbox[0]],
                    [bbox[3], bbox[2]],
                ];
                if (animateMapMovements.get()) {
                    map.flyToBounds(bounds);
                } else {
                    map.fitBounds(bounds);
                }
            }
        } catch (error) {
            if (!isCurrent()) return;
            if (error instanceof SupersededError) {
                // This refresh reused cached geometry an obsolete refresh had
                // requested, and a newer position replaced it. The cache has
                // dropped it, so start over.
                void refreshQueue.request(refreshQuestions);
                return;
            }
            console.error(error);
            if (document.querySelectorAll(".Toastify__toast").length === 0) {
                toast.error("No solutions found / error occurred");
            }
        } finally {
            setScopedLoading("map", false);
        }
    };

    const displayMap = useMemo(
        () => (
            <MapContainer
                center={$mapGeoLocation.geometry.coordinates}
                zoom={5}
                className={cn("w-[500px] h-[500px]", className)}
                ref={leafletMapContext.set}
                // @ts-expect-error Typing doesn't update from react-contextmenu
                contextmenu={true}
                contextmenuWidth={140}
                contextmenuItems={[
                    {
                        text: "Add Radius",
                        callback: (e: any) =>
                            addQuestionFromMenu({
                                id: "radius",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            }),
                    },
                    {
                        text: "Add Thermometer",
                        callback: (e: any) => {
                            const destination = turf.destination(
                                [e.latlng.lng, e.latlng.lat],
                                5,
                                90,
                                {
                                    units: "miles",
                                },
                            );

                            addQuestionFromMenu({
                                id: "thermometer",
                                data: {
                                    latA: e.latlng.lat,
                                    lngA: e.latlng.lng,
                                    latB: destination.geometry.coordinates[1],
                                    lngB: destination.geometry.coordinates[0],
                                },
                            });
                        },
                    },
                    {
                        text: "Add Tentacles",
                        callback: (e: any) => {
                            addQuestionFromMenu({
                                id: "tentacles",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Add Matching",
                        callback: (e: any) => {
                            addQuestionFromMenu({
                                id: "matching",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Add Measuring",
                        callback: (e: any) => {
                            addQuestionFromMenu({
                                id: "measuring",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Exclude Country",
                        callback: (e: any) => {
                            addQuestionFromMenu({
                                id: "matching",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                    same: false,
                                    cat: {
                                        adminLevel: 2,
                                    },
                                    type: "zone",
                                },
                            });
                        },
                    },
                    {
                        text: "Copy Coordinates",
                        callback: (e: any) => {
                            if (!navigator || !navigator.clipboard) {
                                toast.error(
                                    "Clipboard API not supported in your browser",
                                );
                                return;
                            }

                            const latitude = e.latlng.lat;
                            const longitude = e.latlng.lng;

                            toast.promise(
                                navigator.clipboard.writeText(
                                    `${Math.abs(latitude)}°${latitude > 0 ? "N" : "S"}, ${Math.abs(
                                        longitude,
                                    )}°${longitude > 0 ? "E" : "W"}`,
                                ),
                                {
                                    pending: "Writing to clipboard...",
                                    success: "Coordinates copied!",
                                    error: "An error occurred while copying",
                                },
                                { autoClose: 1000 },
                            );
                        },
                    },
                ]}
            >
                {getTileLayer($baseTileLayer, $thunderforestApiKey)}
                <DraggableMarkers />
                <div className="leaflet-top leaflet-right">
                    <div className="leaflet-control flex-col flex gap-2">
                        <LeafletFullScreenButton />
                    </div>
                </div>
                <PolygonDraw />
                <ScaleControl position="bottomleft" />
                <MapPrint
                    position="topright"
                    sizeModes={["Current", "A4Portrait", "A4Landscape"]}
                    hideControlContainer={false}
                    hideClasses={[
                        "leaflet-full-screen-specific-name",
                        "leaflet-top",
                        "leaflet-control-easyPrint",
                        "leaflet-draw",
                    ]}
                    title="Print"
                />
            </MapContainer>
        ),
        [map, $baseTileLayer, $thunderforestApiKey],
    );

    useEffect(() => {
        bootstrapDefaults();
    }, []);

    useEffect(() => {
        if (!map) return;
        const resizeObserver = new ResizeObserver(() => {
            map.invalidateSize({ pan: false });
        });
        resizeObserver.observe(map.getContainer());
        return () => resizeObserver.disconnect();
    }, [map]);

    useEffect(() => {
        void refreshQueue.request(refreshQuestions);
        return () => refreshQueue.cancel();
    }, [
        $questions,
        map,
        $hiderMode,
        $planningMode,
        $compiledGame,
        $mapGeoLocation,
        $polyGeoJSON,
        $gameDefinitionReady,
        $currentGameId,
    ]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            const mainElement: HTMLElement | null =
                document.querySelector("main");

            if (mainElement) {
                if (document.fullscreenElement) {
                    mainElement.classList.add("fullscreen");
                } else {
                    mainElement.classList.remove("fullscreen");
                }
            }
        };

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullscreenChange,
            );
        };
    }, []);

    useEffect(() => {
        if (!map) return;
        if (!$followMe) {
            if (followMeMarkerRef.current) {
                map.removeLayer(followMeMarkerRef.current);
                followMeMarkerRef.current = null;
            }
            if (geoWatchIdRef.current !== null) {
                navigator.geolocation.clearWatch(geoWatchIdRef.current);
                geoWatchIdRef.current = null;
            }
            return;
        }

        geoWatchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                if (followMeMarkerRef.current) {
                    followMeMarkerRef.current.setLatLng([lat, lng]);
                } else {
                    const marker = L.marker([lat, lng], {
                        icon: L.divIcon({
                            html: `<div class="text-blue-700 bg-white rounded-full border-2 border-blue-700 shadow w-5 h-5 flex items-center justify-center"><svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#2A81CB" opacity="0.5"/><circle cx="8" cy="8" r="3" fill="#2A81CB"/></svg></div>`,
                            className: "",
                        }),
                        zIndexOffset: 1000,
                    });
                    marker.addTo(map);
                    followMeMarkerRef.current = marker;
                }
            },
            () => {
                toast.error("Unable to access your location.");
                followMe.set(false);
            },
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
        );
        return () => {
            if (followMeMarkerRef.current) {
                map.removeLayer(followMeMarkerRef.current);
                followMeMarkerRef.current = null;
            }
            if (geoWatchIdRef.current !== null) {
                navigator.geolocation.clearWatch(geoWatchIdRef.current);
                geoWatchIdRef.current = null;
            }
        };
    }, [$followMe, map]);

    useEffect(() => {
        if (!map) return;

        map.eachLayer((layer: any) => {
            if (layer.permanentGeoJSON) map.removeLayer(layer);
        });

        if ($permanentOverlay === null) return;

        try {
            const overlay = L.geoJSON($permanentOverlay, {
                interactive: false,

                // @ts-expect-error Type hints force a Layer to be returned, but Leaflet accepts null as well
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                pointToLayer(geoJsonPoint, latlng) {
                    return null;
                },

                style(feature) {
                    return {
                        color: feature?.properties?.stroke,
                        weight: feature?.properties?.["stroke-width"],
                        opacity: feature?.properties?.["stroke-opacity"],
                        fillColor: feature?.properties?.fill,
                        fillOpacity: feature?.properties?.["fill-opacity"],
                    };
                },
            });
            // @ts-expect-error This is a check such that only this type of layer is removed
            overlay.permanentGeoJSON = true;
            overlay.addTo(map);
            overlay.bringToBack();
        } catch (e) {
            toast.error(`Failed to display GeoJSON overlay: ${e}`);
        }
    }, [$permanentOverlay, map]);

    return (
        <>
            {displayMap}
            {/* ANNOTATION LAYER MOUNT — see src/annotations/ */}
            <AnnotationLayer map={map} />
        </>
    );
};
