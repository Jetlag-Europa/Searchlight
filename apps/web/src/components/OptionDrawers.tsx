import { useStore } from "@nanostores/react";
import { resolveGameDefinitionId } from "@searchlight/shared";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "react-toastify";

import { penToolbarVisible } from "@/annotations/hooks/useAnnotationStore";
import { InviteDrawer } from "@/components/InviteDrawer";
import { usePasteText } from "@/components/PasteFallback";
import { ShareDrawer } from "@/components/ShareDrawer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { formatGameExportJson } from "@/game-definition/export";
import { activeGameDefinitionAtom, compiledGameAtom } from "@/game-definition/store";
import { activeSessionData, sessionReadOnly } from "@/lib/activeSession";
import { activeLocalSession, isLocalBoard } from "@/lib/boardMode";
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
  googleMapType,
  hideGooglePlaces,
  hiderMode,
  hidingZoneFocusedStationID,
  mapMenuOpen,
  permanentOverlay,
  planningModeEnabled,
  questions,
  save,
  showGoogleTransit,
  showZoneNames,
  thunderforestApiKey,
  trainStations,
  triggerLocalRefresh,
  unsavedChanges,
  warningAlarm,
} from "@/lib/context";
import {
  GOOGLE_MAP_TYPES,
  googleMapsAvailable,
  googleMapsProblem,
  googleMapTypeOf,
  googleModuleFailed,
  googleStandingIn,
} from "@/lib/googleMaps";
import { questionConflicts, questionDecisionsPossible } from "@/lib/questionConflicts";
import { sameQuestionList } from "@/lib/questionMerge";
import {
  buildQuestionsFile,
  type ImportedQuestions,
  MAX_QUESTIONS_FILE_BYTES,
  parseQuestionsFile,
  questionsFileName,
} from "@/lib/questionsFile";
import { hasPendingQuestionSave } from "@/lib/sessionState";
import { cn } from "@/lib/utils";
import { extractStationLabel } from "@/maps/geo-utils";
import type { Questions } from "@/maps/schema";

import { LatitudeLongitude, type LocalLocation } from "./LatLngPicker";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select } from "./ui/select";
import { Separator } from "./ui/separator";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";
import { UnitSelect } from "./UnitSelect";

const downloadJson = (fileName: string, json: string) => {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const plural = (count: number) => `${count} question${count === 1 ? "" : "s"}`;

export const OptionDrawers = () => {
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
  const $baseTileLayer = useStore(baseTileLayer);
  const $googleMapsProblem = useStore(googleMapsProblem);
  const $googleStandingIn = useStore(googleStandingIn);
  const $googleModuleFailed = useStore(googleModuleFailed);
  const $googleMapType = useStore(googleMapType);
  const $showGoogleTransit = useStore(showGoogleTransit);
  const $hideGooglePlaces = useStore(hideGooglePlaces);
  // Google draws no lines or pins on the bare satellite photo.
  const googlePhotoOnly = googleMapTypeOf($googleMapType) === "satellite";
  const $thunderforestApiKey = useStore(thunderforestApiKey);
  const $autoLockQuestions = useStore(autoLockQuestions);
  const $followMe = useStore(followMe);
  const $customInitPref = useStore(customInitPreference);
  const $penToolbarVisible = useStore(penToolbarVisible);
  const $showZoneNames = useStore(showZoneNames);
  const $readOnly = useStore(sessionReadOnly);
  const $isLocalBoard = useStore(isLocalBoard);
  const $localSession = useStore(activeLocalSession);
  const googleMapsEnabled = googleMapsAvailable && !$isLocalBoard;
  const [isOptionsOpen, setOptionsOpen] = useState(false);
  const isNavOpen = useStore(mapMenuOpen);
  const setNavOpen = (open: boolean) => mapMenuOpen.set(open);
  const { readPaste, pasteDialog } = usePasteText();
  const $session = useStore(activeSessionData);
  const $exportSession = $isLocalBoard
    ? $localSession
      ? {
          name: $localSession.name,
          gameId: $localSession.gameId,
          gameName: $localSession.gameName,
          gameRevisionId: $localSession.gameId,
        }
      : null
    : $session;
  // As Restore: only a board whose edits are saved takes an import.
  const $canEditOnline = useStore(questionDecisionsPossible);
  const $canEdit = $isLocalBoard ? Boolean($localSession) : $canEditOnline;
  const importInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<
    | (ImportedQuestions & {
        replaces: {
          sessionId: string;
          gameRevisionId: string;
          questions: Questions;
        };
      })
    | null
  >(null);
  const replaced = questions.get().length;

  // What an import replaces: the session, its game revision and a snapshot
  // of the questions on the board (compared with sameQuestionList so
  // in-place edits are caught while reordered JSONB keys aren't). Null while
  // it can't be replaced.
  const importTarget = (clone = false) => {
    if (isLocalBoard.get()) {
      const local = activeLocalSession.get();
      if (!local) return null;
      const current = questions.get();
      return {
        sessionId: local.id,
        gameRevisionId: local.gameId,
        questions: clone ? structuredClone(current) : current,
      };
    }
    const session = activeSessionData.get();
    if (!session || !questionDecisionsPossible.get()) return null;
    const current = questions.get();
    return {
      sessionId: session.id,
      gameRevisionId: session.gameRevisionId,
      questions: clone ? structuredClone(current) : current,
    };
  };
  const readQuestionsFile = async (file: File) => {
    const local = isLocalBoard.get() ? activeLocalSession.get() : null;
    const session = isLocalBoard.get() ? null : activeSessionData.get();
    const compiled = compiledGameAtom.get();
    const replaces = importTarget(true);
    if ((!local && !session) || !compiled || replaces === null) {
      toast.error(
        compiled ? "This session can't take an import right now" : "The game has not loaded yet",
      );
      return;
    }
    if (session) {
      // Keeping a held version would put it onto the imported list, and
      // only what was saved is in the History to restore.
      if (questionConflicts.get().length > 0) {
        toast.error("Decide the questions that need a decision first");
        return;
      }
      if (hasPendingQuestionSave(session.id)) {
        toast.error("Your last changes aren't saved yet: try again once they are");
        return;
      }
    }
    // Before reading it: a file picked by mistake can be gigabytes.
    if (file.size > MAX_QUESTIONS_FILE_BYTES) {
      toast.error("That file is too big to import");
      return;
    }
    const result = parseQuestionsFile(
      await file.text().catch(() => ""),
      compiled,
      (local ?? session)!.gameId,
    );
    if ("error" in result) toast.error(result.error);
    else setImported({ ...result, replaces });
  };
  const importQuestions = () => {
    if (!imported) return;
    // The file was checked against the board as it was when picked, and
    // the confirm said what it replaces.
    const current = importTarget();
    const onlineBlocked =
      !isLocalBoard.get() &&
      (() => {
        const session = activeSessionData.get();
        return !session || questionConflicts.get().length > 0 || hasPendingQuestionSave(session.id);
      })();
    if (
      !current ||
      current.sessionId !== imported.replaces.sessionId ||
      current.gameRevisionId !== imported.replaces.gameRevisionId ||
      !sameQuestionList(current.questions, imported.replaces.questions) ||
      onlineBlocked
    ) {
      toast.error("The session changed meanwhile: nothing was imported");
      return;
    }
    questions.set(imported.questions);
    toast.success(`Imported ${plural(imported.questions.length)}`);
  };

  return (
    <div className="flex flex-col items-end gap-2">
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
          <ShareDrawer className="w-full shadow-md" onOpen={() => setNavOpen(false)} />
          <InviteDrawer className="w-full" onOpen={() => setNavOpen(false)} />
          <Drawer
            open={isOptionsOpen}
            onOpenChange={(open) => {
              setOptionsOpen(open);
              if (open) setNavOpen(false);
            }}
          >
            <DrawerTrigger className="w-full" asChild>
              <Button className="w-full shadow-md">Options</Button>
            </DrawerTrigger>
            <DrawerContent aria-describedby={undefined}>
              <div className="flex flex-col items-center gap-4 mb-4">
                <DrawerHeader>
                  <DrawerTitle className="text-4xl font-semibold font-poppins">Options</DrawerTitle>
                </DrawerHeader>
                <div className="overflow-y-scroll max-h-[40vh] flex flex-col items-center gap-4 max-w-[1000px] px-12">
                  <div className="flex flex-row flex-wrap justify-center max-[330px]:flex-col gap-4">
                    <Button
                      variant="outline"
                      onClick={() => {
                        // Export the revision being
                        // played (a session's pinned
                        // one), not the game's latest.
                        const def = activeGameDefinitionAtom.get();
                        if (!def) {
                          toast.error("No game definition is loaded");
                          return;
                        }
                        const gameId = resolveGameDefinitionId(def);
                        try {
                          downloadJson(`${gameId}.game.json`, formatGameExportJson(def, gameId));
                          toast.success(`Exported ${def.name || gameId} JSON`);
                        } catch (err: any) {
                          toast.error(err.message || "Failed to export game JSON");
                        }
                      }}
                    >
                      Export Game JSON
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!$exportSession}
                      onClick={() => {
                        if (!$exportSession) return;
                        if (!questions.get().length) {
                          toast.error("This session has no questions to export");
                          return;
                        }
                        downloadJson(
                          questionsFileName($exportSession.name),
                          JSON.stringify(buildQuestionsFile($exportSession, questions.get())),
                        );
                        toast.success(`Exported ${plural(questions.get().length)}`);
                      }}
                    >
                      Export Questions
                    </Button>
                    {!$readOnly && (
                      <Button
                        variant="outline"
                        disabled={!$canEdit || !$compiledGame}
                        onClick={() => importInput.current?.click()}
                      >
                        Import Questions
                      </Button>
                    )}
                    <input
                      ref={importInput}
                      type="file"
                      accept=".json,application/json"
                      hidden
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void readQuestionsFile(file);
                      }}
                    />
                    {imported && (
                      <AlertDialog open onOpenChange={() => setImported(null)}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Import questions?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {replaced > 0
                                ? `Replace the ${plural(replaced)} in this session with ${plural(imported.questions.length)}`
                                : `Add ${plural(imported.questions.length)}`}{" "}
                              from{" "}
                              {imported.sessionName ? `“${imported.sessionName}”` : "this file"}?
                              {replaced > 0 &&
                                !$isLocalBoard &&
                                " The replaced ones can be restored from the History."}
                              {replaced > 0 &&
                                !$isLocalBoard &&
                                !$autoSave &&
                                " Auto save is off: changes you haven't saved are replaced too, and those aren't in the History."}
                              {imported.skipped > 0 &&
                                ` ${plural(imported.skipped)} in the file can't be used here and will be left out.`}
                              {imported.otherGame !== null &&
                                ` The file was exported from another game${imported.otherGame && ` (${imported.otherGame})`}.`}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={importQuestions}>
                              Import Questions
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                  <Separator className="bg-slate-300 w-[280px]" />
                  <Label>Default Unit</Label>
                  <UnitSelect unit={$defaultUnit} onChange={defaultUnit.set} />
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
                    onValueChange={(v) => customInitPreference.set(v as any)}
                  />
                  <Separator className="bg-slate-300 w-[280px]" />
                  <Label>Base map style</Label>
                  <Select
                    trigger="Base map style"
                    options={{
                      voyager: "CARTO Voyager",
                      light: "CARTO Light",
                      dark: "CARTO Dark",
                      transport: "Thunderforest Transport",
                      neighbourhood: "Thunderforest Neighbourhood",
                      osmcarto: "OpenStreetMap Carto",
                      ...(googleMapsEnabled && {
                        google: "Google Maps",
                      }),
                    }}
                    // A build without a Google key, or local
                    // mode, draws CARTO Voyager instead.
                    value={
                      $baseTileLayer === "google" && !googleMapsEnabled ? "voyager" : $baseTileLayer
                    }
                    onValueChange={(v) => baseTileLayer.set(v as any)}
                  />
                  {/* Google Maps Platform Terms 3.2.2(a). */}
                  {googleMapsEnabled && (
                    <p className="text-xs text-muted-foreground max-w-[280px] text-center">
                      Searchlight includes Google Maps features and content. Their use is subject to
                      the{" "}
                      <a
                        href="https://maps.google.com/help/terms_maps/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 cursor-pointer"
                      >
                        Google Maps/Google Earth Additional Terms of Service
                      </a>{" "}
                      and the{" "}
                      <a
                        href="https://policies.google.com/privacy"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 cursor-pointer"
                      >
                        Google Privacy Policy
                      </a>
                      .
                    </p>
                  )}
                  {$baseTileLayer === "google" && googleMapsEnabled && (
                    <>
                      <Label>Google Maps view</Label>
                      <Select
                        trigger="Google Maps view"
                        options={GOOGLE_MAP_TYPES}
                        value={googleMapTypeOf($googleMapType)}
                        onValueChange={(v) => googleMapType.set(v)}
                      />
                      <div className="flex flex-row items-center gap-2">
                        <label
                          htmlFor="showGoogleTransit"
                          className={cn("text-sm font-medium", googlePhotoOnly && "opacity-50")}
                        >
                          Show transit lines
                        </label>
                        <Checkbox
                          id="showGoogleTransit"
                          disabled={googlePhotoOnly}
                          checked={$showGoogleTransit}
                          onCheckedChange={() => showGoogleTransit.set(!$showGoogleTransit)}
                        />
                      </div>
                      <div className="flex flex-row items-center gap-2">
                        <label
                          htmlFor="hideGooglePlaces"
                          className={cn("text-sm font-medium", googlePhotoOnly && "opacity-50")}
                        >
                          Hide shops and places
                        </label>
                        <Checkbox
                          id="hideGooglePlaces"
                          disabled={googlePhotoOnly}
                          checked={$hideGooglePlaces}
                          onCheckedChange={() => hideGooglePlaces.set(!$hideGooglePlaces)}
                        />
                      </div>
                      {googlePhotoOnly && (
                        <p className="text-xs text-muted-foreground max-w-[280px] text-center">
                          Satellite is the photo alone. Hybrid adds streets, names and transit lines
                          to it.
                        </p>
                      )}
                    </>
                  )}
                  {$baseTileLayer === "google" && googleMapsEnabled && $googleMapsProblem && (
                    <p className="text-xs text-muted-foreground max-w-[280px] text-center">
                      {$googleMapsProblem === "offline"
                        ? "Google Maps needs a connection. Showing CARTO Voyager until you're back online."
                        : $googleMapsProblem === "load-failed"
                          ? "Google Maps couldn't load. Showing CARTO Voyager; reload the page to try again."
                          : "Google Maps refused this site's key. Showing CARTO Voyager."}
                    </p>
                  )}
                  {$baseTileLayer === "google" &&
                    googleMapsEnabled &&
                    !$googleMapsProblem &&
                    $googleStandingIn && (
                      <p className="text-xs text-muted-foreground max-w-[280px] text-center">
                        {$googleModuleFailed
                          ? "Part of Google Maps couldn't load, so it may not draw. Showing CARTO Voyager; reload the page to try again."
                          : "Google Maps is still loading. Showing CARTO Voyager until it has drawn."}
                      </p>
                    )}
                  <div className="flex flex-col items-center gap-2">
                    <Label>Thunderforest API Key</Label>
                    <Input
                      type="text"
                      value={$thunderforestApiKey}
                      id="thunderforestApiKey"
                      onChange={(e) => thunderforestApiKey.set(e.target.value)}
                      placeholder="Enter your Thunderforest API key"
                    />
                    <p className="text-xs text-muted-foreground">
                      Needed for Thunderforest map styles. Create a key{" "}
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
                    <Button onClick={() => permanentOverlay.set(null)}>Remove</Button>
                    <Button
                      onClick={async () => {
                        const text = await readPaste({
                          title: "Paste GeoJSON overlay",
                          placeholder: "A GeoJSON FeatureCollection",
                        });
                        if (text === null) return;

                        try {
                          const geojson = JSON.parse(text);
                          permanentOverlay.set(geojson);
                        } catch (e) {
                          toast.error(`Invalid GeoJSON overlay: ${e}`);
                        }
                      }}
                    >
                      Paste GeoJSON
                    </Button>
                    {pasteDialog}
                  </div>
                  <Separator className="bg-slate-300 w-[280px]" />
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">
                      Animate map movements?
                    </label>
                    <Checkbox
                      checked={$animateMapMovements}
                      onCheckedChange={() => {
                        animateMapMovements.set(!$animateMapMovements);
                      }}
                    />
                  </div>
                  {/* Planning mode is the session's: a
                                        spectator sees it as its players set
                                        it, and is told so (phones show no
                                        hover title). */}
                  <div className="flex flex-col items-center gap-1">
                    <div className="flex flex-row items-center gap-2">
                      <label className="text-2xl font-semibold font-poppins">
                        Enable planning mode?
                      </label>
                      <Checkbox
                        checked={$planningMode}
                        disabled={$readOnly}
                        onCheckedChange={(checked) => {
                          planningModeEnabled.set(checked === true);
                        }}
                      />
                    </div>
                    {$readOnly && (
                      <p className="text-xs text-muted-foreground">
                        Set by the players: spectators can&apos;t change it.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">Auto save?</label>
                    <Checkbox
                      checked={$autoSave}
                      onCheckedChange={() => autoSave.set(!$autoSave)}
                    />
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins text-red-400">
                      Warning alarm?
                    </label>
                    <Checkbox
                      checked={$warningAlarm}
                      onCheckedChange={() => warningAlarm.set(!$warningAlarm)}
                    />
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">Auto zoom?</label>
                    <Checkbox
                      checked={$autoZoom}
                      onCheckedChange={() => autoZoom.set(!$autoZoom)}
                    />
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">Follow Me (GPS)?</label>
                    <Checkbox
                      checked={$followMe}
                      onCheckedChange={() => followMe.set(!$followMe)}
                    />
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">
                      Default to custom questions?
                    </label>
                    <Checkbox
                      checked={$defaultCustomQuestions}
                      onCheckedChange={() => defaultCustomQuestions.set(!$defaultCustomQuestions)}
                    />
                  </div>
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">
                      Allow Google Plus codes?
                    </label>
                    <Checkbox
                      checked={$allowGooglePlusCodes}
                      onCheckedChange={() => allowGooglePlusCodes.set(!$allowGooglePlusCodes)}
                    />
                  </div>
                  {/* Spectators can't draw, so they get
                                        no pen toolbar. */}
                  {!$readOnly && (
                    <div className="flex flex-row items-center gap-2">
                      <label className="text-2xl font-semibold font-poppins">
                        Show pen toolbar?
                      </label>
                      <Checkbox
                        checked={$penToolbarVisible}
                        onCheckedChange={() => penToolbarVisible.set(!$penToolbarVisible)}
                      />
                    </div>
                  )}
                  <div className="flex flex-row items-center gap-2">
                    <label className="text-2xl font-semibold font-poppins">
                      Auto-lock questions?
                    </label>
                    <Checkbox
                      checked={$autoLockQuestions}
                      onCheckedChange={() => autoLockQuestions.set(!$autoLockQuestions)}
                    />
                  </div>
                  {/* Spectators never see the hider. */}
                  {!$readOnly && (
                    <div
                      className="flex flex-row items-center gap-2"
                      title={
                        hiderModeUnavailable ? "Available once the game has loaded" : undefined
                      }
                    >
                      <label className="text-2xl font-semibold font-poppins">Hider mode?</label>
                      <Checkbox
                        checked={!!$hiderMode}
                        disabled={hiderModeUnavailable}
                        onCheckedChange={() => {
                          if ($hiderMode === false) {
                            if (!$compiledGame) return;
                            const { center } = $compiledGame;
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
                  )}
                  {$hiderMode !== false && !$readOnly && (
                    <SidebarMenu>
                      <LatitudeLongitude
                        latitude={$hiderMode.latitude}
                        longitude={$hiderMode.longitude}
                        inlineEdit
                        localLocations={
                          $trainStations.length > 0
                            ? $trainStations
                                .map((s) => {
                                  const name = extractStationLabel(s.properties) as string;
                                  const coords = s.properties.geometry.coordinates as [
                                    number,
                                    number,
                                  ];
                                  return {
                                    name,
                                    lat: coords[1],
                                    lng: coords[0],
                                  } satisfies LocalLocation;
                                })
                                .filter((loc) => loc.name)
                            : undefined
                        }
                        onChange={(latitude, longitude) => {
                          $hiderMode.latitude = latitude ?? $hiderMode.latitude;
                          $hiderMode.longitude = longitude ?? $hiderMode.longitude;

                          if ($autoSave) {
                            hiderMode.set({
                              ...$hiderMode,
                            });
                          } else {
                            triggerLocalRefresh.set(Math.random());
                            unsavedChanges.set(true);
                          }
                        }}
                        label="Hider Location"
                      />
                      {!$autoSave && (
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

      <Button className="w-32 shadow-md" onClick={() => setNavOpen(!isNavOpen)}>
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
