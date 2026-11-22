import type { GeoJsonGeometry, PlayAreaFeatureCollection, Position } from "@searchlight/shared";
import * as turf from "@turf/turf";
import { FileUp, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RawInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CreatorGeometryLayer } from "@/lib/creator/assemble";
import {
  buildSurroundingPlayArea,
  importedFeaturesToPlayArea,
  type ImportedFolder,
  parseImportedFileText,
  unionPolygonsToPlayArea,
} from "@/lib/creator/importFile";
import type { CreatorPointItem } from "@/lib/creator/overpass";
import { MAX_LOCAL_GAME_BYTES } from "@/lib/localGameLoader";

interface Props {
  stations: readonly CreatorPointItem[];
  layers: readonly CreatorGeometryLayer[];
  onSetPlayArea: (
    playArea: PlayAreaFeatureCollection,
    name?: string,
    options?: { preserveData?: boolean },
  ) => void;
}

export function PlayAreaTools({ stations, layers, onSetPlayArea }: Props) {
  const [pendingFile, setPendingFile] = useState<{
    fileName: string;
    folders: ImportedFolder[];
  } | null>(null);
  const [folderIdx, setFolderIdx] = useState(0);
  const [mergePolygons, setMergePolygons] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPolyLayerId, setSelectedPolyLayerId] = useState("");
  const [surroundMarginKm, setSurroundMarginKm] = useState(2);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const reqSeqRef = useRef(0);

  const polygonLayers = layers.filter(
    (l) => l.family === "polygons" && l.items.some((item) => item.enabled),
  );
  const activeStations = stations.filter((s) => s.enabled);
  const hasAnyFeatures =
    activeStations.length > 0 || layers.some((l) => l.selected && l.items.some((i) => i.enabled));

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
      setPendingFile(null);
      setError(parsed.error);
      return;
    }
    if (parsed.kind === "game-definition") {
      if (parsed.definition.map.playArea.features.length === 0) {
        setError("That .game.json has an empty play area.");
        return;
      }
      onSetPlayArea(parsed.definition.map.playArea, parsed.definition.name);
      toast.success(`Imported play area from "${parsed.definition.name}"`);
      setPendingFile(null);
      return;
    }

    const polyFolders = parsed.folders.filter((f) => f.counts.polygons > 0);
    if (polyFolders.length === 0) {
      setPendingFile(null);
      setError("No polygon boundaries found in that file.");
      return;
    }

    if (polyFolders.length === 1) {
      const folder = polyFolders[0];
      const pa = importedFeaturesToPlayArea(folder.features, {
        union: true,
        name: folder.name !== "(Root)" ? folder.name : undefined,
      });
      if (!pa) {
        setError("No valid non-self-intersecting polygons found for a play area.");
        return;
      }
      onSetPlayArea(pa, folder.name !== "(Root)" ? folder.name : undefined);
      toast.success(`Play area imported from ${file.name}`);
      setPendingFile(null);
      return;
    }

    setPendingFile({ fileName: file.name, folders: polyFolders });
    setFolderIdx(0);
  };

  const handleApplyPendingFolder = () => {
    if (!pendingFile) return;
    const folder = pendingFile.folders[folderIdx];
    if (!folder) return;
    const pa = importedFeaturesToPlayArea(folder.features, {
      union: mergePolygons,
      name: folder.name !== "(Root)" ? folder.name : undefined,
    });
    if (!pa) {
      setError("No valid non-self-intersecting polygons found in that folder.");
      return;
    }
    setError(null);
    onSetPlayArea(pa, folder.name !== "(Root)" ? folder.name : undefined);
    toast.success(`Play area set from "${folder.name}"`);
    setPendingFile(null);
  };

  const handleUnionFromLayer = () => {
    const target = polygonLayers.find((l) => l.id === selectedPolyLayerId) ?? polygonLayers[0];
    if (!target) return;
    const geoms = target.items
      .filter(
        (i) => i.enabled && (i.geometry.type === "Polygon" || i.geometry.type === "MultiPolygon"),
      )
      .map(
        (i) =>
          i.geometry as
            | Extract<GeoJsonGeometry, { type: "Polygon" }>
            | Extract<GeoJsonGeometry, { type: "MultiPolygon" }>,
      );
    const pa = unionPolygonsToPlayArea(geoms, target.name);
    if (!pa) {
      setError(`Could not build a valid play area from "${target.name}".`);
      return;
    }
    setError(null);
    onSetPlayArea(pa, undefined, { preserveData: true });
    toast.success(`Play area generated from union of "${target.name}"`);
  };

  const handleSurroundFeatures = () => {
    const coords: Position[] = [];
    for (const s of activeStations) {
      coords.push([s.lng, s.lat]);
    }
    for (const layer of layers) {
      if (!layer.selected) continue;
      for (const item of layer.items) {
        if (!item.enabled) continue;
        try {
          const all = turf.coordAll({
            type: "Feature",
            geometry: item.geometry,
            properties: {},
          });
          for (const pt of all) {
            coords.push([pt[0], pt[1]]);
          }
        } catch {
          // ignore malformed geometry
        }
      }
    }
    const pa = buildSurroundingPlayArea(coords, surroundMarginKm, "Generated Play Area");
    if (!pa) {
      setError("Add stations or feature layers first to surround them.");
      return;
    }
    setError(null);
    onSetPlayArea(pa, undefined, { preserveData: true });
    toast.success(`Play area generated around game features (+${surroundMarginKm} km)`);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileUp className="mr-1.5 h-3.5 w-3.5" />
          Import .kml / .geojson
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.geojson,.json,application/json,application/vnd.google-earth.kml+xml"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {pendingFile && (
        <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-medium">
              Pick polygon folder from {pendingFile.fileName}
            </span>
            <button
              type="button"
              aria-label="Cancel play area import"
              onClick={() => setPendingFile(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <select
            value={folderIdx}
            onChange={(e) => setFolderIdx(Number(e.target.value))}
            className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
          >
            {pendingFile.folders.map((f, idx) => (
              <option key={idx} value={idx}>
                {f.name} ({f.counts.polygons} polygon
                {f.counts.polygons === 1 ? "" : "s"})
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
            <Checkbox
              checked={mergePolygons}
              onCheckedChange={(v) => setMergePolygons(v === true)}
            />
            <span>Union polygons into one outer boundary (e.g. provinces)</span>
          </label>
          <Button type="button" size="sm" onClick={handleApplyPendingFolder}>
            Use as Play Area
          </Button>
        </div>
      )}

      {/* Generate play area from loaded layers / stations */}
      {(polygonLayers.length > 0 || hasAnyFeatures) && (
        <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Generate from your game data
          </p>

          {polygonLayers.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                aria-label="Polygon layer to union as play area"
                value={selectedPolyLayerId || polygonLayers[0].id}
                onChange={(e) => setSelectedPolyLayerId(e.target.value)}
                className="flex h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
              >
                {polygonLayers.map((l) => (
                  <option key={l.id} value={l.id}>
                    Union of {l.name} ({l.items.filter((i) => i.enabled).length})
                  </option>
                ))}
              </select>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 shrink-0 text-xs"
                onClick={handleUnionFromLayer}
              >
                Use union
              </Button>
            </div>
          )}

          {hasAnyFeatures && (
            <div className="flex items-center gap-1.5">
              <Label
                htmlFor="creator-surround-margin"
                className="shrink-0 text-[11px] text-muted-foreground"
              >
                Margin (km)
              </Label>
              <RawInput
                id="creator-surround-margin"
                type="number"
                min={0.2}
                max={50}
                step="any"
                value={surroundMarginKm}
                // Floor 0, not 0.2, so "0.5" can be typed; buildSurroundingPlayArea clamps to 0.2.
                onChange={(e) => setSurroundMarginKm(Number(e.target.value) || 0)}
                className="h-8 w-16 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-8 flex-1 text-xs"
                onClick={handleSurroundFeatures}
              >
                Surround stations &amp; features
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
