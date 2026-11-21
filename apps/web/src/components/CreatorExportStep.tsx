import type { GameDefinition, HidingZoneFeature } from "@searchlight/shared";
import { AlertTriangle, Download, Play, UploadCloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { CompiledGame } from "@/game-definition/compile";
import { formatFileSize, type QualityIssue } from "@/game-definition/inspect";
import type { CreatorGeometryLayer, PreservedGameMetadata } from "@/lib/creator/assemble";
import { suggestSingularLayerName } from "@/lib/creator/importFile";
import { type KmlFolderPlanResult, MY_MAPS_MOBILE_MAX_LAYERS } from "@/lib/creator/kml";
import { cn } from "@/lib/utils";

interface Props {
  assembled: {
    definition: GameDefinition | null;
    compiled: CompiledGame | null;
    validationErrors: string[];
    jsonSize: number;
  };
  activeStationCount: number;
  extraHidingZones: readonly HidingZoneFeature[];
  activeLayerCount: number;
  fileStem: string;
  customId: string;
  setCustomId: (val: string) => void;
  preservedMetadata: PreservedGameMetadata | null;
  setPreservedMetadata: (val: PreservedGameMetadata | null) => void;
  checkingQuality: boolean;
  qualityIssues: readonly QualityIssue[];
  handleDecodeAllEntities: () => void;
  handleQuickSimplifyLayer: (targetName: string, tolerance?: number) => void;
  handleQuickSingularizeLayer: (targetName: string) => void;
  launchingAction: "local" | "import" | null;
  assemblyPending: boolean;
  handleTestLocally: () => Promise<void>;
  handleDownloadJson: () => void;
  handleDownloadKml: () => void;
  handleDownloadSingleKmlFolder: (folderName: string) => void;
  handleImportToSearchlight: () => Promise<void>;
  maxKmlLayers: number;
  setMaxKmlLayers: (val: number) => void;
  includePlayAreaKml: boolean;
  setIncludePlayAreaKml: (val: boolean) => void;
  includeCirclesKml: boolean;
  setIncludeCirclesKml: (val: boolean) => void;
  kmlPlan: KmlFolderPlanResult | null;
  showKmlGrouping: boolean;
  setShowKmlGrouping: React.Dispatch<React.SetStateAction<boolean>>;
  layers: readonly CreatorGeometryLayer[];
  setLayers: React.Dispatch<React.SetStateAction<CreatorGeometryLayer[]>>;
  newFolderForLayer: string | null;
  setNewFolderForLayer: (val: string | null) => void;
  newFolderDraft: string;
  setNewFolderDraft: (val: string) => void;
}

export function CreatorExportStep({
  assembled,
  activeStationCount,
  extraHidingZones,
  activeLayerCount,
  fileStem,
  customId,
  setCustomId,
  preservedMetadata,
  setPreservedMetadata,
  checkingQuality,
  qualityIssues,
  handleDecodeAllEntities,
  handleQuickSimplifyLayer,
  handleQuickSingularizeLayer,
  launchingAction,
  assemblyPending,
  handleTestLocally,
  handleDownloadJson,
  handleDownloadKml,
  handleDownloadSingleKmlFolder,
  handleImportToSearchlight,
  maxKmlLayers,
  setMaxKmlLayers,
  includePlayAreaKml,
  setIncludePlayAreaKml,
  includeCirclesKml,
  setIncludeCirclesKml,
  kmlPlan,
  showKmlGrouping,
  setShowKmlGrouping,
  layers,
  setLayers,
  newFolderForLayer,
  setNewFolderForLayer,
  newFolderDraft,
  setNewFolderDraft,
}: Props) {
  const def = assembled.definition;
  const compiled = assembled.compiled;

  const folderChoices = Array.from(
    new Set([
      ...layers.map((l) => l.kmlFolder?.trim()).filter((v): v is string => Boolean(v)),
      "Public Amenities",
      "Places of Interest",
      "Nature & Leisure",
    ]),
  );
  const anyExplicitFolder = layers.some((l) => Boolean(l.kmlFolder));
  const setLayerFolder = (layerName: string, nextFolder: string | undefined) => {
    setLayers((prev) =>
      prev.map((l) =>
        l.selected && l.name.trim() === layerName ? { ...l, kmlFolder: nextFolder } : l,
      ),
    );
  };

  return (
    <>
      {assembled.validationErrors.length > 0 && (
        <div className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
          <p className="font-semibold">Finish these before exporting:</p>
          <ul className="list-disc pl-4">
            {assembled.validationErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {def && compiled && (
        <>
          <section className="space-y-2 rounded-lg border border-border bg-background/40 p-3 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">{def.name}</span>
              <span className="font-mono text-muted-foreground">
                {formatFileSize(assembled.jsonSize)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
              <span>{activeStationCount + extraHidingZones.length} hiding zones</span>
              <span>{activeLayerCount} feature layers</span>
              <span>{compiled.questions.length} questions</span>
            </div>
            <div className="pt-1">
              <Label htmlFor="creator-custom-id" className="text-[11px] text-muted-foreground">
                Game ID (filename & permanent key)
              </Label>
              <Input
                id="creator-custom-id"
                placeholder={fileStem}
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                className="mt-1 h-8 font-mono text-xs"
              />
            </div>
            {(preservedMetadata?.visibility ||
              (preservedMetadata?.serverId && preservedMetadata.serverId !== "home-games")) && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 text-[11px] text-muted-foreground">
                <span>
                  Preserving loaded server & access metadata ({preservedMetadata.serverId}
                  {preservedMetadata.visibility ? `, ${preservedMetadata.visibility.kind}` : ""}
                  ).
                </span>
                <button
                  type="button"
                  onClick={() => setPreservedMetadata(null)}
                  className="shrink-0 font-medium text-primary hover:underline"
                >
                  Export as casual copy
                </button>
              </div>
            )}
          </section>

          {/* Questions preview */}
          <section className="space-y-1.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Questions players will see ({compiled.questions.length})
            </h2>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-border bg-background/40 p-2 text-xs">
              {compiled.questions.length === 0 ? (
                <p className="text-muted-foreground">Custom questions only.</p>
              ) : (
                <ul className="space-y-0.5">
                  {compiled.questions.map((q) => (
                    <li key={q.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{q.label}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {q.family}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Quality checks from check-game.mjs */}
          {checkingQuality && (
            <p className="text-xs text-muted-foreground">Running game quality checks…</p>
          )}
          {!checkingQuality && qualityIssues.length > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Quality checks ({qualityIssues.length})
                </h2>
                {qualityIssues.some((i) => i.code === "escaped-name") && (
                  <button
                    type="button"
                    onClick={handleDecodeAllEntities}
                    className="text-[11px] font-medium text-primary hover:underline"
                  >
                    Decode all entities
                  </button>
                )}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto">
                {qualityIssues.map((issue, idx) => {
                  const featMatch = issue.path.match(/^\/features\/(\d+)\b/);
                  const targetLayerName = featMatch
                    ? def.features?.[Number(featMatch[1])]?.name
                    : undefined;
                  const suggestedSingular =
                    issue.code === "plural-layer-name" && targetLayerName
                      ? suggestSingularLayerName(targetLayerName)
                      : null;
                  const pathLabel =
                    targetLayerName ??
                    (issue.path.startsWith("/hidingZones")
                      ? "Stations"
                      : issue.path.startsWith("/map")
                        ? "Play area"
                        : null);

                  return (
                    <div
                      key={idx}
                      className={cn(
                        "space-y-1 rounded-md border px-2 py-1.5 text-xs",
                        issue.level === "error"
                          ? "border-destructive/50 bg-destructive/10 text-destructive"
                          : issue.level === "warning"
                            ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                            : "border-border bg-muted/40 text-muted-foreground",
                      )}
                    >
                      <div>
                        <span className="mr-1 font-semibold uppercase">
                          {issue.strict ? "defect" : issue.level}
                        </span>
                        {pathLabel && (
                          <span className="mr-1 font-medium text-foreground">[{pathLabel}]</span>
                        )}
                        {issue.message}
                      </div>
                      {issue.code === "heavy-geometry" &&
                        issue.level === "warning" &&
                        targetLayerName && (
                          <button
                            type="button"
                            onClick={() => handleQuickSimplifyLayer(targetLayerName, 10)}
                            className="text-[11px] font-medium text-primary hover:underline"
                          >
                            Simplify &ldquo;
                            {targetLayerName}&rdquo; (10 m, topology-preserving)
                          </button>
                        )}
                      {suggestedSingular &&
                        suggestedSingular !== targetLayerName &&
                        targetLayerName && (
                          <button
                            type="button"
                            onClick={() => handleQuickSingularizeLayer(targetLayerName)}
                            className="text-[11px] font-medium text-primary hover:underline"
                          >
                            Rename to &ldquo;
                            {suggestedSingular}
                            &rdquo;
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <Separator />

          {/* Primary actions */}
          <section className="space-y-2.5">
            <Button
              type="button"
              className="w-full"
              disabled={Boolean(launchingAction) || assemblyPending}
              onClick={() => void handleTestLocally()}
            >
              <Play className="mr-2 h-4 w-4" />
              {launchingAction === "local" ? "Opening Local Play…" : "Test locally in Searchlight"}
            </Button>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={assemblyPending}
                onClick={handleDownloadJson}
              >
                <Download className="mr-1.5 h-4 w-4" />
                .game.json
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={assemblyPending}
                onClick={handleDownloadKml}
              >
                <Download className="mr-1.5 h-4 w-4" />
                .kml (My Maps)
              </Button>
            </div>

            {/* KML options & mobile 9-layer grouping planner */}
            <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-muted-foreground">Google My Maps KML</p>
                <div className="flex items-center gap-1.5">
                  <Label
                    htmlFor="creator-kml-max-layers"
                    className="text-[11px] text-muted-foreground"
                  >
                    Max layers
                  </Label>
                  <Input
                    id="creator-kml-max-layers"
                    type="number"
                    min={1}
                    max={10}
                    value={maxKmlLayers}
                    onChange={(e) =>
                      setMaxKmlLayers(
                        Math.max(
                          1,
                          Math.min(10, Number(e.target.value) || MY_MAPS_MOBILE_MAX_LAYERS),
                        ),
                      )
                    }
                    className="h-7 w-14 text-center text-xs"
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Mobile Google Maps displays up to 9 layers. Lower this to leave room for manual
                layers (e.g. train lines).
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox
                    checked={includePlayAreaKml}
                    onCheckedChange={(v) => setIncludePlayAreaKml(v === true)}
                  />
                  <span>Play Area</span>
                </label>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <Checkbox
                    checked={includeCirclesKml}
                    onCheckedChange={(v) => setIncludeCirclesKml(v === true)}
                  />
                  <span>Hiding zone circles</span>
                </label>
              </div>

              {kmlPlan && (
                <div className="space-y-1.5 border-t border-border pt-2">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {kmlPlan.totalFolders}/{maxKmlLayers} layers
                    </span>
                    {(def.features?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowKmlGrouping((v) => !v)}
                        className="font-medium text-primary hover:underline"
                      >
                        {showKmlGrouping ? "Done" : "Edit folders"}
                      </button>
                    )}
                  </div>

                  <ol className="space-y-0.5 text-[11px]">
                    {kmlPlan.folders.map((f, idx) => (
                      <li
                        key={`${f.name}-${idx}`}
                        className="flex items-baseline justify-between gap-2"
                      >
                        <span className="truncate">
                          <span className="mr-1 font-mono text-muted-foreground">{idx + 1}.</span>
                          <span className="font-medium">{f.name}</span>
                          {f.layerNames.length > 1 && (
                            <span className="ml-1 text-muted-foreground">
                              ({f.layerNames.join(", ")})
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {f.featureCount}
                          </span>
                          <button
                            type="button"
                            disabled={assemblyPending}
                            title={`Download "${f.name}" as a single-layer .kml (for Google My Maps Replace all)`}
                            aria-label={`Download ${f.name} KML`}
                            onClick={() => handleDownloadSingleKmlFolder(f.name)}
                            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                          >
                            <Download className="h-3 w-3" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ol>

                  {showKmlGrouping && (def.features?.length ?? 0) > 0 && (
                    <div className="space-y-1.5 rounded border border-border bg-card p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium">
                          KML folder per layer (saved in .game.json)
                        </span>
                        {anyExplicitFolder && (
                          <button
                            type="button"
                            onClick={() =>
                              setLayers((prev) =>
                                prev.map((l) => ({
                                  ...l,
                                  kmlFolder: undefined,
                                })),
                              )
                            }
                            className="text-[11px] text-primary hover:underline"
                          >
                            Reset to auto
                          </button>
                        )}
                      </div>
                      <div className="max-h-48 space-y-1.5 overflow-y-auto">
                        {def.features?.map((feat) => {
                          const sourceLayer = layers.find(
                            (l) => l.selected && l.name.trim() === feat.name,
                          );
                          const explicit = sourceLayer?.kmlFolder?.trim();
                          const selectValue = !explicit
                            ? "__auto__"
                            : explicit === feat.name
                              ? "__own__"
                              : explicit;
                          const isCreating = newFolderForLayer === feat.name;
                          return (
                            <div key={feat.name} className="space-y-1">
                              <div className="grid grid-cols-2 items-center gap-1.5">
                                <span className="truncate text-[11px]">{feat.name}</span>
                                <select
                                  aria-label={`KML folder for ${feat.name}`}
                                  value={selectValue}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    if (val === "__new__") {
                                      setNewFolderForLayer(feat.name);
                                      setNewFolderDraft(explicit ?? "");
                                    } else if (val === "__auto__") {
                                      setNewFolderForLayer(null);
                                      setLayerFolder(feat.name, undefined);
                                    } else if (val === "__own__") {
                                      setNewFolderForLayer(null);
                                      setLayerFolder(feat.name, feat.name);
                                    } else {
                                      setNewFolderForLayer(null);
                                      setLayerFolder(feat.name, val);
                                    }
                                  }}
                                  className="h-7 w-full rounded-md border border-input bg-background px-1.5 text-[11px]"
                                >
                                  <option value="__auto__">Auto</option>
                                  <option value="__own__">Own folder ({feat.name})</option>
                                  {folderChoices
                                    .filter((choice) => choice !== feat.name)
                                    .map((choice) => (
                                      <option key={choice} value={choice}>
                                        {choice}
                                      </option>
                                    ))}
                                  <option value="__new__">+ New folder…</option>
                                </select>
                              </div>
                              {isCreating && (
                                <form
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    const clean = newFolderDraft.trim().slice(0, 100);
                                    if (clean) {
                                      setLayerFolder(feat.name, clean);
                                    }
                                    setNewFolderForLayer(null);
                                    setNewFolderDraft("");
                                  }}
                                  className="flex items-center gap-1 pl-2"
                                >
                                  <Input
                                    autoFocus
                                    placeholder="Folder name (e.g. Provinces)"
                                    value={newFolderDraft}
                                    onChange={(e) => setNewFolderDraft(e.target.value)}
                                    className="h-6 flex-1 text-[11px]"
                                  />
                                  <Button type="submit" size="sm" className="h-6 px-2 text-[11px]">
                                    Set
                                  </Button>
                                  <button
                                    type="button"
                                    onClick={() => setNewFolderForLayer(null)}
                                    className="text-[11px] text-muted-foreground hover:text-foreground"
                                  >
                                    Cancel
                                  </button>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {kmlPlan?.warnings.map((warn, idx) => (
                <div key={idx} className="flex items-start gap-1.5 text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{warn}</span>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={Boolean(launchingAction) || assemblyPending}
              onClick={() => void handleImportToSearchlight()}
            >
              <UploadCloud className="mr-2 h-4 w-4" />
              {launchingAction === "import"
                ? "Opening Importer…"
                : "Import to Searchlight (requires sign-in)"}
            </Button>
          </section>
        </>
      )}
    </>
  );
}
