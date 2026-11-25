import type { GameDefinition } from "@searchlight/shared";
import { FileUp, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  importedFeaturesToStations,
  type ImportedFolder,
  type ImportedRawFeature,
  parseImportedFileText,
} from "@/lib/creator/importFile";
import type { CreatorPointItem } from "@/lib/creator/overpass";
import { MAX_LOCAL_GAME_BYTES } from "@/lib/localGameLoader";
import { cn } from "@/lib/utils";

type PendingStationImport =
  | {
      kind: "folders";
      fileName: string;
      format: "kml" | "geojson" | "csv";
      folders: ImportedFolder[];
      fileFeatures: ImportedRawFeature[];
    }
  | {
      kind: "game-definition";
      fileName: string;
      definition: GameDefinition;
      stations: CreatorPointItem[];
    };

interface Props {
  existingStationCount: number;
  onImportStations: (
    stations: CreatorPointItem[],
    replace: boolean,
    tierRadiiMeters?: Record<string, number>,
  ) => void;
  onLoadGameDefinition: (def: GameDefinition) => void;
}

function defaultStationFolderIndex(folders: readonly ImportedFolder[]): number {
  const idx = folders.findIndex((f) => /station|stop|zone|transit|rail|metro|tram/i.test(f.name));
  return idx >= 0 ? idx : 0;
}

export function StationFileImporter({
  existingStationCount,
  onImportStations,
  onLoadGameDefinition,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<PendingStationImport | null>(null);
  const [folderIdx, setFolderIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reqSeqRef = useRef(0);

  const handleFile = async (file: File) => {
    const seq = ++reqSeqRef.current;
    setError(null);
    if (file.size > MAX_LOCAL_GAME_BYTES) {
      setError("File is too large (50 MB limit).");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (reqSeqRef.current !== seq) return;
      setError("Could not read file.");
      return;
    }
    if (reqSeqRef.current !== seq) return;

    const parsed = parseImportedFileText(file.name, text);
    if (reqSeqRef.current !== seq) return;
    if (!parsed.ok) {
      setPending(null);
      setError(parsed.error);
      return;
    }

    if (parsed.kind === "game-definition") {
      const pts: CreatorPointItem[] = [];
      parsed.definition.hidingZones.features.features.forEach((f, idx) => {
        if (f.geometry.type !== "Point") return;
        const rawTier = f.properties?.tier;
        pts.push({
          uid: `imp-game-st-${Date.now()}-${idx}`,
          name:
            typeof f.properties?.name === "string" && f.properties.name
              ? f.properties.name
              : `Station ${idx + 1}`,
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          tier:
            typeof rawTier === "string"
              ? rawTier
              : typeof rawTier === "number"
                ? String(rawTier)
                : undefined,
          enabled: true,
          custom: true,
        });
      });
      setPending({
        kind: "game-definition",
        fileName: file.name,
        definition: parsed.definition,
        stations: pts,
      });
      return;
    }

    const pointFolders = parsed.folders.filter((f) => f.counts.points > 0);
    const fileFeatures = parsed.folders.flatMap((f) => f.features);
    if (pointFolders.length === 0) {
      setPending(null);
      setError("No point features (stations) found in that file.");
      return;
    }

    // Single-folder CSV/KML/GeoJSON when station list is empty: import immediately!
    if (pointFolders.length === 1 && existingStationCount === 0) {
      const { stations: pts, tierRadiiMeters } = importedFeaturesToStations(
        pointFolders[0].features,
        fileFeatures,
      );
      onImportStations(pts, true, tierRadiiMeters);
      setPending(null);
      toast.success(
        `Imported ${pts.length} station${pts.length === 1 ? "" : "s"} from ${file.name}`,
      );
      return;
    }

    setPending({
      kind: "folders",
      fileName: file.name,
      format: parsed.format,
      folders: pointFolders,
      fileFeatures,
    });
    setFolderIdx(defaultStationFolderIndex(pointFolders));
  };

  const activeFolder = pending?.kind === "folders" ? pending.folders[folderIdx] : null;

  const commitFolder = (replace: boolean) => {
    if (!activeFolder || pending?.kind !== "folders") return;
    const { stations: pts, tierRadiiMeters } = importedFeaturesToStations(
      activeFolder.features,
      pending.fileFeatures,
    );
    onImportStations(pts, replace, tierRadiiMeters);
    toast.success(
      `${replace ? "Loaded" : "Added"} ${pts.length} station${pts.length === 1 ? "" : "s"} from ${pending.fileName}`,
    );
    setPending(null);
  };

  return (
    <section className="space-y-2">
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
          "flex items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5 transition-colors",
          dragOver
            ? "border-primary bg-primary/10"
            : "border-border bg-background/40 hover:border-muted-foreground/50",
        )}
      >
        <div className="min-w-0">
          <p className="text-xs font-medium">Import stations from CSV, KML, or GeoJSON</p>
          <p className="text-[11px] text-muted-foreground">
            CSV (<code className="rounded bg-muted px-1">name,lat,lng[,tier]</code> or My Maps{" "}
            <code className="rounded bg-muted px-1">WKT</code>) · KML folders · GeoJSON
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp className="mr-1.5 h-3.5 w-3.5" />
          Import…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.tsv,.kml,.geojson,.json,text/csv,application/vnd.google-earth.kml+xml,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {pending?.kind === "folders" && activeFolder && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              {pending.fileName} ({activeFolder.counts.points} station
              {activeFolder.counts.points === 1 ? "" : "s"})
            </span>
            <button
              type="button"
              aria-label="Dismiss station import"
              onClick={() => setPending(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {pending.folders.length > 1 && (
            <div className="space-y-1">
              <Label
                htmlFor="creator-station-kml-folder"
                className="text-[11px] text-muted-foreground"
              >
                KML folder / layer
              </Label>
              <select
                id="creator-station-kml-folder"
                value={folderIdx}
                onChange={(e) => setFolderIdx(Number(e.target.value))}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                {pending.folders.map((folder, idx) => (
                  <option key={idx} value={idx}>
                    {folder.name} ({folder.counts.points} pts)
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button type="button" size="sm" onClick={() => commitFolder(false)}>
              Add {activeFolder.counts.points} to list
            </Button>
            {existingStationCount > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => commitFolder(true)}>
                Replace existing
              </Button>
            )}
          </div>
        </div>
      )}

      {pending?.kind === "game-definition" && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              Searchlight game: {pending.definition.name} ({pending.stations.length} stations)
            </span>
            <button
              type="button"
              aria-label="Dismiss game import"
              onClick={() => setPending(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {pending.stations.length > 0 && (
              <>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    onImportStations(pending.stations, false);
                    toast.success(`Added ${pending.stations.length} stations`);
                    setPending(null);
                  }}
                >
                  Add stations
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onImportStations(pending.stations, true);
                    toast.success(`Replaced stations with ${pending.stations.length} stops`);
                    setPending(null);
                  }}
                >
                  Replace stations
                </Button>
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                onLoadGameDefinition(pending.definition);
                toast.success(`Loaded "${pending.definition.name}" into Creator`);
                setPending(null);
              }}
            >
              Load entire game
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
