import {
  FEATURE_ICONS,
  type FeatureEnabledFor,
  type FeatureIcon,
  type PlayAreaFeatureCollection,
} from "@searchlight/shared";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
  BookOpen,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FerrisWheel,
  FileUp,
  Film,
  Fish,
  Flag,
  Globe,
  GraduationCap,
  Hospital,
  Landmark,
  type LucideIcon,
  MapPin,
  Minimize2,
  Mountain,
  PawPrint,
  Pencil,
  Plane,
  RefreshCw,
  Sparkles,
  Star,
  TrainFront,
  Trash2,
  Trees,
  Trophy,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { type CreatorGeometryLayer, layerSlugOf } from "@/lib/creator/assemble";
import {
  countGeometryVertices,
  type CreatorGeoFeatureItem,
  simplifyLineLayerTopology,
  simplifyPolygonLayerTopology,
} from "@/lib/creator/osmGeometry";
import { fetchPoiLayersFromOsm } from "@/lib/creator/overpass";
import { FEATURE_ICON_META, inferLayerIcon, MY_MAPS_PALETTE } from "@/lib/creator/presets";
import { fetchPoiLayerFromQlever, osmFilterToSparqlPatterns } from "@/lib/creator/qlever";
import { cn } from "@/lib/utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

const HEAVY_VERTEX_WARNING = 20_000;

const FEATURE_ICON_COMPONENTS: Record<FeatureIcon, LucideIcon> = {
  pin: MapPin,
  station: TrainFront,
  airport: Plane,
  aquarium: Fish,
  cinema: Film,
  consulate: Building2,
  golf: Flag,
  hospital: Hospital,
  library: BookOpen,
  mountain: Mountain,
  museum: Landmark,
  park: Trees,
  stadium: Trophy,
  star: Star,
  "theme-park": FerrisWheel,
  university: GraduationCap,
  zoo: PawPrint,
};

export interface SimplifyPreviewState {
  layerId: string;
  layerName: string;
  family: "polygons" | "lines";
  toleranceMeters: number;
  originalVertices: number;
  vertexCount: number;
  sourceItems: CreatorGeoFeatureItem[];
  items: CreatorGeoFeatureItem[];
}

interface Props {
  layers: CreatorGeometryLayer[];
  setLayers: React.Dispatch<React.SetStateAction<CreatorGeometryLayer[]>>;
  visibleLayerIds: Set<string>;
  setVisibleLayerIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  playArea: PlayAreaFeatureCollection | null;
  playAreaOsmRelationId?: number | null;
  playAreaGenRef: React.MutableRefObject<number>;
  poiBufferKm: number;
  preferEnglishName: boolean;
  customEndpoint: string;
  simplifyPreview?: SimplifyPreviewState | null;
  onSimplifyPreviewChange?: (preview: SimplifyPreviewState | null) => void;
  onOpenImportTab: () => void;
  onOpenOsmTab: () => void;
}

export function CreatorLayersList({
  layers,
  setLayers,
  visibleLayerIds,
  setVisibleLayerIds,
  playArea,
  playAreaOsmRelationId = null,
  playAreaGenRef,
  poiBufferKm,
  preferEnglishName,
  customEndpoint,
  simplifyPreview = null,
  onSimplifyPreviewChange,
  onOpenImportTab,
  onOpenOsmTab,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fixingOverlapId, setFixingOverlapId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [simplifyingId, setSimplifyingId] = useState<string | null>(null);
  const [simplifyTolerance, setSimplifyTolerance] = useState(10);
  const [stylingId, setStylingId] = useState<string | null>(null);

  const hasPlayArea = Boolean(playArea && playArea.features.length > 0);

  const simplifyingLayer = simplifyingId
    ? (layers.find((l) => l.id === simplifyingId) ?? null)
    : null;

  const simplifyLayerId = simplifyingLayer?.id ?? null;
  const simplifyLayerName = simplifyingLayer?.name ?? "";
  const simplifyLayerFamily = simplifyingLayer?.family ?? null;
  const simplifyLayerItems = simplifyingLayer?.items ?? null;
  const simplifyLayerVertices = simplifyingLayer?.vertexCount ?? 0;

  // Live debounced simplification preview rendered on the map before overwriting.
  useEffect(() => {
    if (
      !simplifyLayerId ||
      !simplifyLayerItems ||
      !simplifyLayerFamily ||
      simplifyLayerFamily === "points"
    ) {
      onSimplifyPreviewChange?.(null);
      return;
    }
    const tol = Math.max(1, Math.min(500, Math.round(simplifyTolerance)));
    const timer = window.setTimeout(() => {
      const result =
        simplifyLayerFamily === "polygons"
          ? simplifyPolygonLayerTopology(simplifyLayerItems, tol)
          : simplifyLineLayerTopology(simplifyLayerItems, tol);
      onSimplifyPreviewChange?.({
        layerId: simplifyLayerId,
        layerName: simplifyLayerName,
        family: simplifyLayerFamily,
        toleranceMeters: tol,
        originalVertices: simplifyLayerVertices,
        vertexCount: result.vertexCount,
        sourceItems: simplifyLayerItems,
        items: result.items,
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    simplifyLayerId,
    simplifyLayerName,
    simplifyLayerFamily,
    simplifyLayerItems,
    simplifyLayerVertices,
    simplifyTolerance,
    onSimplifyPreviewChange,
  ]);

  useEffect(() => {
    return () => {
      onSimplifyPreviewChange?.(null);
    };
  }, [onSimplifyPreviewChange]);

  const handleCommitRename = (layerId: string) => {
    const trimmed = renameDraft.trim();
    const slug = layerSlugOf(trimmed);
    if (!trimmed || !slug) {
      toast.error("Layer name must include at least one ASCII letter or digit (a–z, 0–9).");
      return;
    }
    const collision = layers.find((l) => l.id !== layerId && layerSlugOf(l.name) === slug);
    if (collision) {
      toast.error(`Layer name "${trimmed}" shares ID "${slug}" with "${collision.name}".`);
      return;
    }
    setLayers((prev) => prev.map((l) => (l.id === layerId ? { ...l, name: trimmed } : l)));
    setRenamingId(null);
  };

  const handleSimplifyLayer = (layer: CreatorGeometryLayer, toleranceMeters: number) => {
    if (layer.family === "points") return;
    const tol = Math.max(1, Math.min(500, Math.round(toleranceMeters)));
    const before = layer.vertexCount;
    const readyPreview =
      simplifyPreview &&
      simplifyPreview.layerId === layer.id &&
      simplifyPreview.toleranceMeters === tol &&
      simplifyPreview.sourceItems === layer.items
        ? simplifyPreview
        : null;
    const result =
      readyPreview ??
      (layer.family === "polygons"
        ? simplifyPolygonLayerTopology(layer.items, tol)
        : simplifyLineLayerTopology(layer.items, tol));
    setLayers((prev) =>
      prev.map((l) =>
        l.id === layer.id
          ? {
              ...l,
              items: result.items,
              vertexCount: result.vertexCount,
              ...(l.family === "polygons" && { noOverlaps: false }),
            }
          : l,
      ),
    );
    setSimplifyingId(null);
    onSimplifyPreviewChange?.(null);
    toast.success(
      `Simplified "${layer.name}": ${before.toLocaleString()} → ${result.vertexCount.toLocaleString()} vertices (${tol} m)`,
    );
  };

  const handleRefreshOsmPoiLayer = async (layer: CreatorGeometryLayer) => {
    if (!hasPlayArea || !playArea || !layer.osmFilter) return;
    const areaGen = playAreaGenRef.current;
    setRefreshingId(layer.id);
    try {
      const useQlever =
        !customEndpoint.trim() && osmFilterToSparqlPatterns(layer.osmFilter) !== null;
      const rawPts = useQlever
        ? (
            await fetchPoiLayerFromQlever({
              id: layer.id,
              name: layer.name,
              osmFilter: layer.osmFilter,
              notableOnly: layer.notableOnly,
              playArea,
              playAreaOsmRelationId,
              bufferKm: poiBufferKm,
              preferEnglishName,
            })
          ).items
        : ((
            await fetchPoiLayersFromOsm({
              layers: [
                {
                  id: layer.id,
                  name: layer.name,
                  osmFilter: layer.osmFilter,
                  notableOnly: layer.notableOnly,
                },
              ],
              playArea,
              bufferKm: poiBufferKm,
              preferEnglishName,
              customEndpoint: customEndpoint.trim() || undefined,
            })
          ).byLayerId[layer.id] ?? []);
      if (playAreaGenRef.current !== areaGen) return;
      const items = rawPts.map((pt) => ({
        uid: pt.uid,
        name: pt.name,
        geometry: {
          type: "Point" as const,
          coordinates: [pt.lng, pt.lat] as [number, number],
        },
        enabled: true,
      }));
      setLayers((prev) =>
        prev.map((l) => (l.id === layer.id ? { ...l, items, vertexCount: items.length } : l)),
      );
      toast.success(`Refreshed "${layer.name}" (${items.length} places)`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to refresh "${layer.name}" from OSM.`,
      );
    } finally {
      setRefreshingId((cur) => (cur === layer.id ? null : cur));
    }
  };

  const handleFixOverlaps = async (layer: CreatorGeometryLayer) => {
    if (layer.family !== "polygons") return;
    const activeItems = layer.items.filter((i) => i.enabled);
    if (activeItems.length === 0) return;

    const areaGen = playAreaGenRef.current;
    const activeUids = activeItems.map((i) => i.uid);
    setFixingOverlapId(layer.id);
    try {
      const regions: Feature<Polygon | MultiPolygon>[] = activeItems.map((item) => ({
        type: "Feature",
        properties: { name: item.name },
        geometry: item.geometry as Polygon | MultiPolygon,
      }));
      const fixedRegions = await requestGeometry({
        kind: "removeRegionOverlaps",
        regions,
      });
      if (playAreaGenRef.current !== areaGen) return;
      let applied = false;
      let stale = false;
      setLayers((prev) =>
        prev.map((l) => {
          if (l.id !== layer.id) return l;
          const currentActiveUids = l.items.filter((i) => i.enabled).map((i) => i.uid);
          if (
            currentActiveUids.length !== activeUids.length ||
            currentActiveUids.some((u, i) => u !== activeUids[i])
          ) {
            stale = true;
            return l;
          }
          let fixedIdx = 0;
          const nextItems = l.items.map((item) => {
            if (!item.enabled) return item;
            const fixed = fixedRegions[fixedIdx++];
            return {
              ...item,
              geometry: fixed.geometry as typeof item.geometry,
            };
          });
          const nextVertices = nextItems.reduce(
            (sum, item) => sum + countGeometryVertices(item.geometry),
            0,
          );
          applied = true;
          return {
            ...l,
            items: nextItems,
            vertexCount: nextVertices,
            noOverlaps: true,
          };
        }),
      );
      if (stale) {
        toast.warn(
          `Layer "${layer.name}" changed while fixing overlaps. Click Fix overlaps again.`,
        );
      } else if (applied) {
        toast.success(`Fixed overlaps and marked "${layer.name}" as noOverlaps`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check/fix region overlaps.");
    } finally {
      setFixingOverlapId((cur) => (cur === layer.id ? null : cur));
    }
  };

  if (layers.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed border-border bg-background/40 p-5 text-center">
        <p className="text-sm font-medium">No feature layers yet</p>
        <p className="text-xs text-muted-foreground">
          Feature layers are optional (radars &amp; thermometers work with stations alone). Add
          POIs, admin regions, or lines from a file or from OpenStreetMap:
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-1">
          <Button type="button" size="sm" variant="default" onClick={onOpenImportTab}>
            <FileUp className="mr-1.5 h-3.5 w-3.5" />
            Import KML / GeoJSON / CSV
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onOpenOsmTab}>
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Fetch from OpenStreetMap
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Checked layers are included in the exported game.</span>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onOpenImportTab}
            className="font-medium text-primary hover:underline"
          >
            + Import
          </button>
          <button
            type="button"
            onClick={onOpenOsmTab}
            className="font-medium text-primary hover:underline"
          >
            + OSM
          </button>
        </div>
      </div>

      {layers.map((layer) => {
        const activeCount = layer.items.filter((i) => i.enabled).length;
        const visible = visibleLayerIds.has(layer.id);
        const expanded = expandedId === layer.id;
        const allowedKinds: readonly [FeatureEnabledFor, string][] =
          layer.family === "points"
            ? [
                ["matching", "Match"],
                ["measuring", "Measure"],
                ["tentacle", "Tentacle"],
              ]
            : [
                ["matching", "Match"],
                ["measuring", "Measure"],
              ];

        return (
          <div key={layer.id} className="rounded-lg border border-border bg-background/40 p-2.5">
            <div className="flex items-center gap-2">
              <Checkbox
                aria-label={`Include ${layer.name} in game`}
                checked={layer.selected}
                onCheckedChange={(v) =>
                  setLayers((prev) =>
                    prev.map((l) => (l.id === layer.id ? { ...l, selected: v === true } : l)),
                  )
                }
              />
              {(() => {
                const resolvedIcon: FeatureIcon = layer.icon ?? inferLayerIcon(layer.name);
                const IconComp =
                  layer.family === "points" ? FEATURE_ICON_COMPONENTS[resolvedIcon] : null;
                return (
                  <button
                    type="button"
                    title="Change layer color & icon"
                    onClick={() => setStylingId((cur) => (cur === layer.id ? null : layer.id))}
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white shadow-sm ring-offset-background transition-transform hover:scale-110",
                      stylingId === layer.id && "ring-2 ring-primary ring-offset-1",
                    )}
                    style={{ backgroundColor: layer.color }}
                  >
                    {IconComp ? <IconComp className="h-3 w-3" /> : null}
                  </button>
                );
              })()}
              <div className="min-w-0 flex-1">
                {renamingId === layer.id ? (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleCommitRename(layer.id);
                        } else if (e.key === "Escape") {
                          setRenamingId(null);
                        }
                      }}
                      className="h-6 px-1.5 text-xs"
                    />
                    <button
                      type="button"
                      title="Save name"
                      onClick={() => handleCommitRename(layer.id)}
                      className="text-emerald-500 hover:text-emerald-400"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Cancel rename"
                      onClick={() => setRenamingId(null)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <p
                      className={cn(
                        "truncate text-sm font-medium",
                        !layer.selected && "text-muted-foreground line-through",
                      )}
                    >
                      {layer.name}
                    </p>
                    <button
                      type="button"
                      title="Rename layer"
                      onClick={() => {
                        setRenamingId(layer.id);
                        setRenameDraft(layer.name);
                      }}
                      className="shrink-0 text-muted-foreground/70 hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <p className="truncate text-[11px] text-muted-foreground">
                  {activeCount}/{layer.items.length} {layer.family}
                  {layer.family !== "points" && (
                    <>
                      {" · "}
                      <span
                        className={cn(layer.vertexCount > HEAVY_VERTEX_WARNING && "text-amber-300")}
                      >
                        {layer.vertexCount.toLocaleString()} pts
                      </span>
                    </>
                  )}{" "}
                  · {layer.sourceLabel}
                  {layer.kmlFolder && layer.kmlFolder !== layer.name && (
                    <> · KML: {layer.kmlFolder}</>
                  )}
                </p>
              </div>
              {layer.osmFilter && (
                <button
                  type="button"
                  title="Refresh this layer from OpenStreetMap"
                  disabled={!hasPlayArea || refreshingId === layer.id}
                  onClick={() => void handleRefreshOsmPoiLayer(layer)}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <RefreshCw
                    className={cn("h-3.5 w-3.5", refreshingId === layer.id && "animate-spin")}
                  />
                </button>
              )}
              <button
                type="button"
                title={visible ? "Hide on map" : "Show on map"}
                onClick={() =>
                  setVisibleLayerIds((prev) => {
                    const next = new Set(prev);
                    if (visible) next.delete(layer.id);
                    else next.add(layer.id);
                    return next;
                  })
                }
                className="text-muted-foreground hover:text-foreground"
              >
                {visible ? (
                  <Eye className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                title="Inspect features"
                onClick={() => setExpandedId(expanded ? null : layer.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <button
                type="button"
                aria-label={`Remove ${layer.name}`}
                onClick={() => {
                  setLayers((prev) => prev.filter((l) => l.id !== layer.id));
                  setVisibleLayerIds((prev) => {
                    const next = new Set(prev);
                    next.delete(layer.id);
                    return next;
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>

            {stylingId === layer.id && (
              <div className="mt-2 space-y-2 rounded border border-border bg-card p-2 text-[11px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-muted-foreground">
                    Color
                    {layer.family === "points" ? " & My Maps icon" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => setStylingId(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    Done
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {MY_MAPS_PALETTE.map((hex) => {
                    const active = layer.color.toUpperCase() === hex.toUpperCase();
                    return (
                      <button
                        key={hex}
                        type="button"
                        title={hex}
                        onClick={() =>
                          setLayers((prev) =>
                            prev.map((l) =>
                              l.id === layer.id
                                ? {
                                    ...l,
                                    color: hex,
                                  }
                                : l,
                            ),
                          )
                        }
                        className={cn(
                          "h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110",
                          active && "ring-2 ring-primary ring-offset-1 ring-offset-card",
                        )}
                        style={{ backgroundColor: hex }}
                      />
                    );
                  })}
                  <label
                    title="Custom hex color"
                    className="inline-flex h-5 cursor-pointer items-center rounded border border-border px-1 text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    <span>Custom</span>
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(layer.color) ? layer.color : "#0288D1"}
                      onChange={(e) => {
                        const nextColor = e.target.value.toUpperCase();
                        setLayers((prev) =>
                          prev.map((l) =>
                            l.id === layer.id
                              ? {
                                  ...l,
                                  color: nextColor,
                                }
                              : l,
                          ),
                        );
                      }}
                      className="sr-only"
                    />
                  </label>
                </div>
                {layer.family === "points" && (
                  <div className="grid grid-cols-6 gap-1 border-t border-border pt-2">
                    {FEATURE_ICONS.map((iconKey) => {
                      const IconComp = FEATURE_ICON_COMPONENTS[iconKey];
                      const active = (layer.icon ?? inferLayerIcon(layer.name)) === iconKey;
                      return (
                        <button
                          key={iconKey}
                          type="button"
                          title={FEATURE_ICON_META[iconKey].label}
                          onClick={() =>
                            setLayers((prev) =>
                              prev.map((l) =>
                                l.id === layer.id
                                  ? {
                                      ...l,
                                      icon: iconKey,
                                    }
                                  : l,
                              ),
                            )
                          }
                          className={cn(
                            "flex items-center justify-center rounded border p-1.5 transition-colors",
                            active
                              ? "border-primary bg-primary/15 text-foreground"
                              : "border-border text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <IconComp className="h-3.5 w-3.5" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {layer.selected && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-6 text-[11px]">
                <div className="flex gap-1">
                  {allowedKinds.map(([kind, label]) => {
                    const on = layer.enabledFor.includes(kind);
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() =>
                          setLayers((prev) =>
                            prev.map((l) => {
                              if (l.id !== layer.id) return l;
                              if (on && l.enabledFor.length <= 1) {
                                return l;
                              }
                              return {
                                ...l,
                                enabledFor: on
                                  ? l.enabledFor.filter((k) => k !== kind)
                                  : [...l.enabledFor, kind],
                              };
                            }),
                          )
                        }
                        className={cn(
                          "rounded border px-1.5 py-0.5 transition-colors",
                          on
                            ? "border-primary/60 bg-primary/15 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2.5">
                  {layer.family !== "points" && (
                    <button
                      type="button"
                      title="Topology-preserving simplification (keeps shared borders aligned)"
                      onClick={() => {
                        const opening = simplifyingId !== layer.id;
                        setSimplifyingId(opening ? layer.id : null);
                        setSimplifyTolerance(10);
                        if (opening) {
                          setVisibleLayerIds((prev) => new Set(prev).add(layer.id));
                        } else {
                          onSimplifyPreviewChange?.(null);
                        }
                      }}
                      className={cn(
                        "inline-flex items-center gap-1 hover:underline",
                        layer.vertexCount > HEAVY_VERTEX_WARNING
                          ? "font-medium text-amber-300"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Minimize2 className="h-3 w-3" />
                      Simplify
                    </button>
                  )}
                  {layer.family === "polygons" &&
                    (layer.noOverlaps ? (
                      <span className="inline-flex items-center gap-1 text-emerald-500">
                        <CheckCircle2 className="h-3 w-3" />
                        noOverlaps
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={fixingOverlapId === layer.id}
                        onClick={() => void handleFixOverlaps(layer)}
                        className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
                      >
                        <Sparkles className="h-3 w-3" />
                        {fixingOverlapId === layer.id ? "Fixing…" : "Fix overlaps"}
                      </button>
                    ))}
                </div>
              </div>
            )}

            {simplifyingId === layer.id && layer.family !== "points" && (
              <div className="mt-2 space-y-1.5 rounded border border-border bg-card p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    title="Maximum distance (in meters) the simplified line or border is allowed to deviate from the original path. Lower stays closer to original; higher removes more vertices."
                    className="cursor-help text-muted-foreground underline decoration-dotted underline-offset-2"
                  >
                    Max error (m):
                  </span>
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={simplifyTolerance}
                    onChange={(e) =>
                      setSimplifyTolerance(Math.max(1, Math.min(500, Number(e.target.value) || 1)))
                    }
                    className="h-6 w-16 px-1.5 text-xs"
                  />
                  {[10, 25, 50].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSimplifyTolerance(preset)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[10px]",
                        simplifyTolerance === preset
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {preset}m
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => {
                        setSimplifyingId(null);
                        onSimplifyPreviewChange?.(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => handleSimplifyLayer(layer, simplifyTolerance)}
                    >
                      Apply
                    </Button>
                  </div>
                </div>
                {(() => {
                  const activePrev =
                    simplifyPreview &&
                    simplifyPreview.layerId === layer.id &&
                    simplifyPreview.toleranceMeters ===
                      Math.max(1, Math.min(500, Math.round(simplifyTolerance)))
                      ? simplifyPreview
                      : null;
                  if (!activePrev) {
                    return (
                      <p className="text-[10px] text-muted-foreground">
                        Computing live map preview…
                      </p>
                    );
                  }
                  const savedPct =
                    activePrev.originalVertices > 0
                      ? Math.round(
                          ((activePrev.originalVertices - activePrev.vertexCount) /
                            activePrev.originalVertices) *
                            100,
                        )
                      : 0;
                  return (
                    <p className="text-[10px] text-amber-300">
                      Preview: {activePrev.originalVertices.toLocaleString()} →{" "}
                      {activePrev.vertexCount.toLocaleString()} pts (
                      {savedPct >= 0 ? `-${savedPct}%` : `+${Math.abs(savedPct)}%`}) · dashed amber
                      on map
                    </p>
                  );
                })()}
                <p className="text-[10px] text-muted-foreground">
                  Dropped vertices stay within this max distance of the simplified border. Shared
                  borders stay aligned without gaps.
                </p>
              </div>
            )}

            {expanded && (
              <div className="mt-2 max-h-40 divide-y divide-border overflow-y-auto rounded border border-border bg-card">
                {layer.items.map((item) => (
                  <label
                    key={item.uid}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs"
                  >
                    <Checkbox
                      checked={item.enabled}
                      onCheckedChange={(v) =>
                        setLayers((prev) =>
                          prev.map((l) => {
                            if (l.id !== layer.id) {
                              return l;
                            }
                            const reenabled = v === true && !item.enabled;
                            return {
                              ...l,
                              noOverlaps: reenabled ? false : l.noOverlaps,
                              items: l.items.map((x) =>
                                x.uid === item.uid
                                  ? {
                                      ...x,
                                      enabled: v === true,
                                    }
                                  : x,
                              ),
                            };
                          }),
                        )
                      }
                    />
                    <span
                      className={cn(
                        "truncate",
                        !item.enabled && "text-muted-foreground line-through",
                      )}
                    >
                      {item.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
