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
    RefreshCw,
    Sparkles,
    Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
    type CreatorGeometryLayer,
    layerSlugOf,
} from "@/lib/creator/assemble";
import {
    countGeometryVertices,
    fetchAdminRegionsFromOsm,
    fetchLineLayerFromOsm,
} from "@/lib/creator/osmGeometry";
import { validateCustomOsmFilter } from "@/lib/creator/overpass";
import {
    ADMIN_LEVEL_PRESETS,
    CUSTOM_LAYER_COLORS,
    LINE_LAYER_PRESETS,
} from "@/lib/creator/presets";
import { cn } from "@/lib/utils";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

const HEAVY_VERTEX_WARNING = 20_000;

interface Props {
    playArea: PlayAreaFeatureCollection | null;
    playAreaGenRef: React.MutableRefObject<number>;
    poiBufferKm: number;
    preferEnglishName: boolean;
    customEndpoint: string;
    geometryLayers: CreatorGeometryLayer[];
    setGeometryLayers: React.Dispatch<
        React.SetStateAction<CreatorGeometryLayer[]>
    >;
    visibleLayerIds: Set<string>;
    setVisibleLayerIds: React.Dispatch<React.SetStateAction<Set<string>>>;
    existingLayerSlugs: ReadonlySet<string>;
}

export function CreatorGeometryPanel({
    playArea,
    playAreaGenRef,
    poiBufferKm,
    preferEnglishName,
    customEndpoint,
    geometryLayers,
    setGeometryLayers,
    visibleLayerIds,
    setVisibleLayerIds,
    existingLayerSlugs,
}: Props) {
    // ── Admin Regions fetch form ─────────────────────────────────────────────
    const [adminLevel, setAdminLevel] = useState<number>(8);
    const [regionName, setRegionName] = useState("Municipality");
    const [regionTolerance, setRegionTolerance] = useState(15);
    const [regionBusy, setRegionBusy] = useState<string | null>(null);
    const [regionError, setRegionError] = useState<string | null>(null);

    // ── Line Layer fetch form ────────────────────────────────────────────────
    const [linePresetId, setLinePresetId] = useState<string>(
        LINE_LAYER_PRESETS[0].id,
    );
    const [lineName, setLineName] = useState<string>(
        LINE_LAYER_PRESETS[0].name,
    );
    const [customLineFilter, setCustomLineFilter] = useState(
        '["railway"="rail"]',
    );
    const [lineTolerance, setLineTolerance] = useState(15);
    const [lineGroupByName, setLineGroupByName] = useState(true);
    const [lineBusy, setLineBusy] = useState<string | null>(null);
    const [lineError, setLineError] = useState<string | null>(null);

    // ── Layer list UI state ──────────────────────────────────────────────────
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [fixingOverlapId, setFixingOverlapId] = useState<string | null>(null);

    const regionAbortRef = useRef<AbortController | null>(null);
    const lineAbortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        regionAbortRef.current?.abort();
        regionAbortRef.current = null;
        lineAbortRef.current?.abort();
        lineAbortRef.current = null;
        setRegionBusy(null);
        setLineBusy(null);
        setRegionError(null);
        setLineError(null);
    }, [playArea]);

    useEffect(() => {
        return () => {
            regionAbortRef.current?.abort();
            lineAbortRef.current?.abort();
        };
    }, []);

    const validateNewLayerName = (rawName: string): string | null => {
        const trimmed = rawName.trim();
        if (!trimmed) return "Enter a singular layer name (e.g. Borough).";
        const slug = layerSlugOf(trimmed);
        if (!slug) {
            return "Layer name must include at least one ASCII letter or digit (a–z, 0–9).";
        }
        if (existingLayerSlugs.has(slug)) {
            return `A layer with ID "${slug}" already exists. Choose a different name.`;
        }
        return null;
    };

    const hasPlayArea = Boolean(playArea && playArea.features.length > 0);

    const handleFetchRegions = async () => {
        if (!hasPlayArea || !playArea) {
            setRegionError("Set a play area in Step 1 first.");
            return;
        }
        const nameErr = validateNewLayerName(regionName);
        if (nameErr) {
            setRegionError(nameErr);
            return;
        }

        regionAbortRef.current?.abort();
        const controller = new AbortController();
        regionAbortRef.current = controller;
        const areaGen = playAreaGenRef.current;
        setRegionError(null);
        setRegionBusy(`Querying OpenStreetMap for admin_level=${adminLevel}…`);

        try {
            const result = await fetchAdminRegionsFromOsm({
                adminLevel,
                playArea,
                toleranceMeters: regionTolerance,
                preferEnglishName,
                customEndpoint: customEndpoint.trim() || undefined,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (playAreaGenRef.current === areaGen) setRegionBusy(msg);
                },
            });
            if (playAreaGenRef.current !== areaGen) return;
            if (result.items.length === 0) {
                setRegionError(
                    `No named admin_level=${adminLevel} boundaries found intersecting the play area. Try another admin level.`,
                );
                return;
            }
            const id = `osm-regions-${adminLevel}-${Date.now()}`;
            let finalName = regionName.trim();
            setGeometryLayers((prev) => {
                const usedSlugs = new Set(existingLayerSlugs);
                for (const l of prev) {
                    const s = layerSlugOf(l.name);
                    if (s) usedSlugs.add(s);
                }
                const base = finalName;
                let suffix = 2;
                while (usedSlugs.has(layerSlugOf(finalName))) {
                    finalName = `${base} ${suffix++}`;
                }
                const color =
                    CUSTOM_LAYER_COLORS[
                        prev.length % CUSTOM_LAYER_COLORS.length
                    ];
                return [
                    ...prev,
                    {
                        id,
                        name: finalName,
                        family: "polygons",
                        enabledFor: ["matching", "measuring"],
                        color,
                        selected: true,
                        noOverlaps: false,
                        sourceLabel: `OSM admin_level=${adminLevel}`,
                        items: result.items,
                        vertexCount: result.vertexCount,
                    },
                ];
            });
            setVisibleLayerIds((prev) => new Set(prev).add(id));
            toast.success(
                `Added "${finalName}" (${result.items.length} regions, ${result.vertexCount.toLocaleString()} vertices)`,
            );
        } catch (err) {
            if (
                playAreaGenRef.current !== areaGen ||
                (err instanceof DOMException && err.name === "AbortError")
            ) {
                return;
            }
            setRegionError(
                err instanceof Error
                    ? err.message
                    : "Failed to fetch admin regions from OpenStreetMap.",
            );
        } finally {
            if (regionAbortRef.current === controller) {
                regionAbortRef.current = null;
                setRegionBusy(null);
            }
        }
    };

    const handleFetchLines = async () => {
        if (!hasPlayArea || !playArea) {
            setLineError("Set a play area in Step 1 first.");
            return;
        }
        const nameErr = validateNewLayerName(lineName);
        if (nameErr) {
            setLineError(nameErr);
            return;
        }
        const preset = LINE_LAYER_PRESETS.find((p) => p.id === linePresetId);
        let osmFilter: string;
        if (linePresetId === "custom" || !preset) {
            const check = validateCustomOsmFilter(customLineFilter);
            if (!check.ok) {
                setLineError(check.error);
                return;
            }
            osmFilter = check.filter;
        } else {
            osmFilter = preset.osmFilter;
        }

        lineAbortRef.current?.abort();
        const controller = new AbortController();
        lineAbortRef.current = controller;
        const areaGen = playAreaGenRef.current;
        setLineError(null);
        setLineBusy(`Querying OpenStreetMap for ${lineName.trim()}…`);

        try {
            const result = await fetchLineLayerFromOsm({
                layerName: lineName.trim(),
                osmFilter,
                playArea,
                bufferKm: poiBufferKm,
                toleranceMeters: lineTolerance,
                groupByName: lineGroupByName,
                preferEnglishName,
                customEndpoint: customEndpoint.trim() || undefined,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (playAreaGenRef.current === areaGen) setLineBusy(msg);
                },
            });
            if (playAreaGenRef.current !== areaGen) return;
            if (result.items.length === 0) {
                setLineError(
                    `No matching OSM ways found for "${lineName.trim()}" in this area.`,
                );
                return;
            }
            const id = `osm-lines-${Date.now()}`;
            let finalName = lineName.trim();
            setGeometryLayers((prev) => {
                const usedSlugs = new Set(existingLayerSlugs);
                for (const l of prev) {
                    const s = layerSlugOf(l.name);
                    if (s) usedSlugs.add(s);
                }
                const base = finalName;
                let suffix = 2;
                while (usedSlugs.has(layerSlugOf(finalName))) {
                    finalName = `${base} ${suffix++}`;
                }
                const color =
                    preset?.color ??
                    CUSTOM_LAYER_COLORS[
                        prev.length % CUSTOM_LAYER_COLORS.length
                    ];
                return [
                    ...prev,
                    {
                        id,
                        name: finalName,
                        family: "lines",
                        enabledFor: preset
                            ? [...preset.defaultEnabledFor]
                            : ["measuring"],
                        color,
                        selected: true,
                        sourceLabel: preset
                            ? `OSM ${preset.label}`
                            : "OSM lines",
                        items: result.items,
                        vertexCount: result.vertexCount,
                    },
                ];
            });
            setVisibleLayerIds((prev) => new Set(prev).add(id));
            toast.success(
                `Added "${finalName}" (${result.items.length} feature${result.items.length === 1 ? "" : "s"}, ${result.vertexCount.toLocaleString()} vertices)`,
            );
        } catch (err) {
            if (
                playAreaGenRef.current !== areaGen ||
                (err instanceof DOMException && err.name === "AbortError")
            ) {
                return;
            }
            setLineError(
                err instanceof Error
                    ? err.message
                    : "Failed to fetch line layer from OpenStreetMap.",
            );
        } finally {
            if (lineAbortRef.current === controller) {
                lineAbortRef.current = null;
                setLineBusy(null);
            }
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
            setGeometryLayers((prev) =>
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

    return (
        <div className="space-y-5">
            {!playArea && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                    Set a play area in Step 1 before fetching OSM regions or
                    lines.
                </div>
            )}

            {/* Admin Division Polygons */}
            <section className="space-y-2.5 rounded-lg border border-border bg-background/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Admin Division Polygons (OSM)
                </p>
                <div className="space-y-1.5">
                    <Label htmlFor="creator-admin-level" className="text-xs">
                        Boundary level
                    </Label>
                    <select
                        id="creator-admin-level"
                        value={adminLevel}
                        onChange={(e) => {
                            const lvl = Number(e.target.value);
                            setAdminLevel(lvl);
                            const preset = ADMIN_LEVEL_PRESETS.find(
                                (p) => p.level === lvl,
                            );
                            if (preset) setRegionName(preset.defaultName);
                        }}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                    >
                        {ADMIN_LEVEL_PRESETS.map((p) => (
                            <option key={p.level} value={p.level}>
                                {p.label}
                            </option>
                        ))}
                        <option value={2}>Level 2 — Country</option>
                        <option value={5}>Level 5 — Region</option>
                        <option value={7}>Level 7 — Sub-district</option>
                        <option value={11}>Level 11 — Sub-ward</option>
                    </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                        <Label htmlFor="creator-region-name" className="text-xs">
                            Layer name (singular)
                        </Label>
                        <Input
                            id="creator-region-name"
                            value={regionName}
                            onChange={(e) => setRegionName(e.target.value)}
                            placeholder="Borough"
                            className="h-8 text-xs"
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="creator-region-tol" className="text-xs">
                            Simplify borders (m)
                        </Label>
                        <Input
                            id="creator-region-tol"
                            type="number"
                            min={0}
                            max={500}
                            value={regionTolerance}
                            onChange={(e) =>
                                setRegionTolerance(
                                    Math.max(0, Number(e.target.value) || 0),
                                )
                            }
                            className="h-8 text-xs"
                        />
                    </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                    Shared OSM borders are simplified identically across
                    neighbours to avoid gaps and slivers.
                </p>

                <div className="flex gap-2">
                    <Button
                        type="button"
                        size="sm"
                        className="flex-1"
                        disabled={!hasPlayArea || Boolean(regionBusy)}
                        onClick={() => void handleFetchRegions()}
                    >
                        <RefreshCw
                            className={cn(
                                "mr-1.5 h-3.5 w-3.5",
                                regionBusy && "animate-spin",
                            )}
                        />
                        {regionBusy ? "Fetching…" : "Fetch admin regions"}
                    </Button>
                    {regionBusy && (
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => regionAbortRef.current?.abort()}
                        >
                            Cancel
                        </Button>
                    )}
                </div>
                {regionBusy && (
                    <p className="text-xs text-muted-foreground">{regionBusy}</p>
                )}
                {regionError && (
                    <p className="text-xs text-destructive">{regionError}</p>
                )}
            </section>

            {/* Line Layers */}
            <section className="space-y-2.5 rounded-lg border border-border bg-background/40 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Line Layers (OSM)
                </p>
                <div className="space-y-1.5">
                    <Label htmlFor="creator-line-preset" className="text-xs">
                        Line preset
                    </Label>
                    <select
                        id="creator-line-preset"
                        value={linePresetId}
                        onChange={(e) => {
                            const id = e.target.value;
                            setLinePresetId(id);
                            const preset = LINE_LAYER_PRESETS.find(
                                (p) => p.id === id,
                            );
                            if (preset) setLineName(preset.name);
                        }}
                        className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
                    >
                        {LINE_LAYER_PRESETS.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.label}
                            </option>
                        ))}
                        <option value="custom">Custom OSM way filter</option>
                    </select>
                </div>

                {linePresetId === "custom" && (
                    <Input
                        value={customLineFilter}
                        onChange={(e) => setCustomLineFilter(e.target.value)}
                        placeholder='["railway"="rail"]'
                        className="h-8 font-mono text-xs"
                    />
                )}

                <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                        <Label htmlFor="creator-line-name" className="text-xs">
                            Layer name (singular)
                        </Label>
                        <Input
                            id="creator-line-name"
                            value={lineName}
                            onChange={(e) => setLineName(e.target.value)}
                            placeholder="Rail Line"
                            className="h-8 text-xs"
                        />
                    </div>
                    <div className="space-y-1">
                        <Label htmlFor="creator-line-tol" className="text-xs">
                            Simplify lines (m)
                        </Label>
                        <Input
                            id="creator-line-tol"
                            type="number"
                            min={0}
                            max={500}
                            value={lineTolerance}
                            onChange={(e) =>
                                setLineTolerance(
                                    Math.max(0, Number(e.target.value) || 0),
                                )
                            }
                            className="h-8 text-xs"
                        />
                    </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                        checked={lineGroupByName}
                        onCheckedChange={(v) => setLineGroupByName(v === true)}
                    />
                    <span>Merge segments sharing the same name</span>
                </label>

                <div className="flex gap-2">
                    <Button
                        type="button"
                        size="sm"
                        className="flex-1"
                        disabled={!hasPlayArea || Boolean(lineBusy)}
                        onClick={() => void handleFetchLines()}
                    >
                        <RefreshCw
                            className={cn(
                                "mr-1.5 h-3.5 w-3.5",
                                lineBusy && "animate-spin",
                            )}
                        />
                        {lineBusy ? "Fetching…" : "Fetch line layer"}
                    </Button>
                    {lineBusy && (
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => lineAbortRef.current?.abort()}
                        >
                            Cancel
                        </Button>
                    )}
                </div>
                {lineBusy && (
                    <p className="text-xs text-muted-foreground">{lineBusy}</p>
                )}
                {lineError && (
                    <p className="text-xs text-destructive">{lineError}</p>
                )}
            </section>

            {/* Added Region / Line / Imported Layers */}
            {geometryLayers.length > 0 && (
                <>
                    <Separator />
                    <section className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                            Added region, line & imported layers (
                            {geometryLayers.length})
                        </p>
                        {geometryLayers.map((layer) => {
                            const activeCount = layer.items.filter(
                                (i) => i.enabled,
                            ).length;
                            const visible = visibleLayerIds.has(layer.id);
                            const expanded = expandedId === layer.id;
                            const allowedKinds: readonly [
                                FeatureEnabledFor,
                                string,
                            ][] =
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
                                            checked={layer.selected}
                                            onCheckedChange={(v) =>
                                                setGeometryLayers((prev) =>
                                                    prev.map((l) =>
                                                        l.id === layer.id
                                                            ? {
                                                                  ...l,
                                                                  selected:
                                                                      v ===
                                                                      true,
                                                              }
                                                            : l,
                                                    ),
                                                )
                                            }
                                        />
                                        <span
                                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                                            style={{
                                                backgroundColor: layer.color,
                                            }}
                                        />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">
                                                {layer.name}
                                            </p>
                                            <p className="truncate text-[11px] text-muted-foreground">
                                                {activeCount}/{layer.items.length}{" "}
                                                {layer.family} ·{" "}
                                                <span
                                                    className={cn(
                                                        layer.vertexCount >
                                                            HEAVY_VERTEX_WARNING &&
                                                            "text-amber-300",
                                                    )}
                                                >
                                                    {layer.vertexCount.toLocaleString()}{" "}
                                                    pts
                                                </span>{" "}
                                                · {layer.sourceLabel}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            title={
                                                visible
                                                    ? "Hide on map"
                                                    : "Show on map"
                                            }
                                            onClick={() =>
                                                setVisibleLayerIds((prev) => {
                                                    const next = new Set(prev);
                                                    if (visible)
                                                        next.delete(layer.id);
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
                                                setExpandedId(
                                                    expanded ? null : layer.id,
                                                )
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
                                                setGeometryLayers((prev) =>
                                                    prev.filter(
                                                        (l) =>
                                                            l.id !== layer.id,
                                                    ),
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
                                                {allowedKinds.map(
                                                    ([kind, label]) => {
                                                        const on =
                                                            layer.enabledFor.includes(
                                                                kind,
                                                            );
                                                        return (
                                                            <button
                                                                key={kind}
                                                                type="button"
                                                                onClick={() =>
                                                                    setGeometryLayers(
                                                                        (
                                                                            prev,
                                                                        ) =>
                                                                            prev.map(
                                                                                (
                                                                                    l,
                                                                                ) =>
                                                                                    l.id ===
                                                                                    layer.id
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
                                                    },
                                                )}
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
                                                            fixingOverlapId ===
                                                            layer.id
                                                        }
                                                        onClick={() =>
                                                            void handleFixOverlaps(
                                                                layer,
                                                            )
                                                        }
                                                        className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-50"
                                                    >
                                                        <Sparkles className="h-3 w-3" />
                                                        {fixingOverlapId ===
                                                        layer.id
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
                                                            setGeometryLayers(
                                                                (prev) =>
                                                                    prev.map(
                                                                        (l) => {
                                                                            if (
                                                                                l.id !==
                                                                                layer.id
                                                                            )
                                                                                return l;
                                                                            const reenabled =
                                                                                v ===
                                                                                    true &&
                                                                                !item.enabled;
                                                                            return {
                                                                                ...l,
                                                                                // Re-enabling a polygon may reintroduce overlaps.
                                                                                noOverlaps:
                                                                                    reenabled
                                                                                        ? false
                                                                                        : l.noOverlaps,
                                                                                items: l.items.map(
                                                                                    (
                                                                                        x,
                                                                                    ) =>
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
                                                                        },
                                                                    ),
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
                    </section>
                </>
            )}
        </div>
    );
}
