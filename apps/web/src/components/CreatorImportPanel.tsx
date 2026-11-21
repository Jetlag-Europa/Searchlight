import type {
    FeatureEnabledFor,
    GameDefinition,
    PlayAreaFeatureCollection,
} from "@searchlight/shared";
import { FileUp, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    type CreatorGeometryLayer,
    layerSlugOf,
} from "@/lib/creator/assemble";
import {
    detectFolderSplitFields,
    type GeometryFamily,
    importedFeaturesToPlayArea,
    importedFeaturesToStations,
    mergeImportedByName,
    type ParsedImportFile,
    parseImportedFileText,
    splitFeaturesByField,
    sumFeatureVertices,
} from "@/lib/creator/importFile";
import type { CreatorPointItem } from "@/lib/creator/overpass";
import { CUSTOM_LAYER_COLORS } from "@/lib/creator/presets";
import { MAX_LOCAL_GAME_BYTES } from "@/lib/localGameLoader";
import { cn } from "@/lib/utils";

interface Props {
    existingLayerSlugs: ReadonlySet<string>;
    geometryLayerCount: number;
    onSetPlayArea: (playArea: PlayAreaFeatureCollection, name?: string) => void;
    onImportStations: (stations: CreatorPointItem[], replace: boolean) => void;
    onAddGeometryLayers: (layers: CreatorGeometryLayer[]) => void;
    onLoadGameDefinition: (def: GameDefinition) => void;
}

interface SplitGroupDraft {
    key: string;
    name: string;
    selected: boolean;
    family: GeometryFamily;
    count: number;
}

function defaultEnabledFor(family: GeometryFamily): FeatureEnabledFor[] {
    if (family === "points") return ["matching", "measuring", "tentacle"];
    if (family === "polygons") return ["matching", "measuring"];
    return ["measuring"];
}

export function CreatorImportPanel({
    existingLayerSlugs,
    geometryLayerCount,
    onSetPlayArea,
    onImportStations,
    onAddGeometryLayers,
    onLoadGameDefinition,
}: Props) {
    const [dragOver, setDragOver] = useState(false);
    const [parsed, setParsed] = useState<
        (ParsedImportFile & { fileName: string }) | null
    >(null);
    const [folderIndex, setFolderIndex] = useState(0);
    const [layerName, setLayerName] = useState("");
    const [family, setFamily] = useState<GeometryFamily>("points");
    const [mergeByName, setMergeByName] = useState(true);
    const [splitField, setSplitField] = useState<string>("none");
    const [splitDrafts, setSplitDrafts] = useState<SplitGroupDraft[]>([]);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const fileReadSeqRef = useRef(0);

    const applySplitMode = (
        folderFeatures: Parameters<typeof splitFeaturesByField>[0],
        nextField: string,
    ) => {
        setSplitField(nextField);
        if (nextField === "none") {
            setSplitDrafts([]);
            return;
        }
        const groups = splitFeaturesByField(folderFeatures, nextField);
        setSplitDrafts(
            groups.map((g) => ({
                key: g.key,
                name: g.suggestedName,
                // Auto-uncheck obvious helper markers like "start" when splitting My Maps folders.
                selected: !/^start$/i.test(g.key.trim()),
                family: g.family,
                count: g.features.length,
            })),
        );
    };

    const selectFolder = (
        next: Extract<ParsedImportFile, { ok: true; kind: "folders" }>,
        idx: number,
    ) => {
        const folder = next.folders[idx];
        if (!folder) return;
        setFolderIndex(idx);
        setLayerName(folder.name === "(Root)" ? "" : folder.name);
        if (folder.counts.polygons > 0) setFamily("polygons");
        else if (folder.counts.lines > 0) setFamily("lines");
        else setFamily("points");

        // Auto-select splitting when a point folder has a clear category field (e.g. `type` / `category`).
        const splitOpts = detectFolderSplitFields(folder.features);
        const preferred =
            folder.counts.points > 0 &&
            folder.counts.polygons === 0 &&
            folder.counts.lines === 0
                ? splitOpts.find((o) =>
                      /^(type|category|kind)$/i.test(o.key),
                  )
                : undefined;
        if (preferred) {
            applySplitMode(folder.features, preferred.key);
        } else {
            applySplitMode(folder.features, "none");
        }
    };

    const handleFile = async (file: File) => {
        const reqSeq = ++fileReadSeqRef.current;
        setError(null);
        if (file.size > MAX_LOCAL_GAME_BYTES) {
            setError("File is too large (50 MB limit).");
            return;
        }
        let text: string;
        try {
            text = await file.text();
        } catch {
            if (fileReadSeqRef.current !== reqSeq) return;
            setError("Could not read file.");
            return;
        }
        if (fileReadSeqRef.current !== reqSeq) return;
        const result = parseImportedFileText(file.name, text);
        if (fileReadSeqRef.current !== reqSeq) return;
        if (!result.ok) {
            setParsed(null);
            setError(result.error);
            return;
        }
        setParsed({ ...result, fileName: file.name });
        if (result.kind === "folders") {
            selectFolder(result, 0);
        }
    };

    const activeFolder =
        parsed?.ok && parsed.kind === "folders"
            ? parsed.folders[folderIndex]
            : null;

    const splitOptions = useMemo(
        () => (activeFolder ? detectFolderSplitFields(activeFolder.features) : []),
        [activeFolder],
    );

    const handleAddSingleLayer = () => {
        if (!activeFolder) return;
        setError(null);
        const trimmed = layerName.trim();
        if (!trimmed) {
            setError("Enter a singular layer name.");
            return;
        }
        const slug = layerSlugOf(trimmed);
        if (!slug) {
            setError(
                "Layer name must include at least one ASCII letter or digit (a–z, 0–9).",
            );
            return;
        }
        if (existingLayerSlugs.has(slug)) {
            setError(
                `A layer with ID "${slug}" already exists. Choose a different name.`,
            );
            return;
        }
        const rawMatching = activeFolder.features.filter(
            (f) => f.family === family,
        );
        if (rawMatching.length === 0) {
            setError(`This folder has no ${family} features.`);
            return;
        }

        const items =
            mergeByName && family !== "points"
                ? mergeImportedByName(rawMatching, family)
                : rawMatching.map((f, idx) => ({
                      uid: `imp-${Date.now()}-${idx}`,
                      name: f.name,
                      geometry: f.geometry,
                      enabled: true,
                  }));

        const fmt =
            parsed?.ok && parsed.kind === "folders"
                ? parsed.format.toUpperCase()
                : "file";
        const layer: CreatorGeometryLayer = {
            id: `imported-${Date.now()}`,
            name: trimmed,
            family,
            enabledFor: defaultEnabledFor(family),
            color: CUSTOM_LAYER_COLORS[
                geometryLayerCount % CUSTOM_LAYER_COLORS.length
            ],
            selected: true,
            noOverlaps: false,
            sourceLabel: `Imported ${fmt}: ${activeFolder.name}`,
            items,
            vertexCount: sumFeatureVertices(items),
        };
        onAddGeometryLayers([layer]);
        toast.success(
            `Added "${trimmed}" (${items.length} ${family} feature${items.length === 1 ? "" : "s"})`,
        );
    };

    const handleAddSplitLayers = () => {
        if (!activeFolder || splitField === "none") return;
        setError(null);
        const groups = splitFeaturesByField(activeFolder.features, splitField);
        const byKey = new Map(groups.map((g) => [g.key, g]));
        const selectedDrafts = splitDrafts.filter((d) => d.selected);
        if (selectedDrafts.length === 0) {
            setError("Select at least one group to import.");
            return;
        }

        const usedSlugs = new Set(existingLayerSlugs);
        const newLayers: CreatorGeometryLayer[] = [];
        const fmt =
            parsed?.ok && parsed.kind === "folders"
                ? parsed.format.toUpperCase()
                : "file";
        const baseTs = Date.now();

        for (let i = 0; i < selectedDrafts.length; i++) {
            const draft = selectedDrafts[i];
            const group = byKey.get(draft.key);
            if (!group || group.features.length === 0) continue;
            const trimmed = draft.name.trim();
            const slug = layerSlugOf(trimmed);
            if (!trimmed || !slug) {
                setError(
                    `Group "${draft.key}" needs a layer name with at least one ASCII letter or digit.`,
                );
                return;
            }
            if (usedSlugs.has(slug)) {
                setError(
                    `Layer name "${trimmed}" collides with an existing layer ID "${slug}". Rename it first.`,
                );
                return;
            }
            usedSlugs.add(slug);

            const items =
                mergeByName && group.family !== "points"
                    ? mergeImportedByName(group.features, group.family)
                    : group.features.map((f, idx) => ({
                          uid: `imp-sp-${baseTs}-${i}-${idx}`,
                          name: f.name,
                          geometry: f.geometry,
                          enabled: true,
                      }));

            newLayers.push({
                id: `imported-${baseTs}-${i}`,
                name: trimmed,
                family: group.family,
                enabledFor: defaultEnabledFor(group.family),
                color: CUSTOM_LAYER_COLORS[
                    (geometryLayerCount + newLayers.length) %
                        CUSTOM_LAYER_COLORS.length
                ],
                selected: true,
                noOverlaps: false,
                sourceLabel: `Imported ${fmt}: ${activeFolder.name}`,
                // Keep original folder name as KML export grouping hint!
                ...(activeFolder.name !== "(Root)" &&
                    group.family === "points" && {
                        kmlGroup: activeFolder.name,
                    }),
                items,
                vertexCount: sumFeatureVertices(items),
            });
        }

        if (newLayers.length === 0) {
            setError("No valid features found in the selected groups.");
            return;
        }
        onAddGeometryLayers(newLayers);
        toast.success(
            `Added ${newLayers.length} layer${newLayers.length === 1 ? "" : "s"} from "${activeFolder.name}"`,
        );
    };

    const selectedSplitCount = splitDrafts.filter((d) => d.selected).length;

    return (
        <div className="space-y-4">
            <div
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void handleFile(file);
                }}
                className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors",
                    dragOver
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background/40 hover:border-muted-foreground/50",
                )}
            >
                <Upload className="h-5 w-5 text-muted-foreground" />
                <p className="text-xs font-medium">
                    Import <code className="rounded bg-muted px-1">.kml</code>{" "}
                    (Google My Maps),{" "}
                    <code className="rounded bg-muted px-1">.geojson</code>,{" "}
                    <code className="rounded bg-muted px-1">.csv</code>, or{" "}
                    <code className="rounded bg-muted px-1">.game.json</code>
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <FileUp className="mr-1.5 h-3.5 w-3.5" />
                    Choose file…
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".kml,.geojson,.json,.csv,.tsv,application/json,text/csv,application/vnd.google-earth.kml+xml"
                    hidden
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) void handleFile(file);
                    }}
                />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {/* Full Searchlight game.json detected */}
            {parsed?.ok && parsed.kind === "game-definition" && (
                <div className="space-y-2.5 rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">
                    <p className="font-semibold">
                        Searchlight game detected: {parsed.definition.name}
                    </p>
                    <p className="text-muted-foreground">
                        {parsed.definition.hidingZones.features.features.length}{" "}
                        hiding zones · {parsed.definition.features?.length ?? 0}{" "}
                        feature layers
                    </p>
                    <Button
                        type="button"
                        size="sm"
                        onClick={() => {
                            onLoadGameDefinition(parsed.definition);
                            toast.success(
                                `Loaded "${parsed.definition.name}" into Creator`,
                            );
                        }}
                    >
                        Load entire game into Creator
                    </Button>
                </div>
            )}

            {/* KML / GeoJSON / CSV folder picker */}
            {parsed?.ok && parsed.kind === "folders" && activeFolder && (
                <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-semibold">
                            {parsed.fileName}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {parsed.format}
                        </span>
                    </div>

                    {parsed.folders.length > 1 && (
                        <div className="space-y-1">
                            <Label
                                htmlFor="creator-import-folder"
                                className="text-xs"
                            >
                                Folder / My Maps layer
                            </Label>
                            <select
                                id="creator-import-folder"
                                value={folderIndex}
                                onChange={(e) =>
                                    selectFolder(parsed, Number(e.target.value))
                                }
                                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                            >
                                {parsed.folders.map((folder, idx) => (
                                    <option key={idx} value={idx}>
                                        {folder.name} ({folder.features.length})
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    <p className="text-muted-foreground">
                        Contains:{" "}
                        {[
                            activeFolder.counts.points > 0 &&
                                `${activeFolder.counts.points} points`,
                            activeFolder.counts.lines > 0 &&
                                `${activeFolder.counts.lines} lines`,
                            activeFolder.counts.polygons > 0 &&
                                `${activeFolder.counts.polygons} polygons`,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </p>

                    {/* Quick actions for Play Area and Stations */}
                    <div className="flex flex-wrap gap-2">
                        {activeFolder.counts.polygons > 0 && (
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    const pa = importedFeaturesToPlayArea(
                                        activeFolder.features,
                                    );
                                    if (!pa) {
                                        setError(
                                            "No valid non-self-intersecting polygons found for a play area.",
                                        );
                                        return;
                                    }
                                    setError(null);
                                    onSetPlayArea(
                                        pa,
                                        activeFolder.name !== "(Root)"
                                            ? activeFolder.name
                                            : undefined,
                                    );
                                    toast.success("Play area updated from file");
                                }}
                            >
                                Set as Play Area
                            </Button>
                        )}
                        {activeFolder.counts.points > 0 && (
                            <>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        const pts = importedFeaturesToStations(
                                            activeFolder.features,
                                        );
                                        onImportStations(pts, false);
                                        toast.success(
                                            `Added ${pts.length} station${pts.length === 1 ? "" : "s"}`,
                                        );
                                    }}
                                >
                                    Add to Stations
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        const pts = importedFeaturesToStations(
                                            activeFolder.features,
                                        );
                                        onImportStations(pts, true);
                                        toast.success(
                                            `Replaced stations with ${pts.length} pin${pts.length === 1 ? "" : "s"}`,
                                        );
                                    }}
                                >
                                    Replace Stations
                                </Button>
                            </>
                        )}
                    </div>

                    {/* Add as feature layer(s) — supports single layer OR splitting grouped My Maps folders */}
                    <div className="space-y-2.5 border-t border-border pt-2.5">
                        <div className="flex items-center justify-between gap-2">
                            <p className="font-medium text-muted-foreground">
                                Add to My Layers
                            </p>
                            {splitOptions.length > 0 && (
                                <select
                                    aria-label="Import folder grouping mode"
                                    value={splitField}
                                    onChange={(e) =>
                                        applySplitMode(
                                            activeFolder.features,
                                            e.target.value,
                                        )
                                    }
                                    className="h-7 rounded border border-input bg-background px-1.5 text-[11px]"
                                >
                                    <option value="none">
                                        Import as 1 layer
                                    </option>
                                    {splitOptions.map((opt) => (
                                        <option key={opt.key} value={opt.key}>
                                            Split by {opt.label} (
                                            {opt.groupCount})
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>

                        {splitField === "none" ? (
                            <>
                                <div className="grid grid-cols-2 gap-2">
                                    <Input
                                        placeholder="Layer name (e.g. District)"
                                        value={layerName}
                                        onChange={(e) =>
                                            setLayerName(e.target.value)
                                        }
                                        className="h-8 text-xs"
                                    />
                                    <select
                                        value={family}
                                        onChange={(e) =>
                                            setFamily(
                                                e.target
                                                    .value as GeometryFamily,
                                            )
                                        }
                                        className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                                    >
                                        {activeFolder.counts.points > 0 && (
                                            <option value="points">
                                                Points (
                                                {activeFolder.counts.points})
                                            </option>
                                        )}
                                        {activeFolder.counts.lines > 0 && (
                                            <option value="lines">
                                                Lines (
                                                {activeFolder.counts.lines})
                                            </option>
                                        )}
                                        {activeFolder.counts.polygons > 0 && (
                                            <option value="polygons">
                                                Polygons (
                                                {activeFolder.counts.polygons})
                                            </option>
                                        )}
                                    </select>
                                </div>
                                {family !== "points" && (
                                    <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
                                        <Checkbox
                                            checked={mergeByName}
                                            onCheckedChange={(v) =>
                                                setMergeByName(v === true)
                                            }
                                        />
                                        <span>
                                            Merge shapes sharing the same name
                                            into one feature
                                        </span>
                                    </label>
                                )}
                                <Button
                                    type="button"
                                    size="sm"
                                    onClick={handleAddSingleLayer}
                                >
                                    Add to My Layers
                                </Button>
                            </>
                        ) : (
                            <>
                                <p className="text-[11px] text-muted-foreground">
                                    Detected {splitDrafts.length} sub-layers in
                                    this folder. Uncheck any you don&apos;t want
                                    and edit layer names as needed:
                                </p>
                                <div className="max-h-48 divide-y divide-border overflow-y-auto rounded border border-border bg-card">
                                    {splitDrafts.map((draft, idx) => (
                                        <div
                                            key={draft.key}
                                            className="flex items-center gap-2 px-2 py-1.5"
                                        >
                                            <Checkbox
                                                checked={draft.selected}
                                                onCheckedChange={(v) =>
                                                    setSplitDrafts((prev) =>
                                                        prev.map((d, j) =>
                                                            j === idx
                                                                ? {
                                                                      ...d,
                                                                      selected:
                                                                          v ===
                                                                          true,
                                                                  }
                                                                : d,
                                                        ),
                                                    )
                                                }
                                            />
                                            <Input
                                                value={draft.name}
                                                onChange={(e) =>
                                                    setSplitDrafts((prev) =>
                                                        prev.map((d, j) =>
                                                            j === idx
                                                                ? {
                                                                      ...d,
                                                                      name: e
                                                                          .target
                                                                          .value,
                                                                  }
                                                                : d,
                                                        ),
                                                    )
                                                }
                                                className="h-7 flex-1 text-xs"
                                            />
                                            <span className="shrink-0 text-[11px] text-muted-foreground">
                                                {draft.count} {draft.family}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    disabled={selectedSplitCount === 0}
                                    onClick={handleAddSplitLayers}
                                >
                                    Add {selectedSplitCount} selected layer
                                    {selectedSplitCount === 1 ? "" : "s"} to My
                                    Layers
                                </Button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
