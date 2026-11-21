import type {
    FeatureEnabledFor,
    PlayAreaFeatureCollection,
} from "@searchlight/shared";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import {
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Eye,
    EyeOff,
    FileUp,
    Globe,
    RefreshCw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { CreatorGeometryLayer } from "@/lib/creator/assemble";
import { countGeometryVertices } from "@/lib/creator/osmGeometry";
import { fetchPoiLayersFromOsm } from "@/lib/creator/overpass";
import { cn } from "@/lib/utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

const HEAVY_VERTEX_WARNING = 20_000;

interface Props {
    layers: CreatorGeometryLayer[];
    setLayers: React.Dispatch<React.SetStateAction<CreatorGeometryLayer[]>>;
    visibleLayerIds: Set<string>;
    setVisibleLayerIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    playArea: PlayAreaFeatureCollection | null;
    playAreaGenRef: React.MutableRefObject<number>;
    poiBufferKm: number;
    preferEnglishName: boolean;
    customEndpoint: string;
    onOpenImportTab: () => void;
    onOpenOsmTab: () => void;
}

export function CreatorLayersList({
    layers,
    setLayers,
    visibleLayerIds,
    setVisibleLayerIds,
    playArea,
    playAreaGenRef,
    poiBufferKm,
    preferEnglishName,
    customEndpoint,
    onOpenImportTab,
    onOpenOsmTab,
}: Props) {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [fixingOverlapId, setFixingOverlapId] = useState<string | null>(null);
    const [refreshingId, setRefreshingId] = useState<string | null>(null);

    const hasPlayArea = Boolean(playArea && playArea.features.length > 0);

    const handleRefreshOsmPoiLayer = async (layer: CreatorGeometryLayer) => {
        if (!hasPlayArea || !playArea || !layer.osmFilter) return;
        const areaGen = playAreaGenRef.current;
        setRefreshingId(layer.id);
        try {
            const result = await fetchPoiLayersFromOsm({
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
            });
            if (playAreaGenRef.current !== areaGen) return;
            const rawPts = result.byLayerId[layer.id] ?? [];
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
                prev.map((l) =>
                    l.id === layer.id
                        ? { ...l, items, vertexCount: items.length }
                        : l,
                ),
            );
            toast.success(
                `Refreshed "${layer.name}" (${items.length} places)`,
            );
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : `Failed to refresh "${layer.name}" from OSM.`,
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
            const regions: Feature<Polygon | MultiPolygon>[] = activeItems.map(
                (item) => ({
                    type: "Feature",
                    properties: { name: item.name },
                    geometry: item.geometry as Polygon | MultiPolygon,
                }),
            );
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
                    const currentActiveUids = l.items
                        .filter((i) => i.enabled)
                        .map((i) => i.uid);
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
                        (sum, item) =>
                            sum + countGeometryVertices(item.geometry),
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
                toast.success(
                    `Fixed overlaps and marked "${layer.name}" as noOverlaps`,
                );
            }
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Failed to check/fix region overlaps.",
            );
        } finally {
            setFixingOverlapId((cur) => (cur === layer.id ? null : cur));
        }
    };

    if (layers.length === 0) {
        return (
            <div className="space-y-3 rounded-lg border border-dashed border-border bg-background/40 p-5 text-center">
                <p className="text-sm font-medium">No feature layers yet</p>
                <p className="text-xs text-muted-foreground">
                    Feature layers are optional (radars &amp; thermometers work
                    with stations alone). Add POIs, admin regions, or lines from
                    a file or from OpenStreetMap:
                </p>
                <div className="flex flex-wrap justify-center gap-2 pt-1">
                    <Button
                        type="button"
                        size="sm"
                        variant="default"
                        onClick={onOpenImportTab}
                    >
                        <FileUp className="mr-1.5 h-3.5 w-3.5" />
                        Import KML / GeoJSON / CSV
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={onOpenOsmTab}
                    >
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
                <span>
                    Checked layers are included in the exported game.
                </span>
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
                    <div
                        key={layer.id}
                        className="rounded-lg border border-border bg-background/40 p-2.5"
                    >
                        <div className="flex items-center gap-2">
                            <Checkbox
                                aria-label={`Include ${layer.name} in game`}
                                checked={layer.selected}
                                onCheckedChange={(v) =>
                                    setLayers((prev) =>
                                        prev.map((l) =>
                                            l.id === layer.id
                                                ? { ...l, selected: v === true }
                                                : l,
                                        ),
                                    )
                                }
                            />
                            <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: layer.color }}
                            />
                            <div className="min-w-0 flex-1">
                                <p
                                    className={cn(
                                        "truncate text-sm font-medium",
                                        !layer.selected &&
                                            "text-muted-foreground line-through",
                                    )}
                                >
                                    {layer.name}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                    {activeCount}/{layer.items.length}{" "}
                                    {layer.family}
                                    {layer.family !== "points" && (
                                        <>
                                            {" · "}
                                            <span
                                                className={cn(
                                                    layer.vertexCount >
                                                        HEAVY_VERTEX_WARNING &&
                                                        "text-amber-300",
                                                )}
                                            >
                                                {layer.vertexCount.toLocaleString()}{" "}
                                                pts
                                            </span>
                                        </>
                                    )}{" "}
                                    · {layer.sourceLabel}
                                </p>
                            </div>
                            {layer.osmFilter && (
                                <button
                                    type="button"
                                    title="Refresh this layer from OpenStreetMap"
                                    disabled={
                                        !hasPlayArea ||
                                        refreshingId === layer.id
                                    }
                                    onClick={() =>
                                        void handleRefreshOsmPoiLayer(layer)
                                    }
                                    className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                                >
                                    <RefreshCw
                                        className={cn(
                                            "h-3.5 w-3.5",
                                            refreshingId === layer.id &&
                                                "animate-spin",
                                        )}
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
                                onClick={() =>
                                    setExpandedId(expanded ? null : layer.id)
                                }
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
                                    setLayers((prev) =>
                                        prev.filter((l) => l.id !== layer.id),
                                    );
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

                        {layer.selected && (
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-6 text-[11px]">
                                <div className="flex gap-1">
                                    {allowedKinds.map(([kind, label]) => {
                                        const on =
                                            layer.enabledFor.includes(kind);
                                        return (
                                            <button
                                                key={kind}
                                                type="button"
                                                onClick={() =>
                                                    setLayers((prev) =>
                                                        prev.map((l) =>
                                                            l.id === layer.id
                                                                ? {
                                                                      ...l,
                                                                      enabledFor:
                                                                          on
                                                                              ? l.enabledFor.filter(
                                                                                    (
                                                                                        k,
                                                                                    ) =>
                                                                                        k !==
                                                                                        kind,
                                                                                )
                                                                              : [
                                                                                    ...l.enabledFor,
                                                                                    kind,
                                                                                ],
                                                                  }
                                                                : l,
                                                        ),
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
                                {layer.family === "polygons" &&
                                    (layer.noOverlaps ? (
                                        <span className="inline-flex items-center gap-1 text-emerald-500">
                                            <CheckCircle2 className="h-3 w-3" />
                                            noOverlaps
                                        </span>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled={
                                                fixingOverlapId === layer.id
                                            }
                                            onClick={() =>
                                                void handleFixOverlaps(layer)
                                            }
                                            className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
                                        >
                                            <Sparkles className="h-3 w-3" />
                                            {fixingOverlapId === layer.id
                                                ? "Fixing…"
                                                : "Fix overlaps"}
                                        </button>
                                    ))}
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
                                                        const reenabled =
                                                            v === true &&
                                                            !item.enabled;
                                                        return {
                                                            ...l,
                                                            noOverlaps:
                                                                reenabled
                                                                    ? false
                                                                    : l.noOverlaps,
                                                            items: l.items.map(
                                                                (x) =>
                                                                    x.uid ===
                                                                    item.uid
                                                                        ? {
                                                                              ...x,
                                                                              enabled:
                                                                                  v ===
                                                                                  true,
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
                                                !item.enabled &&
                                                    "text-muted-foreground line-through",
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
