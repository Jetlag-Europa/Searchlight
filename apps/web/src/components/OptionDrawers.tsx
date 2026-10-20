import { useStore } from "@nanostores/react";
import { resolveGameDefinitionId } from "@searchlight/shared";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { penToolbarVisible } from "@/annotations/hooks/useAnnotationStore";
import { InviteDrawer } from "@/components/InviteDrawer";
import { ShareDrawer } from "@/components/ShareDrawer";
import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@/components/ui/drawer";
import {
    activeGameDefinitionAtom,
    compiledGameAtom,
} from "@/game-definition/store";
import {
    allowGooglePlusCodes,
    animateMapMovements,
    autoLockQuestions,
    autoSave,
    autoZoom,
    baseTileLayer,
    customInitPreference,
    defaultCustomQuestions,
    defaultUnit,
    displayHidingZones,
    displayHidingZonesStyle,
    followMe,
    hiderMode,
    hidingZoneFocusedStationID,
    permanentOverlay,
    planningModeEnabled,
    save,
    showAllMatchingCells,
    showZoneNames,
    thunderforestApiKey,
    trainStations,
    triggerLocalRefresh,
    warningAlarm,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import { extractStationLabel } from "@/maps/geo-utils";

import { LatitudeLongitude, type LocalLocation } from "./LatLngPicker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select } from "./ui/select";
import { Separator } from "./ui/separator";
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "./ui/sidebar-l";
import { UnitSelect } from "./UnitSelect";

export const OptionDrawers = ({ className }: { className?: string }) => {
    useStore(triggerLocalRefresh);
    const $defaultCustomQuestions = useStore(defaultCustomQuestions);
    const $allowGooglePlusCodes = useStore(allowGooglePlusCodes);
    const $defaultUnit = useStore(defaultUnit);
    const $animateMapMovements = useStore(animateMapMovements);
    const $autoZoom = useStore(autoZoom);
    const $warningAlarm = useStore(warningAlarm);
    const $hiderMode = useStore(hiderMode);
    const $compiledGame = useStore(compiledGameAtom);
    // The hider starts at the game's centre, so hider mode needs the game.
    const hiderModeUnavailable = $hiderMode === false && !$compiledGame;
    const $trainStations = useStore(trainStations);
    const $autoSave = useStore(autoSave);
    const $planningMode = useStore(planningModeEnabled);
    const $showAllMatchingCells = useStore(showAllMatchingCells);
    const $baseTileLayer = useStore(baseTileLayer);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $autoLockQuestions = useStore(autoLockQuestions);
    const $followMe = useStore(followMe);
    const $customInitPref = useStore(customInitPreference);
    const $penToolbarVisible = useStore(penToolbarVisible);
    const $showZoneNames = useStore(showZoneNames);
    const [isOptionsOpen, setOptionsOpen] = useState(false);
    const [isNavOpen, setNavOpen] = useState(false);

    return (
        <div className={cn("flex flex-col items-end gap-2", className)}>
            {/* Always-visible All Zones button */}
            <Button
                className="w-32 shadow-md"
                onClick={() => {
                    setNavOpen(false);
                    hidingZoneFocusedStationID.set("");
                    if (!displayHidingZones.get()) {
                        displayHidingZones.set(true);
                    }
                    displayHidingZonesStyle.set("zones");
                }}
            >
                Deselect Zone
            </Button>

            {/* Collapsible section — stays mounted, animates height */}
            <div
                className={cn(
                    "grid transition-all duration-200 w-32",
                    isNavOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
            >
                <div className="min-h-0 overflow-hidden flex flex-col gap-2 pt-0 pb-0">
                    <Button
                        className="w-full shadow-md"
                        variant={$showZoneNames ? "default" : "outline"}
                        onClick={() => {
                            showZoneNames.set(!$showZoneNames);
                        }}
                    >
                        Zone Labels
                    </Button>
                    <a
                        href="https://github.com/Jetlag-Europa/Searchlight/issues/new/choose"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full"
                        onClick={() => setNavOpen(false)}
                    >
                        <Button className="w-full h-auto whitespace-normal py-2 leading-tight shadow-md">
                            Report a bug / suggest a feature
                        </Button>
                    </a>
                    <ShareDrawer
                        className="w-full shadow-md"
                        onOpen={() => setNavOpen(false)}
                    />
                    <InviteDrawer
                        className="w-full"
                        onOpen={() => setNavOpen(false)}
                    />
                    <Drawer
                        open={isOptionsOpen}
                        onOpenChange={(open) => {
                            setOptionsOpen(open);
                            if (open) setNavOpen(false);
                        }}
                    >
                        <DrawerTrigger className="w-full" asChild>
                            <Button className="w-full shadow-md">
                                Options
                            </Button>
                        </DrawerTrigger>
                        <DrawerContent aria-describedby={undefined}>
                            <div className="flex flex-col items-center gap-4 mb-4">
                                <DrawerHeader>
                                    <DrawerTitle className="text-4xl font-semibold font-poppins">
                                        Options
                                    </DrawerTitle>
                                </DrawerHeader>
                                <div className="overflow-y-scroll max-h-[40vh] flex flex-col items-center gap-4 max-w-[1000px] px-12">
                                    <div className="flex flex-row max-[330px]:flex-col gap-4">
                                        <Button
                                            variant="outline"
                                            onClick={() => {
                                                // Export the revision being
                                                // played (a session's pinned
                                                // one), not the game's latest.
                                                const def =
                                                    activeGameDefinitionAtom.get();
                                                if (!def) {
                                                    toast.error(
                                                        "No game definition is loaded",
                                                    );
                                                    return;
                                                }
                                                const gameId =
                                                    resolveGameDefinitionId(
                                                        def,
                                                    );
                                                try {
                                                    const blob = new Blob(
                                                        [
                                                            JSON.stringify(
                                                                def,
                                                                null,
                                                                2,
                                                            ),
                                                        ],
                                                        {
                                                            type: "application/json",
                                                        },
                                                    );
                                                    const url =
                                                        URL.createObjectURL(
                                                            blob,
                                                        );
                                                    const a =
                                                        document.createElement(
                                                            "a",
                                                        );
                                                    a.href = url;
                                                    a.download = `${gameId}.game.json`;
                                                    document.body.appendChild(
                                                        a,
                                                    );
                                                    a.click();
                                                    document.body.removeChild(
                                                        a,
                                                    );
                                                    URL.revokeObjectURL(url);
                                                    toast.success(
                                                        `Exported ${def.name || gameId} JSON`,
                                                    );
                                                } catch (err: any) {
                                                    toast.error(
                                                        err.message ||
                                                            "Failed to export game JSON",
                                                    );
                                                }
                                            }}
                                        >
                                            Export Game JSON
                                        </Button>
                                    </div>
                                    <Separator className="bg-slate-300 w-[280px]" />
                                    <Label>Default Unit</Label>
                                    <UnitSelect
                                        unit={$defaultUnit}
                                        onChange={defaultUnit.set}
                                    />
                                    <Separator className="bg-slate-300 w-[280px]" />
                                    <Label>Custom Points to Custom Zone</Label>
                                    <Select
                                        trigger="Custom Points to Custom Zone"
                                        options={{
                                            ask: "Ask each time",
                                            blank: "Start blank",
                                            prefill: "Copy from current",
                                        }}
                                        value={$customInitPref}
                                        onValueChange={(v) =>
                                            customInitPreference.set(v as any)
                                        }
                                    />
                                    <Separator className="bg-slate-300 w-[280px]" />
                                    <Label>Base map style</Label>
                                    <Select
                                        trigger="Base map style"
                                        options={{
                                            voyager: "CARTO Voyager",
                                            light: "CARTO Light",
                                            dark: "CARTO Dark",
                                            transport:
                                                "Thunderforest Transport",
                                            neighbourhood:
                                                "Thunderforest Neighbourhood",
                                            osmcarto: "OpenStreetMap Carto",
                                        }}
                                        value={$baseTileLayer}
                                        onValueChange={(v) =>
                                            baseTileLayer.set(v as any)
                                        }
                                    />
                                    <div className="flex flex-col items-center gap-2">
                                        <Label>Thunderforest API Key</Label>
                                        <Input
                                            type="text"
                                            value={$thunderforestApiKey}
                                            id="thunderforestApiKey"
                                            onChange={(e) =>
                                                thunderforestApiKey.set(
                                                    e.target.value,
                                                )
                                            }
                                            placeholder="Enter your Thunderforest API key"
                                        />
                                        <p className="text-xs text-gray-500">
                                            Needed for Thunderforest map styles.
                                            Create a key{" "}
                                            <a
                                                href="https://manage.thunderforest.com/users/sign_up?price=hobby-project-usd"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-blue-500 cursor-pointer"
                                            >
                                                here.
                                            </a>{" "}
                                            Don&apos;t worry, it&apos;s free.
                                        </p>
                                    </div>
                                    <Separator className="bg-slate-300 w-[280px]" />
                                    <Label>Permanent Map Overlay</Label>
                                    <div className="flex flex-row max-[330px]:flex-col gap-4">
                                        <Button
                                            onClick={() =>
                                                permanentOverlay.set(null)
                                            }
                                        >
                                            Remove
                                        </Button>
                                        <Button
                                            onClick={async () => {
                                                if (
                                                    !navigator ||
                                                    !navigator.clipboard
                                                )
                                                    return toast.error(
                                                        "Clipboard not supported",
                                                    );

                                                try {
                                                    const clipboard =
                                                        await navigator.clipboard.readText();
                                                    const geojson =
                                                        JSON.parse(clipboard);
                                                    permanentOverlay.set(
                                                        geojson,
                                                    );
                                                } catch (e) {
                                                    toast.error(
                                                        `Invalid GeoJSON overlay: ${e}`,
                                                    );
                                                }
                                            }}
                                        >
                                            Paste GeoJSON
                                        </Button>
                                    </div>
                                    <Separator className="bg-slate-300 w-[280px]" />
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Animate map movements?
                                        </label>
                                        <Checkbox
                                            checked={$animateMapMovements}
                                            onCheckedChange={() => {
                                                animateMapMovements.set(
                                                    !$animateMapMovements,
                                                );
                                            }}
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Enable planning mode?
                                        </label>
                                        <Checkbox
                                            checked={$planningMode}
                                            onCheckedChange={(checked) => {
                                                planningModeEnabled.set(
                                                    checked === true,
                                                );
                                            }}
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Show all matching cells when
                                            planning?
                                        </label>
                                        <Checkbox
                                            checked={$showAllMatchingCells}
                                            onCheckedChange={() =>
                                                showAllMatchingCells.set(
                                                    !$showAllMatchingCells,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Auto save?
                                        </label>
                                        <Checkbox
                                            checked={$autoSave}
                                            onCheckedChange={() =>
                                                autoSave.set(!$autoSave)
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins text-red-400">
                                            Warning alarm?
                                        </label>
                                        <Checkbox
                                            checked={$warningAlarm}
                                            onCheckedChange={() =>
                                                warningAlarm.set(!$warningAlarm)
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Auto zoom?
                                        </label>
                                        <Checkbox
                                            checked={$autoZoom}
                                            onCheckedChange={() =>
                                                autoZoom.set(!$autoZoom)
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Follow Me (GPS)?
                                        </label>
                                        <Checkbox
                                            checked={$followMe}
                                            onCheckedChange={() =>
                                                followMe.set(!$followMe)
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Default to custom questions?
                                        </label>
                                        <Checkbox
                                            checked={$defaultCustomQuestions}
                                            onCheckedChange={() =>
                                                defaultCustomQuestions.set(
                                                    !$defaultCustomQuestions,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Allow Google Plus codes?
                                        </label>
                                        <Checkbox
                                            checked={$allowGooglePlusCodes}
                                            onCheckedChange={() =>
                                                allowGooglePlusCodes.set(
                                                    !$allowGooglePlusCodes,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Show pen toolbar?
                                        </label>
                                        <Checkbox
                                            checked={$penToolbarVisible}
                                            onCheckedChange={() =>
                                                penToolbarVisible.set(
                                                    !$penToolbarVisible,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="flex flex-row items-center gap-2">
                                        <label className="text-2xl font-semibold font-poppins">
                                            Auto-lock questions?
                                        </label>
                                        <Checkbox
                                            checked={$autoLockQuestions}
                                            onCheckedChange={() =>
                                                autoLockQuestions.set(
                                                    !$autoLockQuestions,
                                                )
                                            }
                                        />
                                    </div>
                                    <div
                                        className="flex flex-row items-center gap-2"
                                        title={
                                            hiderModeUnavailable
                                                ? "Available once the game has loaded"
                                                : undefined
                                        }
                                    >
                                        <label className="text-2xl font-semibold font-poppins">
                                            Hider mode?
                                        </label>
                                        <Checkbox
                                            checked={!!$hiderMode}
                                            disabled={hiderModeUnavailable}
                                            onCheckedChange={() => {
                                                if ($hiderMode === false) {
                                                    if (!$compiledGame) return;
                                                    const { center } =
                                                        $compiledGame;
                                                    hiderMode.set({
                                                        latitude: center[1],
                                                        longitude: center[0],
                                                    });
                                                } else {
                                                    hiderMode.set(false);
                                                }
                                            }}
                                        />
                                    </div>
                                    {$hiderMode !== false && (
                                        <SidebarMenu>
                                            <LatitudeLongitude
                                                latitude={$hiderMode.latitude}
                                                longitude={$hiderMode.longitude}
                                                inlineEdit
                                                localLocations={
                                                    $trainStations.length > 0
                                                        ? $trainStations
                                                              .map((s) => {
                                                                  const name =
                                                                      extractStationLabel(
                                                                          s.properties,
                                                                      ) as string;
                                                                  const coords =
                                                                      s
                                                                          .properties
                                                                          .geometry
                                                                          .coordinates as [
                                                                          number,
                                                                          number,
                                                                      ];
                                                                  return {
                                                                      name,
                                                                      lat: coords[1],
                                                                      lng: coords[0],
                                                                  } satisfies LocalLocation;
                                                              })
                                                              .filter(
                                                                  (loc) =>
                                                                      loc.name,
                                                              )
                                                        : undefined
                                                }
                                                onChange={(
                                                    latitude,
                                                    longitude,
                                                ) => {
                                                    $hiderMode.latitude =
                                                        latitude ??
                                                        $hiderMode.latitude;
                                                    $hiderMode.longitude =
                                                        longitude ??
                                                        $hiderMode.longitude;

                                                    if ($autoSave) {
                                                        hiderMode.set({
                                                            ...$hiderMode,
                                                        });
                                                    } else {
                                                        triggerLocalRefresh.set(
                                                            Math.random(),
                                                        );
                                                    }
                                                }}
                                                label="Hider Location"
                                            />
                                            {!autoSave && (
                                                <SidebarMenuItem>
                                                    <SidebarMenuButton
                                                        className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500 mt-2"
                                                        onClick={save}
                                                    >
                                                        Save
                                                    </SidebarMenuButton>
                                                </SidebarMenuItem>
                                            )}
                                        </SidebarMenu>
                                    )}
                                </div>
                            </div>
                        </DrawerContent>
                    </Drawer>
                </div>
            </div>

            <Button
                className="w-32 shadow-md"
                onClick={() => setNavOpen((v) => !v)}
            >
                {isNavOpen ? (
                    <ChevronDown className="mr-2 h-4 w-4" />
                ) : (
                    <ChevronUp className="mr-2 h-4 w-4" />
                )}
                Menu
            </Button>
        </div>
    );
};
