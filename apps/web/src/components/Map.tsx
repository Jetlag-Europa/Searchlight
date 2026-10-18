import "leaflet/dist/leaflet.css";
import "leaflet-contextmenu/dist/leaflet.contextmenu.css";
import "leaflet-contextmenu";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { FeatureCollection, Polygon } from "geojson";
import * as L from "leaflet";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { MapContainer, ScaleControl, TileLayer } from "react-leaflet";
import { toast } from "react-toastify";

import { AnnotationLayer } from "@/annotations";
import { compiledGameAtom } from "@/game-definition/store";
import { activeSessionData, activeSessionId } from "@/lib/activeSession";
import { bootstrapDefaults } from "@/lib/bootstrap";
import { startCalculation } from "@/lib/calculating";
import {
    addQuestion,
    animateMapMovements,
    autoZoom,
    baseTileLayer,
    followMe,
    gameDefinitionReady,
    hiderMode,
    hidingZoneScale,
    lastGpsFix,
    leafletMapContext,
    mapGeoJSON,
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
import { currentGameId } from "@/lib/games";
import {
    type GameBounds,
    isGameBounds,
    lastGameView,
    rememberGameView,
    savedGameView,
} from "@/lib/gameView";
import { createLatestTask } from "@/lib/latestTask";
import { geoErrorAction, newThermometerData } from "@/lib/questionPosition";
import { installTestHook } from "@/lib/testHook";
import { cn } from "@/lib/utils";
import { zoneScaleAfter } from "@/lib/zoneSize";
import { computePerQuestionRegions, determinePlanningPolygon } from "@/maps";
import { hiderifyQuestion } from "@/maps";
import { BLANK_GEOJSON } from "@/maps/api";
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

// Before a game has loaded, the map shows the world, or the game it showed
// last (see lastGameView).
const WORLD_CENTER: L.LatLngTuple = [20, 0];
// The lowest zoom at which the world, which doesn't wrap, fills the width.
const worldZoom = (width: number) =>
    Math.max(2, Math.ceil(Math.log2(width / 256)));
// Basemap tiles exist only within the world; outside it they answer 400.
const WORLD_BOUNDS: L.LatLngBoundsExpression = [
    [-90, -180],
    [90, 180],
];

const fitGameBounds = (map: L.Map, [west, south, east, north]: GameBounds) =>
    map.fitBounds(
        [
            [south, west],
            [north, east],
        ],
        { animate: false },
    );

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
                    bounds={WORLD_BOUNDS}
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
                    bounds={WORLD_BOUNDS}
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
                        bounds={WORLD_BOUNDS}
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
                        bounds={WORLD_BOUNDS}
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
                    bounds={WORLD_BOUNDS}
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
            bounds={WORLD_BOUNDS}
        />
    );
};

// The game may not have loaded, or may not offer the requested question type.
const addQuestionFromMenu = (question: Parameters<typeof addQuestion>[0]) => {
    try {
        addQuestion(question);
    } catch (error) {
        toast.error((error as Error).message);
    }
};
// The context menu's first items, which add questions.
const ADD_QUESTION_MENU_ITEMS = [
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
            addQuestionFromMenu({
                id: "thermometer",
                data: newThermometerData(e.latlng),
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
];

export const Map = ({ className }: { className?: string }) => {
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
    const $activeSession = useStore(activeSessionData);
    const $activeSessionId = useStore(activeSessionId);
    const $lastGameView = useStore(lastGameView);
    const refreshQueue = useMemo(() => createLatestTask(), []);
    const renderedGameIdRef = useRef<string | null>(null);
    const framedGameIdRef = useRef<string | null>(null);
    // The framed game is a saved view, not yet confirmed by its loaded game.
    const provisionalViewRef = useRef(false);

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
        const finishCalculation = startCalculation("questions");
        try {
            // Question cards and markers mutate data in place, even when auto-save
            // is off. Take an immutable view before any awaited geometry work.
            const snapshot = structuredClone(sourceQuestions);

            let mapGeoData = boundary ?? mapGeoJSON.get();
            if (!mapGeoData) {
                // The play area comes from the game: wait for it to load.
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
            hidingZoneScale.set(zoneScaleAfter(snapshot));
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
            // Only another error makes this one redundant (not, say, the
            // Undo after a delete).
            if (!document.querySelector(".Toastify__toast--error")) {
                toast.error("No solutions found / error occurred");
            }
        } finally {
            setScopedLoading("map", false);
            finishCalculation();
        }
    };

    const displayMap = useMemo(
        () => (
            <MapContainer
                center={WORLD_CENTER}
                zoom={worldZoom(window.innerWidth)}
                className={cn("w-[500px] h-[500px]", className)}
                ref={leafletMapContext.set}
                // @ts-expect-error Typing doesn't update from react-contextmenu
                contextmenu={true}
                contextmenuWidth={140}
                contextmenuItems={[
                    ...ADD_QUESTION_MENU_ITEMS,
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
                {/* A new layer per basemap: react-leaflet only updates a
                    layer's URL, not its zoom range or attribution. */}
                <Fragment key={$baseTileLayer}>
                    {getTileLayer($baseTileLayer, $thunderforestApiKey)}
                </Fragment>
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

    // Questions come from the game: none can be added before it has loaded.
    useEffect(() => {
        const contextmenu = (map as any)?.contextmenu;
        if (!contextmenu) return;
        ADD_QUESTION_MENU_ITEMS.forEach((_, item) => {
            contextmenu.setDisabled(item, !$compiledGame);
            // setDisabled only greys the item out; say why.
            const el: HTMLElement | undefined = contextmenu._items[item]?.el;
            if (!el) return;
            if ($compiledGame) {
                el.removeAttribute("title");
                el.removeAttribute("aria-disabled");
            } else {
                el.title = "Available once the game has loaded";
                el.setAttribute("aria-disabled", "true");
            }
        });
    }, [map, $compiledGame]);

    // Until a game has loaded, open on this tab's game, or the session being
    // restored, as last framed: a definition can take a while to load, or
    // fail to offline. Should the board turn out to be another game's (a join
    // link, another session picked) or nobody's (a new user), go back to the
    // world. Only such a restored view is reset: switching away from a game
    // that did load keeps its view until the next game loads, as before.
    useEffect(() => {
        if (!map) return;
        const provisional = provisionalViewRef.current;
        if (framedGameIdRef.current !== null && !provisional) return;
        const view = savedGameView($currentGameId, $activeSessionId);
        if (view && view.gameId === framedGameIdRef.current) return;
        if (view) {
            framedGameIdRef.current = view.gameId;
            provisionalViewRef.current = true;
            fitGameBounds(map, view.bounds);
        } else if (provisional) {
            framedGameIdRef.current = null;
            provisionalViewRef.current = false;
            map.setView(WORLD_CENTER, worldZoom(map.getSize().x), {
                animate: false,
            });
        }
    }, [map, $currentGameId, $activeSessionId, $lastGameView]);

    // Show each game when it loads; a new revision of the same game keeps
    // the view.
    useEffect(() => {
        if (!map || !$compiledGame) return;
        provisionalViewRef.current = false;
        if (framedGameIdRef.current !== $currentGameId) {
            framedGameIdRef.current = $currentGameId;
            fitGameBounds(map, $compiledGame.bounds);
        }
        if (!isGameBounds($compiledGame.bounds)) return;
        const session = activeSessionData.get();
        rememberGameView(
            $currentGameId,
            $compiledGame.bounds,
            session?.gameId === $currentGameId ? session.id : undefined,
        );
    }, [map, $compiledGame, $currentGameId]);

    // A session selected after its game loaded plays the framed game too.
    useEffect(() => {
        const view = lastGameView.get();
        if (!$activeSession || view?.gameId !== $activeSession.gameId) return;
        if (view.sessionId === $activeSession.id) return;
        rememberGameView(view.gameId, view.bounds, $activeSession.id);
    }, [$activeSession]);

    useEffect(() => {
        bootstrapDefaults();
    }, []);

    useEffect(() => {
        if (!map) return;
        const resizeObserver = new ResizeObserver(() => {
            map.invalidateSize({ pan: false });
            // Until a game is shown, keep the world filling the map, whose
            // width the sidebars settle after it is created.
            if (framedGameIdRef.current === null) {
                map.setView(WORLD_CENTER, worldZoom(map.getSize().x), {
                    animate: false,
                });
            }
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

        // Each warning shows once per Follow Me session.
        const warned = new Set<string>();
        const warnOnce = (message: string) => {
            if (warned.has(message)) return;
            warned.add(message);
            toast.warn(message);
        };
        geoWatchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                lastGpsFix.set({ lat, lng });
                if (followMeMarkerRef.current) {
                    followMeMarkerRef.current.setLatLng([lat, lng]);
                    followMeMarkerRef.current.setOpacity(1);
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
            (error) => {
                const action = geoErrorAction(
                    error.code,
                    lastGpsFix.get() !== null,
                );
                if (action === "stop") {
                    toast.error("Unable to access your location.");
                    followMe.set(false);
                } else if (action === "searching" && warned.size === 0) {
                    // Not again after "Lost your location".
                    warnOnce("Still looking for your location...");
                } else if (action === "lost") {
                    // New questions go back to the map centre, and the dot
                    // fades, until the next fix.
                    lastGpsFix.set(null);
                    followMeMarkerRef.current?.setOpacity(0.4);
                    warnOnce("Lost your location, still trying...");
                }
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
            lastGpsFix.set(null);
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
