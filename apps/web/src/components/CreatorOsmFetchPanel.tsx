import type { FeatureIcon, PlayAreaFeatureCollection } from "@searchlight/shared";
import { Code2, HelpCircle, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { type CreatorGeometryLayer, layerSlugOf } from "@/lib/creator/assemble";
import type { GeometryFamily } from "@/lib/creator/importFile";
import {
  buildAdminRegionsQuery,
  buildLineLayerQuery,
  fetchAdminRegionsFromOsm,
  fetchLineLayerFromOsm,
} from "@/lib/creator/osmGeometry";
import {
  buildBatchedPoiOverpassQuery,
  expandBoundsKm,
  fetchPoiLayersFromOsm,
  fetchRawPoiQueryFromOsm,
  playAreaBounds,
  validateCustomOsmFilter,
} from "@/lib/creator/overpass";
import {
  ADMIN_LEVEL_PRESETS,
  CREATOR_POI_CATALOG,
  CUSTOM_LAYER_COLORS,
  inferLayerColor,
  inferLayerIcon,
  LINE_LAYER_PRESETS,
  type PoiCategoryPreset,
} from "@/lib/creator/presets";
import {
  fetchAdminRegionsFromQlever,
  fetchLineLayerFromQlever,
  fetchPoiLayerFromQlever,
  osmFilterToSparqlPatterns,
  QLEVER_WEB_UI_URL,
} from "@/lib/creator/qlever";
import { cn } from "@/lib/utils";

interface Props {
  playArea: PlayAreaFeatureCollection | null;
  playAreaOsmRelationId: number | null;
  playAreaGenRef: React.MutableRefObject<number>;
  osmEngine: "qlever" | "overpass";
  setOsmEngine: (engine: "qlever" | "overpass") => void;
  poiBufferKm: number;
  setPoiBufferKm: (km: number) => void;
  preferEnglishName: boolean;
  customEndpoint: string;
  setCustomEndpoint: (val: string) => void;
  existingLayers: readonly CreatorGeometryLayer[];
  existingLayerSlugs: ReadonlySet<string>;
  onUpsertLayer: (layer: CreatorGeometryLayer) => void;
}

export function CreatorOsmFetchPanel({
  playArea,
  playAreaOsmRelationId,
  playAreaGenRef,
  osmEngine,
  setOsmEngine,
  poiBufferKm,
  setPoiBufferKm,
  preferEnglishName,
  customEndpoint,
  setCustomEndpoint,
  existingLayers,
  existingLayerSlugs,
  onUpsertLayer,
}: Props) {
  const hasPlayArea = Boolean(playArea && playArea.features.length > 0);

  // ── POI fetch state (per-layer fetch so heavy tags never block others) ───
  const [notableByPreset, setNotableByPreset] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const p of CREATOR_POI_CATALOG) {
      init[p.id] = Boolean(p.noisyInOsm);
    }
    return init;
  });
  const [fetchingPoiId, setFetchingPoiId] = useState<string | null>(null);
  const [poiStatus, setPoiStatus] = useState<string | null>(null);
  const [poiError, setPoiError] = useState<string | null>(null);
  const lastPoiRequestRef = useRef<{
    id: string;
    name: string;
    osmFilter: string;
    notableOnly: boolean;
    color: string;
    icon?: FeatureIcon;
    enabledFor: readonly ("matching" | "measuring" | "tentacle")[];
    kmlGroup?: string;
  } | null>(null);

  // Custom POI form
  const [customPoiName, setCustomPoiName] = useState("");
  const [customPoiFilter, setCustomPoiFilter] = useState("");
  const [customPoiNotable, setCustomPoiNotable] = useState(false);

  // ── Admin Regions fetch form ─────────────────────────────────────────────
  const [adminLevel, setAdminLevel] = useState<number>(8);
  const [regionName, setRegionName] = useState("Municipality");
  const [regionTolerance, setRegionTolerance] = useState(15);
  const [regionBusy, setRegionBusy] = useState<string | null>(null);
  const [regionError, setRegionError] = useState<string | null>(null);

  // ── Line Layer fetch form ────────────────────────────────────────────────
  const [linePresetId, setLinePresetId] = useState<string>(LINE_LAYER_PRESETS[0].id);
  const [lineName, setLineName] = useState<string>(LINE_LAYER_PRESETS[0].name);
  const [customLineFilter, setCustomLineFilter] = useState('["railway"="rail"]');
  const [lineTolerance, setLineTolerance] = useState(15);
  const [lineGroupByName, setLineGroupByName] = useState(true);
  const [lineBusy, setLineBusy] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);

  const [showAdvancedOsm, setShowAdvancedOsm] = useState(false);
  const [showNotableHelp, setShowNotableHelp] = useState(false);

  // ── Raw Overpass QL inspector / editor ───────────────────────────────────
  const [showRawQuery, setShowRawQuery] = useState(false);
  const [rawLayerName, setRawLayerName] = useState("");
  const [rawFamily, setRawFamily] = useState<GeometryFamily>("points");
  const [rawQueryText, setRawQueryText] = useState("");
  const [rawBusy, setRawBusy] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);

  const poiAbortRef = useRef<AbortController | null>(null);
  const regionAbortRef = useRef<AbortController | null>(null);
  const lineAbortRef = useRef<AbortController | null>(null);
  const rawAbortRef = useRef<AbortController | null>(null);
  const rawEditorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    poiAbortRef.current?.abort();
    poiAbortRef.current = null;
    regionAbortRef.current?.abort();
    regionAbortRef.current = null;
    lineAbortRef.current?.abort();
    lineAbortRef.current = null;
    rawAbortRef.current?.abort();
    rawAbortRef.current = null;
    lastPoiRequestRef.current = null;
    setFetchingPoiId(null);
    setPoiStatus(null);
    setPoiError(null);
    setRegionBusy(null);
    setRegionError(null);
    setLineBusy(null);
    setLineError(null);
    setRawBusy(null);
    setRawError(null);
  }, [playArea]);

  useEffect(() => {
    return () => {
      poiAbortRef.current?.abort();
      regionAbortRef.current?.abort();
      lineAbortRef.current?.abort();
      rawAbortRef.current?.abort();
    };
  }, []);

  const openRawQueryEditor = ({
    name,
    family,
    query,
  }: {
    name: string;
    family: GeometryFamily;
    query: string;
  }) => {
    setRawLayerName(name);
    setRawFamily(family);
    setRawQueryText(query);
    setRawError(null);
    setShowRawQuery(true);
    requestAnimationFrame(() => {
      rawEditorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    });
  };

  const handleRunRawQuery = async () => {
    if (!hasPlayArea || !playArea) {
      setRawError("Set a play area in Step 1 first.");
      return;
    }
    const trimmedName = rawLayerName.trim();
    if (!trimmedName || !layerSlugOf(trimmedName)) {
      setRawError("Enter a layer name with at least one ASCII letter or digit (a–z, 0–9).");
      return;
    }
    if (!rawQueryText.trim()) {
      setRawError("Enter an Overpass QL query to run.");
      return;
    }

    rawAbortRef.current?.abort();
    const controller = new AbortController();
    rawAbortRef.current = controller;
    const areaGen = playAreaGenRef.current;
    setRawError(null);
    setRawBusy(`Running Overpass QL for "${trimmedName}"…`);

    try {
      const color = CUSTOM_LAYER_COLORS[existingLayers.length % CUSTOM_LAYER_COLORS.length];
      if (rawFamily === "points") {
        const result = await fetchRawPoiQueryFromOsm({
          query: rawQueryText,
          playArea,
          bufferKm: poiBufferKm,
          preferEnglishName,
          customEndpoint: customEndpoint.trim() || undefined,
          signal: controller.signal,
          onStatus: (msg) => {
            if (playAreaGenRef.current === areaGen) setRawBusy(msg);
          },
        });
        if (playAreaGenRef.current !== areaGen) return;
        if (result.items.length === 0) {
          setRawError(
            "Query returned 0 named points (ensure the query ends with `out center tags;` or `out;`).",
          );
          return;
        }
        const items = result.items.map((pt) => ({
          uid: pt.uid,
          name: pt.name,
          geometry: {
            type: "Point" as const,
            coordinates: [pt.lng, pt.lat] as [number, number],
          },
          enabled: true,
        }));
        onUpsertLayer({
          id: `osm-raw-${Date.now()}`,
          name: trimmedName,
          family: "points",
          enabledFor: ["matching", "measuring", "tentacle"],
          color: inferLayerColor(trimmedName, existingLayers.length),
          icon: inferLayerIcon(trimmedName),
          selected: true,
          sourceLabel: "OSM custom QL",
          items,
          vertexCount: items.length,
        });
        toast.success(`Added "${trimmedName}" (${items.length} points)`);
      } else if (rawFamily === "polygons") {
        const result = await fetchAdminRegionsFromOsm({
          adminLevel,
          playArea,
          bufferKm: poiBufferKm,
          toleranceMeters: regionTolerance,
          preferEnglishName,
          customEndpoint: customEndpoint.trim() || undefined,
          rawQueryOverride: rawQueryText,
          signal: controller.signal,
          onStatus: (msg) => {
            if (playAreaGenRef.current === areaGen) setRawBusy(msg);
          },
        });
        if (playAreaGenRef.current !== areaGen) return;
        if (result.items.length === 0) {
          setRawError(
            "Query returned 0 polygon relations intersecting the play area (ensure the query ends with `out geom;`).",
          );
          return;
        }
        onUpsertLayer({
          id: `osm-raw-poly-${Date.now()}`,
          name: trimmedName,
          family: "polygons",
          enabledFor: ["matching", "measuring"],
          color,
          selected: true,
          noOverlaps: false,
          sourceLabel: "OSM custom QL",
          items: result.items,
          vertexCount: result.vertexCount,
        });
        toast.success(`Added "${trimmedName}" (${result.items.length} polygons)`);
      } else {
        const result = await fetchLineLayerFromOsm({
          layerName: trimmedName,
          osmFilter: "",
          playArea,
          bufferKm: poiBufferKm,
          toleranceMeters: lineTolerance,
          groupByName: lineGroupByName,
          preferEnglishName,
          customEndpoint: customEndpoint.trim() || undefined,
          rawQueryOverride: rawQueryText,
          signal: controller.signal,
          onStatus: (msg) => {
            if (playAreaGenRef.current === areaGen) setRawBusy(msg);
          },
        });
        if (playAreaGenRef.current !== areaGen) return;
        if (result.items.length === 0) {
          setRawError("Query returned 0 line ways (ensure the query ends with `out geom;`).");
          return;
        }
        onUpsertLayer({
          id: `osm-raw-line-${Date.now()}`,
          name: trimmedName,
          family: "lines",
          enabledFor: ["measuring"],
          color,
          selected: true,
          sourceLabel: "OSM custom QL",
          items: result.items,
          vertexCount: result.vertexCount,
        });
        toast.success(
          `Added "${trimmedName}" (${result.items.length} line feature${result.items.length === 1 ? "" : "s"})`,
        );
      }
    } catch (err) {
      if (
        playAreaGenRef.current !== areaGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setRawError(err instanceof Error ? err.message : "Custom Overpass QL query failed.");
    } finally {
      if (rawAbortRef.current === controller) {
        rawAbortRef.current = null;
        setRawBusy(null);
      }
    }
  };

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

  const fetchSinglePoi = async (
    req: {
      id: string;
      name: string;
      osmFilter: string;
      notableOnly: boolean;
      color: string;
      icon?: FeatureIcon;
      enabledFor: readonly ("matching" | "measuring" | "tentacle")[];
      kmlGroup?: string;
    },
    engineOverride?: "qlever" | "overpass",
  ) => {
    const { id, name, osmFilter, notableOnly, color, icon, enabledFor, kmlGroup } = req;
    if (!hasPlayArea || !playArea) {
      setPoiError("Set a play area in Step 1 first.");
      return;
    }
    lastPoiRequestRef.current = req;
    const requestedEngine = engineOverride ?? osmEngine;
    const useQlever = requestedEngine === "qlever" && osmFilterToSparqlPatterns(osmFilter) !== null;

    poiAbortRef.current?.abort();
    const controller = new AbortController();
    poiAbortRef.current = controller;
    const areaGen = playAreaGenRef.current;
    setPoiError(null);
    setFetchingPoiId(id);
    setPoiStatus(
      useQlever ? `Querying QLever for ${name}…` : `Querying OpenStreetMap for ${name}…`,
    );

    try {
      const rawPts = useQlever
        ? (
            await fetchPoiLayerFromQlever({
              id,
              name,
              osmFilter,
              notableOnly,
              playArea,
              playAreaOsmRelationId,
              bufferKm: poiBufferKm,
              preferEnglishName,
              signal: controller.signal,
              onStatus: (msg) => {
                if (playAreaGenRef.current === areaGen) setPoiStatus(msg);
              },
            })
          ).items
        : ((
            await fetchPoiLayersFromOsm({
              layers: [{ id, name, osmFilter, notableOnly }],
              playArea,
              bufferKm: poiBufferKm,
              preferEnglishName,
              customEndpoint: customEndpoint.trim() || undefined,
              signal: controller.signal,
              onStatus: (msg) => {
                if (playAreaGenRef.current === areaGen) setPoiStatus(msg);
              },
            })
          ).byLayerId[id] ?? []);
      if (playAreaGenRef.current !== areaGen) return;
      if (rawPts.length === 0) {
        setPoiError(
          `No matching OpenStreetMap places found for "${name}"${notableOnly ? " (try unchecking Notable only)" : ""}.`,
        );
        return;
      }
      const items = rawPts.map((pt) => ({
        uid: pt.uid,
        name: pt.name,
        geometry: {
          type: "Point" as const,
          coordinates: [pt.lng, pt.lat] as [number, number],
        },
        enabled: true,
      }));

      lastPoiRequestRef.current = null;
      onUpsertLayer({
        id: `osm-poi-${id}`,
        name,
        family: "points",
        enabledFor: [...enabledFor],
        color,
        icon: icon ?? inferLayerIcon(name),
        selected: true,
        sourceLabel: "OSM POI",
        osmFilter,
        notableOnly,
        osmEngine: useQlever ? "qlever" : "overpass",
        kmlGroup,
        items,
        vertexCount: items.length,
      });
      toast.success(
        `Fetched ${items.length} ${name} place${items.length === 1 ? "" : "s"} into My Layers`,
      );
    } catch (err) {
      if (
        playAreaGenRef.current !== areaGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setPoiError(
        err instanceof Error ? err.message : `Failed to fetch ${name} from OpenStreetMap.`,
      );
    } finally {
      if (poiAbortRef.current === controller) {
        poiAbortRef.current = null;
        setFetchingPoiId(null);
        setPoiStatus(null);
      }
    }
  };

  const handleFetchPresetPoi = (preset: PoiCategoryPreset) => {
    void fetchSinglePoi({
      id: preset.id,
      name: preset.name,
      osmFilter: preset.osmFilter,
      notableOnly: Boolean(notableByPreset[preset.id]),
      color: preset.color,
      icon: preset.icon,
      enabledFor: preset.defaultEnabledFor,
      kmlGroup: preset.kmlGroup,
    });
  };

  const handleFetchCustomPoi = (e: React.FormEvent) => {
    e.preventDefault();
    const nameErr = validateNewLayerName(customPoiName);
    if (nameErr) {
      lastPoiRequestRef.current = null;
      setPoiError(nameErr);
      return;
    }
    const check = validateCustomOsmFilter(customPoiFilter);
    if (!check.ok) {
      lastPoiRequestRef.current = null;
      setPoiError(check.error);
      return;
    }
    const trimmed = customPoiName.trim();
    const color = CUSTOM_LAYER_COLORS[existingLayers.length % CUSTOM_LAYER_COLORS.length];
    void fetchSinglePoi({
      id: `custom-${Date.now()}`,
      name: trimmed,
      osmFilter: check.filter,
      notableOnly: customPoiNotable,
      color,
      enabledFor: ["matching", "measuring", "tentacle"],
    });
    setCustomPoiName("");
    setCustomPoiFilter("");
  };

  const handleFetchRegions = async (engineOverride?: "qlever" | "overpass") => {
    if (!hasPlayArea || !playArea) {
      setRegionError("Set a play area in Step 1 first.");
      return;
    }
    const nameErr = validateNewLayerName(regionName);
    if (nameErr) {
      setRegionError(nameErr);
      return;
    }

    const activeEngine = engineOverride ?? osmEngine;
    regionAbortRef.current?.abort();
    const controller = new AbortController();
    regionAbortRef.current = controller;
    const areaGen = playAreaGenRef.current;
    setRegionError(null);
    setRegionBusy(
      activeEngine === "qlever"
        ? `Querying QLever for admin_level=${adminLevel}…`
        : `Querying OpenStreetMap for admin_level=${adminLevel}…`,
    );

    try {
      const result =
        activeEngine === "qlever"
          ? await fetchAdminRegionsFromQlever({
              adminLevel,
              playArea,
              bufferKm: poiBufferKm,
              toleranceMeters: regionTolerance,
              preferEnglishName,
              signal: controller.signal,
              onStatus: (msg) => {
                if (playAreaGenRef.current === areaGen) setRegionBusy(msg);
              },
            })
          : await fetchAdminRegionsFromOsm({
              adminLevel,
              playArea,
              bufferKm: poiBufferKm,
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
      const color = CUSTOM_LAYER_COLORS[existingLayers.length % CUSTOM_LAYER_COLORS.length];
      onUpsertLayer({
        id,
        name: regionName.trim(),
        family: "polygons",
        enabledFor: ["matching", "measuring"],
        color,
        selected: true,
        noOverlaps: false,
        sourceLabel: `OSM admin_level=${adminLevel}`,
        items: result.items,
        vertexCount: result.vertexCount,
      });
      toast.success(
        `Added "${regionName.trim()}" (${result.items.length} regions, ${result.vertexCount.toLocaleString()} vertices)`,
      );
    } catch (err) {
      if (
        playAreaGenRef.current !== areaGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setRegionError(
        err instanceof Error ? err.message : "Failed to fetch admin regions from OpenStreetMap.",
      );
    } finally {
      if (regionAbortRef.current === controller) {
        regionAbortRef.current = null;
        setRegionBusy(null);
      }
    }
  };

  const handleFetchLines = async (engineOverride?: "qlever" | "overpass") => {
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

    const requestedEngine = engineOverride ?? osmEngine;
    const useQlever = requestedEngine === "qlever" && osmFilterToSparqlPatterns(osmFilter) !== null;

    lineAbortRef.current?.abort();
    const controller = new AbortController();
    lineAbortRef.current = controller;
    const areaGen = playAreaGenRef.current;
    setLineError(null);
    setLineBusy(
      useQlever
        ? `Querying QLever for ${lineName.trim()}…`
        : `Querying OpenStreetMap for ${lineName.trim()}…`,
    );

    try {
      const result = useQlever
        ? await fetchLineLayerFromQlever({
            layerName: lineName.trim(),
            osmFilter,
            playArea,
            playAreaOsmRelationId,
            bufferKm: poiBufferKm,
            toleranceMeters: lineTolerance,
            groupByName: lineGroupByName,
            preferEnglishName,
            signal: controller.signal,
            onStatus: (msg) => {
              if (playAreaGenRef.current === areaGen) setLineBusy(msg);
            },
          })
        : await fetchLineLayerFromOsm({
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
        setLineError(`No matching OSM ways found for "${lineName.trim()}" in this area.`);
        return;
      }
      const id = `osm-lines-${Date.now()}`;
      const color =
        preset?.color ?? CUSTOM_LAYER_COLORS[existingLayers.length % CUSTOM_LAYER_COLORS.length];
      onUpsertLayer({
        id,
        name: lineName.trim(),
        family: "lines",
        enabledFor: preset ? [...preset.defaultEnabledFor] : ["measuring"],
        color,
        selected: true,
        sourceLabel: preset ? `OSM ${preset.label}` : "OSM lines",
        items: result.items,
        vertexCount: result.vertexCount,
      });
      toast.success(
        `Added "${lineName.trim()}" (${result.items.length} feature${result.items.length === 1 ? "" : "s"}, ${result.vertexCount.toLocaleString()} vertices)`,
      );
    } catch (err) {
      if (
        playAreaGenRef.current !== areaGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setLineError(
        err instanceof Error ? err.message : "Failed to fetch line layer from OpenStreetMap.",
      );
    } finally {
      if (lineAbortRef.current === controller) {
        lineAbortRef.current = null;
        setLineBusy(null);
      }
    }
  };

  return (
    <div className="space-y-5">
      {!hasPlayArea && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          Set a play area polygon in Step 1 before fetching from OpenStreetMap.
        </div>
      )}

      {/* OSM Query Engine toggle */}
      <div className="space-y-1.5">
        <Label className="text-xs">OSM query engine</Label>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setOsmEngine("qlever")}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-left transition-colors",
              osmEngine === "qlever"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background/50 text-muted-foreground hover:bg-accent/40",
            )}
          >
            <div className="text-xs font-semibold">QLever (Fast)</div>
            <div className="text-[11px] text-muted-foreground">OSM Planet SPARQL (~1s)</div>
          </button>
          <button
            type="button"
            onClick={() => setOsmEngine("overpass")}
            className={cn(
              "rounded-md border px-2.5 py-1.5 text-left transition-colors",
              osmEngine === "overpass"
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-background/50 text-muted-foreground hover:bg-accent/40",
            )}
          >
            <div className="text-xs font-semibold">Overpass</div>
            <div className="text-[11px] text-muted-foreground">Classic mirrors &amp; custom QL</div>
          </button>
        </div>
        {osmEngine === "qlever" && (
          <p className="text-[11px] text-muted-foreground">
            Powered by{" "}
            <a
              href={QLEVER_WEB_UI_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              QLever OSM Planet
            </a>{" "}
            (University of Freiburg). Switch to Overpass anytime if needed.
          </p>
        )}
      </div>

      {/* OSM POIs — individual per-layer fetch */}
      <section className="space-y-2.5">
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Points of Interest (OSM)
            </p>
            <p className="text-[11px] text-muted-foreground">
              Fetch individual categories into My Layers (margin includes sites just outside the
              border).
            </p>
          </div>
          <div className="w-24 shrink-0 space-y-1">
            <Label htmlFor="creator-poi-buffer" className="text-[11px] text-muted-foreground">
              Margin (km)
            </Label>
            <Input
              id="creator-poi-buffer"
              type="number"
              min={0}
              max={50}
              step="any"
              value={poiBufferKm}
              onChange={(e) => setPoiBufferKm(Math.max(0, Number(e.target.value) || 0))}
              className="h-8 text-xs"
            />
          </div>
        </div>

        {poiStatus && (
          <div className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5 text-xs">
            <span className="truncate text-muted-foreground">{poiStatus}</span>
            <button
              type="button"
              onClick={() => poiAbortRef.current?.abort()}
              className="shrink-0 font-medium text-primary hover:underline"
            >
              Cancel
            </button>
          </div>
        )}
        {poiError && (
          <div className="space-y-1.5">
            <p className="text-xs text-destructive">{poiError}</p>
            {osmEngine === "qlever" && !fetchingPoiId && lastPoiRequestRef.current && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  const req = lastPoiRequestRef.current;
                  if (req) void fetchSinglePoi(req, "overpass");
                }}
              >
                Retry with Overpass
              </Button>
            )}
          </div>
        )}

        <div className="divide-y divide-border rounded-lg border border-border bg-background/40">
          <div className="flex items-center justify-between gap-2 bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground">
            <span>Category</span>
            <div className="relative flex items-center gap-1 pr-14">
              <span>Notable</span>
              <button
                type="button"
                aria-label="What does Notable mean?"
                aria-expanded={showNotableHelp}
                onClick={() => setShowNotableHelp((v) => !v)}
                title="Only fetch places with a Wikipedia or Wikidata tag in OSM (filters out tiny neighborhood parks, hills, plaques, etc.)"
                className="inline-flex text-muted-foreground hover:text-foreground"
              >
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {showNotableHelp && (
            <div className="bg-muted/40 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground">
                Notable (Wikipedia / Wikidata only):
              </span>{" "}
              Filters OSM results to places tagged with{" "}
              <code className="rounded bg-muted px-1">wikipedia</code> or{" "}
              <code className="rounded bg-muted px-1">wikidata</code>. Useful for noisy categories
              like Parks, Mountains, and Museums where OSM otherwise returns hundreds of tiny local
              spots. Uncheck if too few places show up.
            </div>
          )}
          {CREATOR_POI_CATALOG.map((preset) => {
            const existing = existingLayers.find(
              (l) =>
                l.id === `osm-poi-${preset.id}` ||
                (l.sourceLabel.startsWith("OSM ") &&
                  l.family === "points" &&
                  layerSlugOf(l.name) === layerSlugOf(preset.name)),
            );
            const isFetching = fetchingPoiId === preset.id;
            return (
              <div key={preset.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: preset.color }}
                />
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{preset.name}</span>
                  {existing && (
                    <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      {existing.items.length}
                    </span>
                  )}
                </div>
                <label
                  title="Only fetch places with a Wikipedia/Wikidata entry (recommended for Parks, Museums, Mountains)"
                  className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(notableByPreset[preset.id])}
                    onChange={(e) =>
                      setNotableByPreset((prev) => ({
                        ...prev,
                        [preset.id]: e.target.checked,
                      }))
                    }
                  />
                  Notable
                </label>
                <button
                  type="button"
                  title="Inspect or edit the Overpass QL query for this category"
                  aria-label={`Inspect query for ${preset.name}`}
                  disabled={!hasPlayArea || !playArea}
                  onClick={() => {
                    if (!playArea) return;
                    const bounds = expandBoundsKm(playAreaBounds(playArea), poiBufferKm);
                    openRawQueryEditor({
                      name: preset.name,
                      family: "points",
                      query: buildBatchedPoiOverpassQuery(
                        [
                          {
                            id: preset.id,
                            name: preset.name,
                            osmFilter: preset.osmFilter,
                            notableOnly: Boolean(notableByPreset[preset.id]),
                          },
                        ],
                        bounds,
                      ),
                    });
                  }}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <Code2 className="h-3.5 w-3.5" />
                </button>
                <Button
                  type="button"
                  size="sm"
                  variant={existing ? "outline" : "secondary"}
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={!hasPlayArea || Boolean(fetchingPoiId)}
                  onClick={() => handleFetchPresetPoi(preset)}
                >
                  <RefreshCw className={cn("mr-1 h-3 w-3", isFetching && "animate-spin")} />
                  {isFetching ? "…" : existing ? "Refetch" : "Fetch"}
                </Button>
              </div>
            );
          })}
        </div>

        {/* Custom OSM POI */}
        <form
          onSubmit={handleFetchCustomPoi}
          className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5"
        >
          <p className="text-xs font-medium">Custom OSM POI query</p>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Name (e.g. Castle)"
              value={customPoiName}
              onChange={(e) => setCustomPoiName(e.target.value)}
              className="h-8 text-xs"
            />
            <Input
              placeholder='["historic"="castle"]'
              value={customPoiFilter}
              onChange={(e) => setCustomPoiFilter(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
              <Checkbox
                checked={customPoiNotable}
                onCheckedChange={(v) => setCustomPoiNotable(v === true)}
              />
              Notable only (Wikidata)
            </label>
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={!hasPlayArea || Boolean(fetchingPoiId)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Fetch custom POI
            </Button>
          </div>
        </form>
      </section>

      <Separator />

      {/* Admin Division Polygons */}
      <section className="space-y-2.5 rounded-lg border border-border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Admin Division Polygons (OSM)
          </p>
          <button
            type="button"
            disabled={!hasPlayArea || !playArea}
            title="Inspect or edit the Overpass QL query"
            onClick={() => {
              if (!playArea) return;
              openRawQueryEditor({
                name: regionName.trim() || "Region",
                family: "polygons",
                query: buildAdminRegionsQuery(
                  adminLevel,
                  expandBoundsKm(playAreaBounds(playArea), poiBufferKm),
                ),
              });
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Code2 className="h-3 w-3" />
            Query
          </button>
        </div>
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
              const preset = ADMIN_LEVEL_PRESETS.find((p) => p.level === lvl);
              if (preset) setRegionName(preset.defaultName);
            }}
            className="flex h-9 w-full rounded-md border border-input bg-background px-2.5 text-xs"
          >
            {ADMIN_LEVEL_PRESETS.map((p) => (
              <option key={p.level} value={p.level}>
                {p.label}
              </option>
            ))}
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
            <Label
              htmlFor="creator-region-tol"
              title="Maximum distance (in meters) a simplified border may deviate from the original OSM path. Lower = closer to original; higher = fewer vertices."
              className="cursor-help text-xs underline decoration-dotted underline-offset-2"
            >
              Simplify borders (m)
            </Label>
            <Input
              id="creator-region-tol"
              type="number"
              min={0}
              max={500}
              value={regionTolerance}
              onChange={(e) => setRegionTolerance(Math.max(0, Number(e.target.value) || 0))}
              className="h-8 text-xs"
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Shared OSM borders are simplified identically across neighbours to avoid gaps and slivers.
        </p>

        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            className="flex-1"
            disabled={!hasPlayArea || Boolean(regionBusy)}
            onClick={() => void handleFetchRegions()}
          >
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", regionBusy && "animate-spin")} />
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
        {regionBusy && <p className="text-xs text-muted-foreground">{regionBusy}</p>}
        {regionError && (
          <div className="space-y-1.5">
            <p className="text-xs text-destructive">{regionError}</p>
            {osmEngine === "qlever" && !regionBusy && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => void handleFetchRegions("overpass")}
              >
                Retry with Overpass
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Line Layers */}
      <section className="space-y-2.5 rounded-lg border border-border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Line Layers (OSM)
          </p>
          <button
            type="button"
            disabled={!hasPlayArea || !playArea}
            title="Inspect or edit the Overpass QL query"
            onClick={() => {
              if (!playArea) return;
              const preset = LINE_LAYER_PRESETS.find((p) => p.id === linePresetId);
              const filter =
                linePresetId === "custom" || !preset ? customLineFilter.trim() : preset.osmFilter;
              openRawQueryEditor({
                name: lineName.trim() || "Line",
                family: "lines",
                query: buildLineLayerQuery(
                  filter || '["railway"="rail"]',
                  expandBoundsKm(playAreaBounds(playArea), poiBufferKm),
                ),
              });
            }}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Code2 className="h-3 w-3" />
            Query
          </button>
        </div>
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
              const preset = LINE_LAYER_PRESETS.find((p) => p.id === id);
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
            <Label
              htmlFor="creator-line-tol"
              title="Maximum distance (in meters) a simplified line may deviate from the original OSM path. Lower = closer to original; higher = fewer vertices."
              className="cursor-help text-xs underline decoration-dotted underline-offset-2"
            >
              Simplify lines (m)
            </Label>
            <Input
              id="creator-line-tol"
              type="number"
              min={0}
              max={500}
              value={lineTolerance}
              onChange={(e) => setLineTolerance(Math.max(0, Number(e.target.value) || 0))}
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
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", lineBusy && "animate-spin")} />
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
        {lineBusy && <p className="text-xs text-muted-foreground">{lineBusy}</p>}
        {lineError && (
          <div className="space-y-1.5">
            <p className="text-xs text-destructive">{lineError}</p>
            {osmEngine === "qlever" && !lineBusy && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => void handleFetchLines("overpass")}
              >
                Retry with Overpass
              </Button>
            )}
          </div>
        )}
      </section>

      {/* Inspect / Edit Raw Overpass QL */}
      <section
        ref={rawEditorRef}
        className="space-y-2 rounded-lg border border-border bg-background/40 p-3"
      >
        <button
          type="button"
          onClick={() => setShowRawQuery((v) => !v)}
          className="flex w-full items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          <span className="inline-flex items-center gap-1.5">
            <Code2 className="h-3.5 w-3.5" />
            {showRawQuery ? "▾" : "▸"} Overpass QL Query Editor
          </span>
          <span className="text-[11px] font-normal">
            Click &lt;&gt; on any preset above to load its query
          </span>
        </button>
        {showRawQuery && (
          <div className="space-y-2 pt-1">
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Layer name (e.g. Park)"
                value={rawLayerName}
                onChange={(e) => setRawLayerName(e.target.value)}
                className="h-8 text-xs"
              />
              <select
                aria-label="Overpass QL output geometry type"
                value={rawFamily}
                onChange={(e) => setRawFamily(e.target.value as GeometryFamily)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="points">Points (out center)</option>
                <option value="polygons">Polygons (relations out geom)</option>
                <option value="lines">Lines (ways out geom)</option>
              </select>
            </div>
            <textarea
              rows={6}
              spellCheck={false}
              value={rawQueryText}
              onChange={(e) => setRawQueryText(e.target.value)}
              placeholder={`[out:json][timeout:90];\n(\n  nwr["tourism"="museum"]["name"](s,w,n,e);\n);\nout center tags;`}
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-[11px] leading-relaxed outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="flex-1"
                disabled={!hasPlayArea || Boolean(rawBusy)}
                onClick={() => void handleRunRawQuery()}
              >
                <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", rawBusy && "animate-spin")} />
                {rawBusy ? "Running…" : "Run Overpass QL"}
              </Button>
              {rawBusy && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => rawAbortRef.current?.abort()}
                >
                  Cancel
                </Button>
              )}
            </div>
            {rawBusy && <p className="text-xs text-muted-foreground">{rawBusy}</p>}
            {rawError && <p className="text-xs text-destructive">{rawError}</p>}
          </div>
        )}
      </section>

      {/* Advanced Overpass endpoint */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvancedOsm((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {showAdvancedOsm ? "▾" : "▸"} Advanced Overpass endpoint
        </button>
        {showAdvancedOsm && (
          <div className="mt-2">
            <Input
              placeholder="Default: overpass-api.de → private.coffee → kumi.systems"
              value={customEndpoint}
              onChange={(e) => setCustomEndpoint(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        )}
      </div>
    </div>
  );
}
