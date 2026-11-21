import type {
  DistanceUnit,
  GameDefinition,
  HidingZoneFeature,
  PlayAreaFeatureCollection,
} from "@searchlight/shared";
import { Code2, MapPin, RefreshCw, Trash2, X } from "lucide-react";

import { StationFileImporter } from "@/components/StationFileImporter";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { CreatorPointItem } from "@/lib/creator/overpass";
import { getStationPreset, STATION_PRESETS, type StationPresetId } from "@/lib/creator/presets";
import { cn } from "@/lib/utils";

interface Props {
  playArea: PlayAreaFeatureCollection | null;
  hasPlayAreaGeometry: boolean;
  stationPreset: StationPresetId;
  setStationPreset: (id: StationPresetId) => void;
  customStationFilter: string;
  setCustomStationFilter: (val: string) => void;
  dedupeMeters: number;
  setDedupeMeters: (val: number) => void;
  preferEnglishName: boolean;
  setPreferEnglishName: (val: boolean) => void;
  showStationQuery: boolean;
  setShowStationQuery: React.Dispatch<React.SetStateAction<boolean>>;
  stationRawQuery: string | null;
  setStationRawQuery: (val: string | null) => void;
  generatedStationQuery: string;
  stationBusy: string | null;
  stationError: string | null;
  stationSummary: string | null;
  handleFetchStations: () => Promise<void>;
  onAbortStationFetch: () => void;
  stations: CreatorPointItem[];
  setStations: React.Dispatch<React.SetStateAction<CreatorPointItem[]>>;
  filteredStations: CreatorPointItem[];
  activeStationCount: number;
  extraHidingZones: HidingZoneFeature[];
  onImportStations: (imported: CreatorPointItem[], replace: boolean) => void;
  onClearStations: () => void;
  onLoadGameDefinition: (def: GameDefinition) => void;
  interactionMode: "browse" | "draw-area" | "add-station";
  setInteractionMode: React.Dispatch<React.SetStateAction<"browse" | "draw-area" | "add-station">>;
  showZoneCircles: boolean;
  setShowZoneCircles: (val: boolean) => void;
  unit: DistanceUnit;
  tierNames: string[];
  tierOverrides: Record<string, number>;
  setTierOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  newTierName: string;
  setNewTierName: (val: string) => void;
  newTierRadius: string;
  setNewTierRadius: (val: string) => void;
  handleAddTier: (e: React.FormEvent) => void;
  stationSearch: string;
  setStationSearch: (val: string) => void;
  onNext: () => void;
}

export function CreatorStationsStep({
  playArea,
  hasPlayAreaGeometry,
  stationPreset,
  setStationPreset,
  customStationFilter,
  setCustomStationFilter,
  dedupeMeters,
  setDedupeMeters,
  preferEnglishName,
  setPreferEnglishName,
  showStationQuery,
  setShowStationQuery,
  stationRawQuery,
  setStationRawQuery,
  generatedStationQuery,
  stationBusy,
  stationError,
  stationSummary,
  handleFetchStations,
  onAbortStationFetch,
  stations,
  setStations,
  filteredStations,
  activeStationCount,
  extraHidingZones,
  onImportStations,
  onClearStations,
  onLoadGameDefinition,
  interactionMode,
  setInteractionMode,
  showZoneCircles,
  setShowZoneCircles,
  unit,
  tierNames,
  tierOverrides,
  setTierOverrides,
  newTierName,
  setNewTierName,
  newTierRadius,
  setNewTierRadius,
  handleAddTier,
  stationSearch,
  setStationSearch,
  onNext,
}: Props) {
  return (
    <>
      {!playArea && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          Set a play area in Step 1 before fetching stations.
        </div>
      )}

      <section className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="creator-station-preset" className="text-xs">
            Transit stop preset
          </Label>
          <select
            id="creator-station-preset"
            value={stationPreset}
            onChange={(e) => setStationPreset(e.target.value as StationPresetId)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {STATION_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {getStationPreset(stationPreset).description}
          </p>
        </div>

        {stationPreset === "custom" && (
          <div className="space-y-1">
            <Label htmlFor="creator-custom-station-filter" className="text-xs">
              Custom OSM tag filter
            </Label>
            <Input
              id="creator-custom-station-filter"
              value={customStationFilter}
              onChange={(e) => setCustomStationFilter(e.target.value)}
              placeholder='["amenity"="ferry_terminal"]'
              className="font-mono text-xs"
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="creator-dedupe" className="text-xs text-muted-foreground">
              Merge same-name within (m)
            </Label>
            <Input
              id="creator-dedupe"
              type="number"
              min={0}
              max={2000}
              value={dedupeMeters}
              onChange={(e) => setDedupeMeters(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
          <div className="flex items-end pb-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="creator-en-names"
                checked={preferEnglishName}
                onCheckedChange={(v) => setPreferEnglishName(v === true)}
              />
              <label htmlFor="creator-en-names" className="cursor-pointer text-xs">
                Prefer English names
              </label>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowStationQuery((v) => !v)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>{showStationQuery ? "▾" : "▸"} Inspect / edit Overpass query</span>
              {stationRawQuery !== null && (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  edited
                </span>
              )}
            </button>
            {showStationQuery && stationRawQuery !== null && (
              <button
                type="button"
                onClick={() => setStationRawQuery(null)}
                className="text-[11px] text-primary hover:underline"
              >
                Reset to preset
              </button>
            )}
          </div>
          {showStationQuery && (
            <div className="space-y-1">
              <textarea
                rows={5}
                spellCheck={false}
                disabled={!hasPlayAreaGeometry}
                value={stationRawQuery ?? generatedStationQuery}
                onChange={(e) => setStationRawQuery(e.target.value)}
                placeholder="Set a play area in Step 1 to generate the Overpass QL query."
                className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] leading-relaxed outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              <p className="text-[11px] text-muted-foreground">
                Edit the Overpass QL directly to tweak tags or add clauses. Returned points are
                still clipped to your play area and deduplicated.
              </p>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            className="flex-1"
            disabled={!hasPlayAreaGeometry || Boolean(stationBusy)}
            onClick={() => void handleFetchStations()}
          >
            <RefreshCw className={cn("mr-1.5 h-4 w-4", stationBusy && "animate-spin")} />
            {stationBusy ? "Fetching…" : "Fetch stations from OSM"}
          </Button>
          {stationBusy && (
            <Button type="button" variant="outline" onClick={onAbortStationFetch}>
              Cancel
            </Button>
          )}
        </div>

        {stationBusy && <p className="text-xs text-muted-foreground">{stationBusy}</p>}
        {stationError && <p className="text-xs text-destructive">{stationError}</p>}
        {stationSummary && !stationBusy && (
          <p className="text-xs text-emerald-500">{stationSummary}</p>
        )}
      </section>

      <StationFileImporter
        existingStationCount={stations.length}
        onImportStations={onImportStations}
        onLoadGameDefinition={onLoadGameDefinition}
      />

      <Separator />

      {/* Map curation & tiers */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={interactionMode === "add-station" ? "default" : "outline"}
            onClick={() =>
              setInteractionMode((m) => (m === "add-station" ? "browse" : "add-station"))
            }
          >
            <MapPin className="mr-1.5 h-3.5 w-3.5" />
            {interactionMode === "add-station" ? "Done adding stops" : "Click map to add stop"}
          </Button>
          <div className="flex items-center gap-1.5 text-xs">
            <Checkbox
              id="creator-show-circles"
              checked={showZoneCircles}
              onCheckedChange={(v) => setShowZoneCircles(v === true)}
            />
            <label htmlFor="creator-show-circles" className="cursor-pointer">
              Show zone circles
            </label>
          </div>
        </div>

        {/* Optional radius tiers */}
        <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            Optional radius tiers (e.g. Outer = 600 {unit})
          </p>
          {tierNames.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tierNames.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs"
                >
                  {name}: {tierOverrides[name]} {unit}
                  <button
                    type="button"
                    aria-label={`Remove tier ${name}`}
                    onClick={() =>
                      setTierOverrides((prev) => {
                        const next = { ...prev };
                        delete next[name];
                        return next;
                      })
                    }
                  >
                    <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <form className="flex gap-1.5" onSubmit={handleAddTier}>
            <Input
              placeholder="Tier name"
              value={newTierName}
              onChange={(e) => setNewTierName(e.target.value)}
              className="h-8 text-xs"
            />
            <Input
              type="number"
              min={1}
              step="any"
              placeholder="Radius"
              value={newTierRadius}
              onChange={(e) => setNewTierRadius(e.target.value)}
              className="h-8 w-24 text-xs"
            />
            <Button type="submit" size="sm" variant="secondary" className="h-8">
              Add
            </Button>
          </form>
        </div>

        {/* Station list */}
        {stations.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                {activeStationCount} of {stations.length} enabled (click pins on map to toggle)
              </span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() =>
                    setStations((prev) =>
                      prev.map((s) => ({
                        ...s,
                        enabled: true,
                      })),
                    )
                  }
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    setStations((prev) =>
                      prev.map((s) => ({
                        ...s,
                        enabled: false,
                      })),
                    )
                  }
                >
                  None
                </button>
                <button
                  type="button"
                  className="text-destructive hover:underline"
                  onClick={onClearStations}
                >
                  Clear
                </button>
              </div>
            </div>

            <Input
              placeholder="Filter stations…"
              value={stationSearch}
              onChange={(e) => setStationSearch(e.target.value)}
              className="h-8 text-xs"
            />

            <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background/40">
              {filteredStations.map((s) => (
                <div key={s.uid} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                  <Checkbox
                    checked={s.enabled}
                    onCheckedChange={(v) =>
                      setStations((prev) =>
                        prev.map((x) =>
                          x.uid === s.uid
                            ? {
                                ...x,
                                enabled: v === true,
                              }
                            : x,
                        ),
                      )
                    }
                  />
                  <input
                    type="text"
                    value={s.name}
                    aria-label={`Station name ${s.name}`}
                    onChange={(e) =>
                      setStations((prev) =>
                        prev.map((x) =>
                          x.uid === s.uid
                            ? {
                                ...x,
                                name: e.target.value,
                                nameEdited: true,
                              }
                            : x,
                        ),
                      )
                    }
                    className={cn(
                      "min-w-0 flex-1 bg-transparent outline-none focus:underline",
                      !s.enabled && "text-muted-foreground line-through",
                    )}
                  />
                  {tierNames.length > 0 && (
                    <select
                      value={s.tier ?? ""}
                      aria-label={`Tier for ${s.name}`}
                      onChange={(e) =>
                        setStations((prev) =>
                          prev.map((x) =>
                            x.uid === s.uid
                              ? {
                                  ...x,
                                  tier: e.target.value || undefined,
                                }
                              : x,
                          ),
                        )
                      }
                      className="h-6 rounded border border-border bg-background px-1 text-[11px]"
                    >
                      <option value="">Base</option>
                      {tierNames.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  )}
                  {s.custom && (
                    <button
                      type="button"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => setStations((prev) => prev.filter((x) => x.uid !== s.uid))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <Button
        type="button"
        className="w-full"
        disabled={activeStationCount === 0 && extraHidingZones.length === 0}
        onClick={onNext}
      >
        Next: Feature Layers →
      </Button>
    </>
  );
}
