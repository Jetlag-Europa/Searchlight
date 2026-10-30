import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import * as L from "leaflet";
import _ from "lodash";
import { SidebarCloseIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
} from "@/components/ui/sidebar-r";
import { compiledGameAtom } from "@/game-definition/store";
import { startCalculation } from "@/lib/calculating";
import { sidebarContextR as SidebarContext } from "@/lib/context";
import {
    acquireScopedLoading,
    animateMapMovements,
    autoZoom,
    disabledStations,
    displayHidingZones,
    displayHidingZonesStyle,
    gameDefinitionReady,
    hidingZoneFocusedStationID,
    hidingZoneScale,
    isLoading,
    leafletMapContext,
    perQuestionMapData,
    questionFinishedMapData,
    setDisabledStations,
    setScopedLoading,
    showZoneNames,
    trainStations,
} from "@/lib/context";
import { zoneLabelMinZoom } from "@/lib/games";
import { createLatestTask } from "@/lib/latestTask";
import { cn } from "@/lib/utils";
import { formatMultiplier } from "@/lib/zoneSize";
import { hidingZonesCalculated, zonesLeft } from "@/lib/zonesLeft";
import {
    extractStationLabel,
    extractStationName,
    hidingZoneLayer,
    lngLatToText,
    safeUnion,
    survivingHidingZones,
} from "@/maps/geo-utils";
import { filterZoneIndexes } from "@/maps/geo-utils/geometryClient";

import { IslandErrorBoundary } from "./IslandErrorBoundary";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "./ui/command";
import { Label } from "./ui/label";
import { ScrollToTop } from "./ui/scroll-to-top";
import { MENU_ITEM_CLASSNAME } from "./ui/sidebar-l";

let buttonJustClicked = false;

/** Take the zone sidebar's layers off the map. */
function removeZoneLayers(map: L.Map | null) {
    map?.eachLayer((layer: any) => {
        // Hopefully only geoJSON layers
        if (layer.hidingZones) map.removeLayer(layer);
    });
}

/** Reset what decides how zones are drawn, as Deselect Zone does. */
function resetZoneView() {
    hidingZoneFocusedStationID.set("");
    displayHidingZonesStyle.set("zones");
}

export const ZoneSidebar = () => (
    <IslandErrorBoundary
        name="zone sidebar"
        onError={() => {
            removeZoneLayers(leafletMapContext.get());
            // Nothing recalculates the zones until a retry, so the count
            // and the zone shortcuts would go stale.
            hidingZonesCalculated.set(false);
        }}
        onRetry={resetZoneView}
        fallback={(retry) => <ZoneSidebarFallback retry={retry} />}
    >
        <ZoneSidebarContent />
    </IslandErrorBoundary>
);

const ZoneSidebarContent = () => {
    const $displayHidingZones = useStore(displayHidingZones);
    const $questionFinishedMapData = useStore(questionFinishedMapData);
    const $perQuestionMapData = useStore(perQuestionMapData);
    const $hidingZoneScale = useStore(hidingZoneScale);
    const $displayHidingZonesStyle = useStore(displayHidingZonesStyle);
    const $isLoading = useStore(isLoading);
    const map = useStore(leafletMapContext);
    const stations = useStore(trainStations);
    const $disabledStations = useStore(disabledStations);
    const $compiledGame = useStore(compiledGameAtom);
    const $gameDefinitionReady = useStore(gameDefinitionReady);
    const hidingZoneModeStationID = useStore(hidingZoneFocusedStationID);
    const $showZoneNames = useStore(showZoneNames);
    const $zonesLeft = useStore(zonesLeft);
    const setHidingZoneModeStationID = hidingZoneFocusedStationID.set;
    const [stationSearch, setStationSearch] = useState<string>("");
    const isStationSearchActive = stationSearch.trim().length > 0;
    const setStations = trainStations.set;
    const sidebarRef = useRef<HTMLDivElement>(null);
    const zoneRefreshQueue = useMemo(() => createLatestTask(), []);
    const selectionTaskQueue = useMemo(() => createLatestTask(), []);

    // The game's hiding radius, for reference: zones take theirs from the
    // game, resized by any zone size change in the questions.
    const radiusLabel = useMemo(() => {
        const zones = ($compiledGame?.hidingZones.stations ?? []).filter(
            (zone) => !zone.area,
        );
        if (!$compiledGame || zones.length === 0) return null;
        const { value, unit } = $compiledGame.hidingZones.baseRadius;
        const varies = zones.some(
            (zone) =>
                zone.radius?.value !== value || zone.radius?.unit !== unit,
        );
        const scaled =
            $hidingZoneScale === 1
                ? `${value} ${unit}`
                : `${Number((value * $hidingZoneScale).toFixed(3))} ${unit} (${formatMultiplier($hidingZoneScale)})`;
        return `${scaled}${varies ? " (varies by zone)" : ""}`;
    }, [$compiledGame, $hidingZoneScale]);

    // Hide zone name labels when zoomed out too far to avoid overlap
    const LABEL_MIN_ZOOM = zoneLabelMinZoom($compiledGame?.size);
    useEffect(() => {
        if (!map || !$showZoneNames) {
            map?.getContainer().classList.remove("zone-labels-hidden");
            return;
        }

        const container = map.getContainer();
        const update = () => {
            if (map.getZoom() < LABEL_MIN_ZOOM) {
                container.classList.add("zone-labels-hidden");
            } else {
                container.classList.remove("zone-labels-hidden");
            }
        };

        map.on("zoomend", update);
        update();

        return () => {
            map.off("zoomend", update);
            container.classList.remove("zone-labels-hidden");
        };
    }, [map, $showZoneNames, LABEL_MIN_ZOOM]);

    const removeHidingZones = () => removeZoneLayers(map);

    const showGeoJSON = (
        geoJSONData: any,
        nonOverlappingStations: boolean = false,
        additionalOptions: L.GeoJSONOptions = {},
    ) => {
        if (!map) return;

        removeHidingZones();

        const geoJsonLayer = L.geoJSON(geoJSONData, {
            style: {
                color: "green",
                fillColor: "green",
                fillOpacity: 0.2,
            },
            onEachFeature: (feature, layer) => {
                if (nonOverlappingStations) {
                    layer.on("click", async () => {
                        if (!map) return;
                        setHidingZoneModeStationID(
                            feature.properties.properties.id,
                        );
                    });
                }
                if (
                    $showZoneNames &&
                    (feature.geometry?.type === "Polygon" ||
                        feature.geometry?.type === "MultiPolygon")
                ) {
                    const name =
                        feature.properties?.properties?.["name:en"] ||
                        feature.properties?.properties?.name ||
                        feature.properties?.["name:en"] ||
                        feature.properties?.name ||
                        "";
                    if (name) {
                        // Names come from the game definition: Leaflet renders
                        // a string as HTML, so pass it as text.
                        const label = document.createElement("span");
                        label.textContent = name;
                        (layer as L.Polygon).bindTooltip(label, {
                            permanent: true,
                            direction: "center",
                            className: "zone-name-label",
                        });
                    }
                }
            },
            pointToLayer(geoJsonPoint, latlng) {
                const marker = L.marker(latlng, {
                    icon: L.divIcon({
                        html: `<div class="text-black bg-opacity-0"><svg stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 448 512" width="1em" height="1em" xmlns="http://www.w3.org/2000/svg"><path d="M96 0C43 0 0 43 0 96L0 352c0 48 35.2 87.7 81.1 94.9l-46 46C28.1 499.9 33.1 512 43 512l39.7 0c8.5 0 16.6-3.4 22.6-9.4L160 448l128 0 54.6 54.6c6 6 14.1 9.4 22.6 9.4l39.7 0c10 0 15-12.1 7.9-19.1l-46-46c46-7.1 81.1-46.9 81.1-94.9l0-256c0-53-43-96-96-96L96 0zM64 96c0-17.7 14.3-32 32-32l256 0c17.7 0 32 14.3 32 32l0 96c0 17.7-14.3 32-32 32L96 224c-17.7 0-32-14.3-32-32l0-96zM224 288a48 48 0 1 1 0 96 48 48 0 1 1 0-96z"></path></svg></div>`,
                        className: "",
                    }),
                });

                const popup = document.createElement("b");
                popup.textContent = `${
                    extractStationName(geoJsonPoint) || "No Name Found"
                } (${lngLatToText(
                    geoJsonPoint.geometry.coordinates as [number, number],
                )})`;
                marker.bindPopup(popup);

                return marker;
            },
            ...additionalOptions,
        });

        // @ts-expect-error This is intentionally added as a check
        geoJsonLayer.hidingZones = true;

        geoJsonLayer.addTo(map);
    };

    useEffect(() => {
        if (!map) return;

        const initializeHidingZones = async (isCurrent: () => boolean) => {
            // Zones come from the game. Until its definition has been
            // applied (it may also fail to load), there are none to show.
            // applyGameDefinition flips gameDefinitionReady and re-runs this
            // effect with the game's zones.
            if (!$gameDefinitionReady || !$compiledGame) return;

            // Dodge-aware survival: a hider may move within their zone, so a zone
            // is valid as long as it overlaps EACH question's still-possible region
            // independently — not the (intersected) combined area. Two questions
            // that can each be dodged from a different edge of the same zone used to
            // wipe the zone off the map entirely. See DissapearingAct. Each
            // question tests the zones at the size they had when it was asked.
            return survivingHidingZones(
                $compiledGame,
                $perQuestionMapData,
                $hidingZoneScale,
                filterZoneIndexes,
                isCurrent,
            );
        };

        if ($displayHidingZones && $questionFinishedMapData) {
            void zoneRefreshQueue.request(async (isCurrent) => {
                setScopedLoading("zone", true);
                const finishCalculation = startCalculation("zones");
                try {
                    const circles = await initializeHidingZones(isCurrent);
                    if (isCurrent() && circles) {
                        setStations(circles);
                        hidingZonesCalculated.set(true);
                    }
                } catch (error) {
                    if (!isCurrent()) return;
                    console.error(
                        "Error in hiding zone initialization:",
                        error,
                    );
                    toast.error(
                        "An error occurred during hiding zone initialization",
                        { toastId: "hiding-zone-initialization-error" },
                    );
                } finally {
                    setScopedLoading("zone", false);
                    finishCalculation();
                }
            });
        } else if (!$displayHidingZones) {
            // Hidden zones aren't recalculated, so they go stale.
            hidingZonesCalculated.set(false);
        }
        return () => zoneRefreshQueue.cancel();
    }, [
        map,
        $questionFinishedMapData,
        $perQuestionMapData,
        $displayHidingZones,
        $compiledGame,
        $gameDefinitionReady,
        $hidingZoneScale,
    ]);

    useEffect(() => {
        if (!map) return;

        if ($displayHidingZones && hidingZoneModeStationID) {
            const hiderStation = _.find(
                stations,
                (c) => c.properties.properties.id === hidingZoneModeStationID,
            );

            if (hiderStation !== undefined) {
                const releaseLoading = acquireScopedLoading("zone:selection");
                void selectionTaskQueue.request(async (isCurrent) => {
                    try {
                        await selectionProcess(
                            hiderStation,
                            map,
                            showGeoJSON,
                            $questionFinishedMapData,
                            isCurrent,
                        );
                    } catch (error) {
                        if (!isCurrent()) return;
                        console.error("Error in hiding zone selection:", error);
                        toast.error(
                            "An error occurred during hiding zone selection",
                            { toastId: "hiding-zone-selection-error" },
                        );
                    } finally {
                        releaseLoading();
                    }
                });
                return () => {
                    selectionTaskQueue.cancel();
                    releaseLoading();
                };
            } else {
                toast.error("Invalid hiding zone selected", {
                    toastId: "hiding-zone-selection-error",
                });
            }
        }
        selectionTaskQueue.cancel();
    }, [
        map,
        $displayHidingZones,
        hidingZoneModeStationID,
        stations,
        $questionFinishedMapData,
    ]);

    useEffect(() => {
        if (!map) return;

        if ($displayHidingZones && !hidingZoneModeStationID) {
            const activeStations = stations.filter(
                (x) => !$disabledStations.includes(x.properties.properties.id),
            );
            try {
                showGeoJSON(
                    hidingZoneLayer(activeStations, $displayHidingZonesStyle),
                    $displayHidingZonesStyle === "zones",
                );
            } catch (error) {
                console.error("Error drawing hiding zones:", error);
                // A throw before showGeoJSON would leave the old zones up.
                removeHidingZones();
                toast.error("The hiding zones couldn't be drawn", {
                    toastId: "hiding-zone-display-error",
                });
            }
        } else if (!$displayHidingZones) {
            removeHidingZones();
        }
    }, [
        map,
        $disabledStations,
        $displayHidingZones,
        $displayHidingZonesStyle,
        $showZoneNames,
        hidingZoneModeStationID,
        stations,
    ]);
    // Unset when a question rules out the zone being viewed.
    const focusedStation = hidingZoneModeStationID
        ? stations.find(
              (x) => x.properties.properties.id === hidingZoneModeStationID,
          )
        : undefined;

    return (
        <Sidebar side="right">
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Hiding Zone</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden scale-x-[-1]"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent ref={sidebarRef}>
                <ScrollToTop element={sidebarRef} minHeight={500} />
                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            <SidebarMenuItem className={MENU_ITEM_CLASSNAME}>
                                <Label className="font-semibold font-poppins">
                                    Display hiding zones?
                                </Label>
                                <Checkbox
                                    defaultChecked={$displayHidingZones}
                                    checked={$displayHidingZones}
                                    onCheckedChange={displayHidingZones.set}
                                    disabled={$isLoading}
                                />
                            </SidebarMenuItem>
                            {$zonesLeft && (
                                <SidebarMenuItem
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "flex-col items-start gap-0",
                                    )}
                                >
                                    <span className="font-semibold font-poppins">
                                        {$zonesLeft.left} of {$zonesLeft.total}{" "}
                                        hiding zones left
                                    </span>
                                    {$zonesLeft.disabled > 0 && (
                                        <span className="text-sm text-muted-foreground">
                                            Not counting {$zonesLeft.disabled}{" "}
                                            disabled by hand
                                        </span>
                                    )}
                                </SidebarMenuItem>
                            )}
                            <SidebarMenuItem
                                className={cn(
                                    MENU_ITEM_CLASSNAME,
                                    "text-orange-500",
                                )}
                            >
                                Warning: This feature can drastically slow down
                                your device.
                            </SidebarMenuItem>
                            {radiusLabel && (
                                <SidebarMenuItem
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "justify-between",
                                    )}
                                >
                                    <Label className="font-semibold font-poppins">
                                        Hiding Zone Radius
                                    </Label>
                                    <div className="text-right">
                                        {radiusLabel}
                                    </div>
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-display",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Display
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("stations");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Stations
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set("zones");
                                    }}
                                    disabled={$isLoading}
                                >
                                    All Zones
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && stations.length > 0 && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setHidingZoneModeStationID("");
                                        displayHidingZonesStyle.set(
                                            "no-overlap",
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    No Overlap
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && focusedStation && (
                                <SidebarMenuItem
                                    className={cn(
                                        MENU_ITEM_CLASSNAME,
                                        "bg-popover hover:bg-accent",
                                    )}
                                    disabled={$isLoading}
                                >
                                    Current:{" "}
                                    {(() => {
                                        const displayName = extractStationLabel(
                                            focusedStation.properties,
                                        );
                                        const coords = focusedStation.properties
                                            .geometry.coordinates as [
                                            number,
                                            number,
                                        ];
                                        // The zone on a full map.
                                        const href = `https://www.openstreetmap.org/?mlat=${coords[1]}&mlon=${coords[0]}#map=17/${coords[1]}/${coords[0]}`;
                                        return (
                                            <a
                                                href={href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-blue-500"
                                            >
                                                {displayName}
                                            </a>
                                        );
                                    })()}
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones &&
                                stations.some((station) =>
                                    $disabledStations.includes(
                                        station.properties.properties.id,
                                    ),
                                ) && (
                                    <SidebarMenuItem
                                        className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                        onClick={() => {
                                            setDisabledStations([]);
                                        }}
                                        disabled={$isLoading}
                                    >
                                        Clear Disabled
                                    </SidebarMenuItem>
                                )}
                            {$displayHidingZones && (
                                <SidebarMenuItem
                                    className="bg-popover hover:bg-accent relative flex cursor-pointer gap-2 select-none items-center rounded-sm px-2 py-2.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected='true']:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                                    onClick={() => {
                                        setDisabledStations(
                                            stations.map(
                                                (x) =>
                                                    x.properties.properties.id,
                                            ),
                                        );
                                    }}
                                    disabled={$isLoading}
                                >
                                    Disable All
                                </SidebarMenuItem>
                            )}
                            {$displayHidingZones && (
                                <Command
                                    key={
                                        isStationSearchActive
                                            ? "station-search-active"
                                            : "station-search-idle"
                                    }
                                    shouldFilter={isStationSearchActive}
                                >
                                    <CommandInput
                                        placeholder="Search for a hiding zone..."
                                        value={stationSearch}
                                        onValueChange={setStationSearch}
                                        disabled={$isLoading}
                                    />
                                    <CommandList className="max-h-full">
                                        <CommandEmpty>
                                            No hiding zones found.
                                        </CommandEmpty>
                                        <CommandGroup>
                                            {stations.map((station) => (
                                                <CommandItem
                                                    key={
                                                        station.properties
                                                            .properties.id
                                                    }
                                                    data-station-id={
                                                        station.properties
                                                            .properties.id
                                                    }
                                                    className={cn(
                                                        $disabledStations.includes(
                                                            station.properties
                                                                .properties.id,
                                                        ) && "line-through",
                                                    )}
                                                    onSelect={async () => {
                                                        if (!map) return;

                                                        setTimeout(() => {
                                                            if (
                                                                buttonJustClicked
                                                            ) {
                                                                buttonJustClicked =
                                                                    false;
                                                                return;
                                                            }

                                                            if (
                                                                $disabledStations.includes(
                                                                    station
                                                                        .properties
                                                                        .properties
                                                                        .id,
                                                                )
                                                            ) {
                                                                setDisabledStations(
                                                                    [
                                                                        ...$disabledStations.filter(
                                                                            (
                                                                                x,
                                                                            ) =>
                                                                                x !==
                                                                                station
                                                                                    .properties
                                                                                    .properties
                                                                                    .id,
                                                                        ),
                                                                    ],
                                                                );
                                                            } else {
                                                                setDisabledStations(
                                                                    [
                                                                        ...$disabledStations,
                                                                        station
                                                                            .properties
                                                                            .properties
                                                                            .id,
                                                                    ],
                                                                );
                                                            }

                                                            setStations([
                                                                ...stations,
                                                            ]);
                                                        }, 100);
                                                    }}
                                                    disabled={$isLoading}
                                                >
                                                    {extractStationLabel(
                                                        station.properties,
                                                    )}
                                                    <button
                                                        onClick={async () => {
                                                            if (!map) return;

                                                            buttonJustClicked =
                                                                true;

                                                            setHidingZoneModeStationID(
                                                                station
                                                                    .properties
                                                                    .properties
                                                                    .id,
                                                            );
                                                        }}
                                                        className="bg-slate-600 p-0.5 rounded-md"
                                                        disabled={$isLoading}
                                                    >
                                                        View
                                                    </button>
                                                </CommandItem>
                                            ))}
                                        </CommandGroup>
                                    </CommandList>
                                </Command>
                            )}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
        </Sidebar>
    );
};

/** Shown in place of the sidebar once it has failed. */
function ZoneSidebarFallback({ retry }: { retry: () => void }) {
    return (
        <Sidebar side="right">
            <div className="flex items-center justify-between">
                <h2 className="ml-4 mt-4 font-poppins text-2xl">Hiding Zone</h2>
                <SidebarCloseIcon
                    className="mr-2 visible md:hidden scale-x-[-1]"
                    onClick={() => {
                        SidebarContext.get().setOpenMobile(false);
                    }}
                />
            </div>
            <SidebarContent>
                <div className="flex flex-col items-start gap-3 p-4">
                    <p className="font-semibold font-poppins">
                        The hiding zones couldn&apos;t be shown.
                    </p>
                    <p className="text-sm">
                        Something went wrong in the zone sidebar.
                    </p>
                    <Button onClick={retry}>Reset zone view</Button>
                    <p className="text-sm text-muted-foreground">
                        If this keeps happening, reload the page or{" "}
                        <a
                            href="https://github.com/Jetlag-Europa/Searchlight/issues/new/choose"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                        >
                            report it
                        </a>
                        .
                    </p>
                </div>
            </SidebarContent>
        </Sidebar>
    );
}

async function selectionProcess(
    station: any,
    map: L.Map,
    showGeoJSON: (geoJSONData: any) => void,
    $questionFinishedMapData: any,
    isCurrent: () => boolean,
) {
    const bbox = turf.bbox(station);

    const bounds: [[number, number], [number, number]] = [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
    ];

    const mapData = turf.featureCollection([
        safeUnion(
            turf.featureCollection([
                ...$questionFinishedMapData.features,
                turf.mask(station),
            ]),
        ),
    ]);

    if (!isCurrent()) return;
    showGeoJSON(mapData);
    if (autoZoom.get()) {
        if (animateMapMovements.get()) {
            map?.flyToBounds(bounds);
        } else {
            map?.fitBounds(bounds);
        }
    }

    if (!isCurrent()) return;
    const element: HTMLDivElement | null = document.querySelector(
        `[data-station-id="${station.properties.properties.id}"]`,
    );

    if (element) {
        element.scrollIntoView({
            behavior: "smooth",
            block: "center",
        });
        element.classList.add("selected-card-background-temporary");

        setTimeout(() => {
            element.classList.remove("selected-card-background-temporary");
        }, 5000);
    }
}
