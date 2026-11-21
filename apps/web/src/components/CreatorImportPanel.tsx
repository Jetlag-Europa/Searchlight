import type {
    FeatureEnabledFor,
    GameDefinition,
    PlayAreaFeatureCollection,
} from "@searchlight/shared";
import { FileUp, Upload } from "lucide-react";
import { useRef, useState } from "react";
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
    type GeometryFamily,
    importedFeaturesToPlayArea,
    importedFeaturesToStations,
    mergeImportedByName,
    type ParsedImportFile,
    parseImportedFileText,
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
    onAddGeometryLayer: (layer: CreatorGeometryLayer) => void;
    onLoadGameDefinition: (def: GameDefinition) => void;
}

export function CreatorImportPanel({
    existingLayerSlugs,
    geometryLayerCount,
    onSetPlayArea,
    onImportStations,
    onAddGeometryLayer,
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
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const fileReadSeqRef = useRef(0);

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

    const handleAddAsLayer = () => {
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

        const enabledFor: FeatureEnabledFor[] =
            family === "points"
                ? ["matching", "measuring", "tentacle"]
                : family === "polygons"
                  ? ["matching", "measuring"]
                  : ["measuring"];

        const layer: CreatorGeometryLayer = {
            id: `imported-${Date.now()}`,
            name: trimmed,
            family,
            enabledFor,
            color: CUSTOM_LAYER_COLORS[
                geometryLayerCount % CUSTOM_LAYER_COLORS.length
            ],
            selected: true,
            noOverlaps: false,
            sourceLabel: `Imported ${parsed?.ok && parsed.kind === "folders" ? parsed.format.toUpperCase() : "file"}: ${activeFolder.name}`,
            items,
            vertexCount: sumFeatureVertices(items),
        };
        onAddGeometryLayer(layer);
        toast.success(
            `Added "${trimmed}" (${items.length} ${family} feature${items.length === 1 ? "" : "s"})`,
        );
    };

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
                    Import <code className="rounded bg-muted px-1">.kml</code>,{" "}
                    <code className="rounded bg-muted px-1">.geojson</code>,{" "}
                    <code className="rounded bg-muted px-1">.csv</code>, or an
                    existing{" "}
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
                    accept=".kml,.geojson,.json,.csv,application/json,text/csv,application/vnd.google-earth.kml+xml"
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
                        <span className="rounded bg-muted px-1.5 py-0.5 uppercase text-[10px] text-muted-foreground">
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

                    {/* Add as a feature layer */}
                    <div className="space-y-2 border-t border-border pt-2.5">
                        <p className="font-medium text-muted-foreground">
                            Or add as a feature layer
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                            <Input
                                placeholder="Layer name (e.g. District)"
                                value={layerName}
                                onChange={(e) => setLayerName(e.target.value)}
                                className="h-8 text-xs"
                            />
                            <select
                                value={family}
                                onChange={(e) =>
                                    setFamily(e.target.value as GeometryFamily)
                                }
                                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                            >
                                {activeFolder.counts.points > 0 && (
                                    <option value="points">
                                        Points ({activeFolder.counts.points})
                                    </option>
                                )}
                                {activeFolder.counts.lines > 0 && (
                                    <option value="lines">
                                        Lines ({activeFolder.counts.lines})
                                    </option>
                                )}
                                {activeFolder.counts.polygons > 0 && (
                                    <option value="polygons">
                                        Polygons ({activeFolder.counts.polygons})
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
                                    Merge shapes sharing the same name into one
                                    feature
                                </span>
                            </label>
                        )}
                        <Button
                            type="button"
                            size="sm"
                            onClick={handleAddAsLayer}
                        >
                            Add as Feature Layer
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
