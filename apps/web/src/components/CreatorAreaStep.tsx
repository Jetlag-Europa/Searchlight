import type { DistanceUnit, PlayAreaFeatureCollection } from "@searchlight/shared";
import { Check, PenTool, Search } from "lucide-react";

import { PlayAreaTools } from "@/components/PlayAreaTools";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RawInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { CreatorGeometryLayer } from "@/lib/creator/assemble";
import type { CreatorPointItem, PlaceSearchResult } from "@/lib/creator/overpass";
import { convertDistanceUnit, type GameScale, SCALE_PRESETS } from "@/lib/creator/presets";
import { cn } from "@/lib/utils";

interface Props {
  scale: GameScale;
  applyScalePreset: (next: GameScale) => void;
  placeQuery: string;
  setPlaceQuery: (val: string) => void;
  placeSearching: boolean;
  placeError: string | null;
  placeResults: PlaceSearchResult[];
  handlePlaceSearch: (e: React.FormEvent) => Promise<void>;
  handlePickPlace: (place: PlaceSearchResult) => void;
  interactionMode: "browse" | "draw-area" | "add-station";
  setInteractionMode: (mode: "browse" | "draw-area" | "add-station") => void;
  drawPoints: [number, number][];
  setDrawPoints: React.Dispatch<React.SetStateAction<[number, number][]>>;
  handleFinishDrawing: () => void;
  handleUseMapView: () => void;
  playArea: PlayAreaFeatureCollection | null;
  clearPlayArea: () => void;
  setPlayAreaAndFit: (
    next: PlayAreaFeatureCollection,
    options?: { preserveData?: boolean },
  ) => void;
  stations: readonly CreatorPointItem[];
  layers: readonly CreatorGeometryLayer[];
  gameName: string;
  setGameName: (val: string) => void;
  hidingRadius: number;
  setHidingRadius: (val: number) => void;
  unit: DistanceUnit;
  setUnit: (val: DistanceUnit) => void;
  radarMode: "default" | "custom" | "off";
  setRadarMode: (val: "default" | "custom" | "off") => void;
  radarsText: string;
  setRadarsText: (val: string) => void;
  thermometer: boolean;
  setThermometer: (val: boolean) => void;
  stationNameLength: boolean;
  setStationNameLength: (val: boolean) => void;
  onNext: () => void;
}

export function CreatorAreaStep({
  scale,
  applyScalePreset,
  placeQuery,
  setPlaceQuery,
  placeSearching,
  placeError,
  placeResults,
  handlePlaceSearch,
  handlePickPlace,
  interactionMode,
  setInteractionMode,
  drawPoints,
  setDrawPoints,
  handleFinishDrawing,
  handleUseMapView,
  playArea,
  clearPlayArea,
  setPlayAreaAndFit,
  stations,
  layers,
  gameName,
  setGameName,
  hidingRadius,
  setHidingRadius,
  unit,
  setUnit,
  radarMode,
  setRadarMode,
  radarsText,
  setRadarsText,
  thermometer,
  setThermometer,
  stationNameLength,
  setStationNameLength,
  onNext,
}: Props) {
  const playAreaName =
    typeof playArea?.features[0]?.properties?.name === "string" &&
    playArea.features[0].properties.name.trim()
      ? playArea.features[0].properties.name
      : "Custom polygon";

  return (
    <>
      <section className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Quick-start preset
        </Label>
        <div className="grid grid-cols-3 gap-2">
          {(["small", "medium", "large"] as const).map((id) => {
            const p = SCALE_PRESETS[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => applyScalePreset(id)}
                className={cn(
                  "rounded-lg border p-2.5 text-left transition-colors",
                  scale === id
                    ? "border-primary bg-primary/10"
                    : "border-border bg-background/40 hover:bg-accent/50",
                )}
              >
                <div className="text-sm font-semibold">{p.label}</div>
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  {p.description}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Play area</Label>
        <form className="flex gap-2" onSubmit={(e) => void handlePlaceSearch(e)}>
          <RawInput
            placeholder="Search city or region (e.g. Zurich, Paris)…"
            value={placeQuery}
            onChange={(e) => setPlaceQuery(e.target.value)}
            disabled={placeSearching}
          />
          <Button type="submit" size="sm" disabled={placeSearching || !placeQuery.trim()}>
            <Search className="h-4 w-4" />
          </Button>
        </form>

        {placeError && <p className="text-xs text-destructive">{placeError}</p>}

        {placeResults.length > 0 && (
          <div className="divide-y divide-border rounded-lg border border-border bg-background/60">
            {placeResults.map((place) => (
              <button
                key={place.id}
                type="button"
                onClick={() => handlePickPlace(place)}
                className="flex w-full flex-col px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
              >
                <span className="font-medium text-foreground">{place.name}</span>
                <span className="truncate text-muted-foreground">{place.displayName}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={interactionMode === "draw-area" ? "default" : "outline"}
            onClick={() => {
              if (interactionMode === "draw-area") {
                setInteractionMode("browse");
                setDrawPoints([]);
              } else {
                setDrawPoints([]);
                setInteractionMode("draw-area");
              }
            }}
          >
            <PenTool className="mr-1.5 h-3.5 w-3.5" />
            {interactionMode === "draw-area" ? "Cancel drawing" : "Draw polygon"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={handleUseMapView}>
            Use current map view
          </Button>
          {playArea && (
            <Button type="button" size="sm" variant="ghost" onClick={clearPlayArea}>
              Clear
            </Button>
          )}
        </div>

        <PlayAreaTools
          stations={stations}
          layers={layers}
          onSetPlayArea={(nextArea, name, opts) => {
            setPlayAreaAndFit(nextArea, opts);
            if (name && !gameName.trim()) {
              setGameName(name);
            }
          }}
        />

        {interactionMode === "draw-area" && (
          <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">
            <p className="font-medium">
              Click on the map to place polygon corners ({drawPoints.length} placed).
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={drawPoints.length < 3}
                onClick={handleFinishDrawing}
              >
                <Check className="mr-1 h-3.5 w-3.5" />
                Finish polygon
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={drawPoints.length === 0}
                onClick={() => setDrawPoints((p) => p.slice(0, -1))}
              >
                Undo point
              </Button>
            </div>
          </div>
        )}

        {playArea && <p className="text-xs text-emerald-500">Play area set ({playAreaName}).</p>}
      </section>

      <Separator />

      <section className="space-y-3">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Game details & rules
        </Label>
        <div className="space-y-1.5">
          <Label htmlFor="creator-game-name" className="text-xs">
            Game name
          </Label>
          <RawInput
            id="creator-game-name"
            maxLength={120}
            placeholder="e.g. Zurich Casual"
            value={gameName}
            onChange={(e) => setGameName(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="creator-radius" className="text-xs">
              Hiding zone radius
            </Label>
            <RawInput
              id="creator-radius"
              type="number"
              min={1}
              step="any"
              value={hidingRadius}
              onChange={(e) => setHidingRadius(Number(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="creator-unit" className="text-xs">
              Distance unit
            </Label>
            <select
              id="creator-unit"
              value={unit}
              onChange={(e) => setUnit(e.target.value as DistanceUnit)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="meters">Meters</option>
              <option value="kilometers">Kilometers</option>
              <option value="miles">Miles</option>
            </select>
          </div>
        </div>

        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id="creator-radars"
              checked={radarMode !== "off"}
              onCheckedChange={(v) =>
                setRadarMode(v === true ? (radarsText.trim() ? "custom" : "default") : "off")
              }
            />
            <label htmlFor="creator-radars" className="cursor-pointer text-sm">
              Enable Radar questions
            </label>
          </div>
          {radarMode !== "off" && (
            <div className="space-y-1 pl-6">
              <Label htmlFor="creator-radar-presets" className="text-xs text-muted-foreground">
                Quick-pick radii ({unit}, comma-separated; leave blank for default)
              </Label>
              <RawInput
                id="creator-radar-presets"
                value={radarMode === "custom" ? radarsText : ""}
                onChange={(e) => {
                  const val = e.target.value;
                  setRadarsText(val);
                  setRadarMode(val.trim() ? "custom" : "default");
                }}
                placeholder={`Game default (or e.g. ${[250, 400, 800, 1500].map((m) => convertDistanceUnit(m, "meters", unit)).join(", ")})`}
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              id="creator-thermometer"
              checked={thermometer}
              onCheckedChange={(v) => setThermometer(v === true)}
            />
            <label htmlFor="creator-thermometer" className="cursor-pointer text-sm">
              Enable Thermometer questions
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="creator-station-name-length"
              checked={stationNameLength}
              onCheckedChange={(v) => setStationNameLength(v === true)}
            />
            <label htmlFor="creator-station-name-length" className="cursor-pointer text-sm">
              Enable Station Name Length questions
            </label>
          </div>
        </div>
      </section>

      <Button type="button" className="w-full" onClick={onNext}>
        Next: Stations →
      </Button>
    </>
  );
}
