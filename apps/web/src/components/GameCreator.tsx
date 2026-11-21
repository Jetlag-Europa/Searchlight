import "leaflet/dist/leaflet.css";

import {
  type Bounds,
  type DistanceUnit,
  formatGameDefinitionJson,
  type GameDefinition,
  type HidingZoneFeature,
  type PlayAreaFeatureCollection,
  resolveGameDefinitionId,
  validateGameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import * as L from "leaflet";
import { FolderOpen, Sparkles } from "lucide-react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import { CreatorAreaStep } from "@/components/CreatorAreaStep";
import { CreatorExportStep } from "@/components/CreatorExportStep";
import { CreatorImportPanel } from "@/components/CreatorImportPanel";
import { CreatorLayersList, type SimplifyPreviewState } from "@/components/CreatorLayersList";
import { CreatorMapPane } from "@/components/CreatorMapPane";
import { CreatorOsmFetchPanel } from "@/components/CreatorOsmFetchPanel";
import { CreatorStationsStep } from "@/components/CreatorStationsStep";
import { Button } from "@/components/ui/button";
import { type CompiledGame, compileGameDefinition } from "@/game-definition/compile";
import { checkGameQuality, formatFileSize, type QualityIssue } from "@/game-definition/inspect";
import {
  assembleGameDefinition,
  type CreatorGeometryLayer,
  layerSlugOf,
  type PreservedGameMetadata,
  validateCreatorLayers,
} from "@/lib/creator/assemble";
import {
  clearCreatorWorkspaceDraft,
  type CreatorWorkspaceDraft,
  flushCreatorWorkspaceDraftSync,
  readCreatorWorkspaceDraft,
  saveCreatorImportHandoff,
  saveCreatorWorkspaceDraft,
} from "@/lib/creator/handoff";
import {
  decodeImportedText,
  type GeometryFamily,
  parseJsonImportText,
  suggestSingularLayerName,
  sumFeatureVertices,
} from "@/lib/creator/importFile";
import { buildGameKml, MY_MAPS_MOBILE_MAX_LAYERS, planKmlFolders } from "@/lib/creator/kml";
import { simplifyLineLayerTopology, simplifyPolygonLayerTopology } from "@/lib/creator/osmGeometry";
import {
  buildStationOverpassQuery,
  buildValidatedDrawnPlayArea,
  type CreatorPointItem,
  fetchStationsFromOsm,
  fetchStationsFromTransitous,
  type PlaceSearchResult,
  rectanglePlayArea,
  searchPlaces,
  tryPlayAreaBounds,
  validateCustomOsmFilter,
} from "@/lib/creator/overpass";
import {
  type GameScale,
  getOsmFiltersForStationTypes,
  getTransitousModesForStationTypes,
  inferLayerColor,
  inferLayerIcon,
  SCALE_PRESETS,
  type StationSource,
  type StationTypeId,
  stationTypesFromLegacyPreset,
} from "@/lib/creator/presets";
import { MAX_LOCAL_GAME_BYTES } from "@/lib/localGameLoader";
import {
  createLocalSession,
  isLocalStoragePersistent,
  saveLocalGame,
  writeLastLocalSessionId,
} from "@/lib/localStore";
import { cn } from "@/lib/utils";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";

type CreatorStep = "area" | "stations" | "features" | "export";
type FeatureSubTab = "layers" | "import" | "osm";
type MapInteractionMode = "browse" | "draw-area" | "add-station";

const DEFAULT_SCALE: GameScale = "medium";

function downloadBlob(fileName: string, content: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseRadarsText(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function GameCreator() {
  const [step, setStep] = useState<CreatorStep>("area");
  const [interactionMode, setInteractionMode] = useState<MapInteractionMode>("browse");

  // ── Step 1: Area & Defaults ──────────────────────────────────────────────
  const [gameName, setGameName] = useState("");
  const [customId, setCustomId] = useState("");
  const [scale, setScale] = useState<GameScale>(DEFAULT_SCALE);
  const [unit, setUnit] = useState<DistanceUnit>(SCALE_PRESETS[DEFAULT_SCALE].unit);
  const [hidingRadius, setHidingRadius] = useState<number>(
    SCALE_PRESETS[DEFAULT_SCALE].hidingRadius,
  );
  const [radarMode, setRadarMode] = useState<"off" | "default" | "custom">("custom");
  const [radarsText, setRadarsText] = useState(SCALE_PRESETS[DEFAULT_SCALE].radars.join(", "));
  const [thermometer, setThermometer] = useState(SCALE_PRESETS[DEFAULT_SCALE].thermometer);
  const [preservedMetadata, setPreservedMetadata] = useState<PreservedGameMetadata | null>(null);
  const [extraHidingZones, setExtraHidingZones] = useState<HidingZoneFeature[]>([]);

  const [playArea, setPlayArea] = useState<PlayAreaFeatureCollection | null>(null);
  const [playAreaVersion, setPlayAreaVersion] = useState(0);
  const [fitTarget, setFitTarget] = useState<{
    bounds: Bounds;
    seq: number;
  } | null>(null);
  const [drawPoints, setDrawPoints] = useState<[number, number][]>([]);

  const [placeQuery, setPlaceQuery] = useState("");
  const [placeSearching, setPlaceSearching] = useState(false);
  const [placeResults, setPlaceResults] = useState<PlaceSearchResult[]>([]);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // ── Step 2: Stations (Hiding Zones) ──────────────────────────────────────
  const [stationSource, setStationSource] = useState<StationSource>("transitous");
  const [stationTypes, setStationTypes] = useState<StationTypeId[]>([
    ...SCALE_PRESETS[DEFAULT_SCALE].stationTypes,
  ]);
  const [customStationFilter, setCustomStationFilter] = useState("");
  const [dedupeMeters, setDedupeMeters] = useState(250);
  const [preferEnglishName, setPreferEnglishName] = useState(false);
  const [stations, setStations] = useState<CreatorPointItem[]>([]);
  const [stationSearch, setStationSearch] = useState("");
  const [stationSummary, setStationSummary] = useState<string | null>(null);
  const [stationBusy, setStationBusy] = useState<string | null>(null);
  const [stationError, setStationError] = useState<string | null>(null);
  const [showStationQuery, setShowStationQuery] = useState(false);
  const [stationRawQuery, setStationRawQuery] = useState<string | null>(null);
  const [showZoneCircles, setShowZoneCircles] = useState(true);
  const [tierOverrides, setTierOverrides] = useState<Record<string, number>>({});
  const [newTierName, setNewTierName] = useState("");
  const [newTierRadius, setNewTierRadius] = useState("600");

  // ── Step 3: Unified Feature Layers (Points, Polygons, Lines) ────────────
  const [featureSubTab, setFeatureSubTab] = useState<FeatureSubTab>("layers");
  const [layers, setLayers] = useState<CreatorGeometryLayer[]>([]);
  const [poiBufferKm, setPoiBufferKm] = useState<number>(SCALE_PRESETS[DEFAULT_SCALE].poiBufferKm);
  const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(() => new Set());
  const [simplifyPreview, setSimplifyPreview] = useState<SimplifyPreviewState | null>(null);
  const [customEndpoint, setCustomEndpoint] = useState("");

  // ── Step 4: Review & Export ──────────────────────────────────────────────
  const [qualityIssues, setQualityIssues] = useState<QualityIssue[]>([]);
  const [checkingQuality, setCheckingQuality] = useState(false);
  const [maxKmlLayers, setMaxKmlLayers] = useState<number>(MY_MAPS_MOBILE_MAX_LAYERS);
  const [includePlayAreaKml, setIncludePlayAreaKml] = useState(true);
  const [includeCirclesKml, setIncludeCirclesKml] = useState(false);
  const [showKmlGrouping, setShowKmlGrouping] = useState(false);
  const [newFolderForLayer, setNewFolderForLayer] = useState<string | null>(null);
  const [newFolderDraft, setNewFolderDraft] = useState("");
  const [launchingAction, setLaunchingAction] = useState<"local" | "import" | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const mapRef = useRef<L.Map | null>(null);
  const stationAbortRef = useRef<AbortController | null>(null);
  const playAreaGenRef = useRef(0);
  const customStationCounterRef = useRef(1);
  const loadGameInputRef = useRef<HTMLInputElement>(null);
  const loadGameSeqRef = useRef(0);
  const skipRestoreRef = useRef(false);
  const latestDraftRef = useRef<CreatorWorkspaceDraft | null>(null);
  const draftSeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  const prevDraftRef = useRef<CreatorWorkspaceDraft | null | undefined>(undefined);
  const layersRef = useRef<CreatorGeometryLayer[]>(layers);
  layersRef.current = layers;
  const deferredGameName = useDeferredValue(gameName);
  const deferredCustomId = useDeferredValue(customId);
  const deferredRadarsText = useDeferredValue(radarsText);
  const coreAssemblyCacheRef = useRef<{
    playArea: PlayAreaFeatureCollection | null;
    stations: CreatorPointItem[];
    extraHidingZones: HidingZoneFeature[];
    preservedMetadata: PreservedGameMetadata | null;
    gameName: string;
    customId: string;
    scale: GameScale;
    unit: DistanceUnit;
    hidingRadius: number;
    tierOverrides: Record<string, number>;
    radarMode: "off" | "default" | "custom";
    radarsText: string;
    thermometer: boolean;
    layerSnapshots: Array<{
      id: string;
      name: string;
      family: GeometryFamily;
      enabledFor: CreatorGeometryLayer["enabledFor"];
      selected: boolean;
      noOverlaps?: boolean;
      items: CreatorGeometryLayer["items"];
    }>;
    result: {
      definition: GameDefinition | null;
      compiled: CompiledGame | null;
      validationErrors: string[];
      jsonSize: number;
      coreRevision: number;
    };
  } | null>(null);
  const coreRevisionSeqRef = useRef(0);

  const invalidateFetchedAreaData = useCallback((preserveData = false) => {
    playAreaGenRef.current += 1;
    stationAbortRef.current?.abort();
    stationAbortRef.current = null;
    setStationBusy(null);
    setStationError(null);
    if (!preserveData) {
      setStationSummary(null);
      // Keep user-placed and file-imported stations; only clear OSM-fetched stations.
      setStations((prev) => prev.filter((s) => s.custom));
      // Drop OSM-fetched layers from the old area; keep file-imported & loaded layers.
      setLayers((prev) => prev.filter((l) => !l.sourceLabel.startsWith("OSM ")));
      setVisibleLayerIds(new Set());
    }
    // Clear preserved authored view bounds/center once the user edits the play area.
    setPreservedMetadata((prev) =>
      prev ? { ...prev, bounds: undefined, center: undefined } : prev,
    );
  }, []);

  const applyScalePreset = (nextScale: GameScale) => {
    const preset = SCALE_PRESETS[nextScale];
    setScale(nextScale);
    setUnit(preset.unit);
    setHidingRadius(preset.hidingRadius);
    setRadarMode("custom");
    setRadarsText(preset.radars.join(", "));
    setThermometer(preset.thermometer);
    setStationTypes([...preset.stationTypes]);
    setPoiBufferKm(preset.poiBufferKm);
  };

  const setPlayAreaAndFit = useCallback(
    (next: PlayAreaFeatureCollection, options?: { preserveData?: boolean }) => {
      invalidateFetchedAreaData(options?.preserveData);
      setPlayArea(next);
      setPlayAreaVersion((v) => v + 1);
      const bounds = tryPlayAreaBounds(next);
      if (bounds) {
        setFitTarget((prev) => ({
          bounds,
          seq: (prev?.seq ?? 0) + 1,
        }));
      }
    },
    [invalidateFetchedAreaData],
  );

  const clearPlayArea = useCallback(() => {
    invalidateFetchedAreaData();
    setPlayArea(null);
  }, [invalidateFetchedAreaData]);

  // ── Place search ─────────────────────────────────────────────────────────
  const handlePlaceSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!placeQuery.trim()) return;
    setPlaceError(null);
    setPlaceSearching(true);
    try {
      const results = await searchPlaces(placeQuery);
      setPlaceResults(results);
      if (results.length === 0) {
        setPlaceError(
          "No matching places found. Try a city or region name, or draw the play area on the map.",
        );
      }
    } catch (err) {
      setPlaceError(
        err instanceof Error ? err.message : "Place search failed. Check your connection.",
      );
    } finally {
      setPlaceSearching(false);
    }
  };

  const handlePickPlace = (place: PlaceSearchResult) => {
    setPlayAreaAndFit(place.playArea);
    if (!gameName.trim()) {
      setGameName(place.name);
    }
    setPlaceResults([]);
    setPlaceError(null);
    setInteractionMode("browse");
    setDrawPoints([]);
  };

  const handleUseMapView = () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    const bounds: Bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    if (bounds[2] - bounds[0] > 40 || bounds[3] - bounds[1] > 30) {
      toast.warn(
        "Zoom in closer before using the map view. A continent-sized box will time out Overpass.",
      );
      return;
    }
    setPlayAreaAndFit(rectanglePlayArea(bounds, gameName.trim() || "Play Area"));
    setInteractionMode("browse");
    setDrawPoints([]);
  };

  const handleFinishDrawing = () => {
    const result = buildValidatedDrawnPlayArea(drawPoints, gameName.trim() || "Play Area");
    if (!result.ok) {
      toast.warn(result.error);
      return;
    }
    setPlayAreaAndFit(result.playArea);
    setDrawPoints([]);
    setInteractionMode("browse");
  };

  const handleMapClick = useCallback(
    (lat: number, lng: number) => {
      if (interactionMode === "draw-area") {
        setDrawPoints((prev) => [...prev, [lat, lng]]);
      } else if (interactionMode === "add-station") {
        const n = customStationCounterRef.current++;
        const station: CreatorPointItem = {
          uid: `custom-st-${Date.now()}-${n}`,
          name: `Station ${n}`,
          lng: Math.round(lng * 1e6) / 1e6,
          lat: Math.round(lat * 1e6) / 1e6,
          enabled: true,
          custom: true,
        };
        setStations((prev) => [station, ...prev]);
        toast.success(`Added ${station.name}`);
      }
    },
    [interactionMode],
  );

  const hasPlayAreaGeometry = Boolean(playArea && playArea.features.length > 0);

  const generatedStationQuery = useMemo(() => {
    if (!hasPlayAreaGeometry || !playArea) return "";
    const bounds = tryPlayAreaBounds(playArea);
    if (!bounds) return "";
    const filters = getOsmFiltersForStationTypes(stationTypes);
    const trimmedCustom = customStationFilter.trim();
    if (trimmedCustom) {
      const check = validateCustomOsmFilter(trimmedCustom);
      if (!check.ok) return "";
      filters.push(check.filter);
    }
    if (filters.length === 0) return "";
    return buildStationOverpassQuery(filters, bounds);
  }, [hasPlayAreaGeometry, playArea, stationTypes, customStationFilter]);

  useEffect(() => {
    setStationRawQuery(null);
  }, [playArea, stationTypes, customStationFilter]);

  const handleToggleStationType = useCallback((id: StationTypeId, checked: boolean) => {
    setStationTypes((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((t) => t !== id),
    );
  }, []);

  // ── Fetch stations (Transitous GTFS or OpenStreetMap) ────────────────────
  const handleFetchStations = async (sourceOverride?: StationSource) => {
    if (!hasPlayAreaGeometry || !playArea) {
      setStationError("Set a play area in Step 1 first.");
      return;
    }
    const activeSource = sourceOverride ?? stationSource;
    const trimmedRawQuery =
      activeSource === "osm" ? stationRawQuery?.trim() || undefined : undefined;
    let osmFilters: string[] = [];
    let transitousModes: string[] = [];

    if (activeSource === "transitous") {
      transitousModes = getTransitousModesForStationTypes(stationTypes);
      if (transitousModes.length === 0) {
        setStationError("Select at least one transit type to fetch.");
        return;
      }
    } else if (!trimmedRawQuery) {
      osmFilters = getOsmFiltersForStationTypes(stationTypes);
      const trimmedCustom = customStationFilter.trim();
      if (trimmedCustom) {
        const check = validateCustomOsmFilter(trimmedCustom);
        if (!check.ok) {
          setStationError(check.error);
          return;
        }
        osmFilters.push(check.filter);
      }
      if (osmFilters.length === 0) {
        setStationError("Select at least one transit type or enter a custom OSM tag filter.");
        return;
      }
    }

    stationAbortRef.current?.abort();
    const controller = new AbortController();
    stationAbortRef.current = controller;
    const areaGen = playAreaGenRef.current;
    setStationError(null);
    setStationBusy(
      activeSource === "transitous"
        ? "Querying Transitous (GTFS) for stations…"
        : "Querying OpenStreetMap for stations…",
    );

    try {
      const result =
        activeSource === "transitous"
          ? await fetchStationsFromTransitous({
              modes: transitousModes,
              playArea,
              dedupeMeters,
              preferEnglishName,
              signal: controller.signal,
              onStatus: (msg) => {
                if (playAreaGenRef.current === areaGen) setStationBusy(msg);
              },
            })
          : await fetchStationsFromOsm({
              filters: osmFilters,
              playArea,
              dedupeMeters,
              preferEnglishName,
              customEndpoint: customEndpoint.trim() || undefined,
              rawQueryOverride: trimmedRawQuery,
              signal: controller.signal,
              onStatus: (msg) => {
                if (playAreaGenRef.current === areaGen) setStationBusy(msg);
              },
            });
      if (playAreaGenRef.current !== areaGen) return;
      setStations((prev) => {
        // Keep manually placed stations and preserve user curation
        // (edited name, tier, enabled) on matching fetched stations across refetches.
        const manual = prev.filter((s) => s.custom);
        const prevByOsmId = new Map<string, CreatorPointItem>();
        for (const s of prev) {
          if (!s.custom && s.osmId) prevByOsmId.set(s.osmId, s);
        }
        const merged = result.stations.map((s) => {
          const existing = s.osmId ? prevByOsmId.get(s.osmId) : undefined;
          if (!existing) return s;
          return {
            ...s,
            uid: existing.uid,
            ...(existing.nameEdited && {
              name: existing.name,
              nameEdited: true,
            }),
            enabled: existing.enabled,
            ...(existing.tier !== undefined && {
              tier: existing.tier,
            }),
          };
        });
        return [...manual, ...merged];
      });
      const parts = [
        `Found ${result.stations.length} station${result.stations.length === 1 ? "" : "s"} (${activeSource === "transitous" ? "Transitous" : "OSM"})`,
      ];
      if (result.mergedCount > 0) {
        parts.push(`merged ${result.mergedCount} duplicates`);
      }
      if (result.outsideCount > 0) {
        parts.push(`excluded ${result.outsideCount} outside play area`);
      }
      setStationSummary(parts.join(" · "));
    } catch (err) {
      if (
        playAreaGenRef.current !== areaGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setStationError(
        err instanceof Error
          ? err.message
          : activeSource === "transitous"
            ? "Failed to fetch stations from Transitous."
            : "Failed to fetch stations from OpenStreetMap.",
      );
    } finally {
      if (stationAbortRef.current === controller) {
        stationAbortRef.current = null;
        setStationBusy(null);
      }
    }
  };

  const existingLayerSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const l of layers) {
      const s = layerSlugOf(l.name);
      if (s) set.add(s);
    }
    return set;
  }, [layers]);

  const handleDecodeAllEntities = useCallback(() => {
    let changed = 0;
    const clean = (s: string) => {
      const d = decodeImportedText(s);
      if (d !== s) changed++;
      return d;
    };
    const nextGameName = clean(gameName);
    const nextStations = stations.map((s) => {
      const decoded = clean(s.name);
      return decoded === s.name ? s : { ...s, name: decoded, nameEdited: true };
    });
    const nextExtraZones = extraHidingZones.map((z) => {
      const name = z.properties?.name;
      if (typeof name !== "string") return z;
      const decoded = clean(name);
      if (decoded === name) return z;
      return {
        ...z,
        properties: { ...z.properties, name: decoded },
      };
    });
    const nextLayers = layers.map((l) => ({
      ...l,
      name: clean(l.name),
      items: l.items.map((item) => ({
        ...item,
        name: clean(item.name),
      })),
    }));
    if (changed > 0) {
      setGameName(nextGameName);
      setStations(nextStations);
      setExtraHidingZones(nextExtraZones);
      setLayers(nextLayers);
    }
    toast.success(
      changed > 0
        ? `Decoded XML/HTML entities in ${changed} name${changed === 1 ? "" : "s"}`
        : "No XML/HTML entities found to decode",
    );
  }, [gameName, stations, extraHidingZones, layers]);

  const handleQuickSimplifyLayer = useCallback(
    (targetName: string, toleranceMeters = 10) => {
      const target = layers.find((l) => l.selected && l.name.trim() === targetName);
      if (!target || target.family === "points") return;
      const before = target.vertexCount;
      const result =
        target.family === "polygons"
          ? simplifyPolygonLayerTopology(target.items, toleranceMeters)
          : simplifyLineLayerTopology(target.items, toleranceMeters);
      setLayers((prev) =>
        prev.map((l) =>
          l.id === target.id
            ? {
                ...l,
                items: result.items,
                vertexCount: result.vertexCount,
                ...(l.family === "polygons" && {
                  noOverlaps: false,
                }),
              }
            : l,
        ),
      );
      toast.success(
        `Simplified "${target.name}": ${before.toLocaleString()} → ${result.vertexCount.toLocaleString()} vertices (${toleranceMeters} m)`,
      );
    },
    [layers],
  );

  const handleQuickSingularizeLayer = useCallback(
    (targetName: string) => {
      const target = layers.find((l) => l.selected && l.name.trim() === targetName);
      if (!target) return;
      const nextName = suggestSingularLayerName(target.name);
      const nextSlug = layerSlugOf(nextName);
      if (!nextName || nextName === target.name || !nextSlug) return;
      const collision = layers.find((l) => l.id !== target.id && layerSlugOf(l.name) === nextSlug);
      if (collision) {
        toast.error(
          `Cannot rename "${target.name}" to "${nextName}" because "${collision.name}" already uses ID "${nextSlug}".`,
        );
        return;
      }
      setLayers((prev) => prev.map((l) => (l.id === target.id ? { ...l, name: nextName } : l)));
      toast.success(`Renamed "${target.name}" → "${nextName}"`);
    },
    [layers],
  );

  const handleUpsertOsmLayer = useCallback((incoming: CreatorGeometryLayer) => {
    const matchesExistingOsm = (l: CreatorGeometryLayer) =>
      l.id === incoming.id ||
      (Boolean(incoming.osmFilter) &&
        l.sourceLabel.startsWith("OSM ") &&
        l.family === incoming.family &&
        layerSlugOf(l.name) === layerSlugOf(incoming.name));

    const existingBefore = layersRef.current.find(matchesExistingOsm);
    const targetId = existingBefore?.id ?? incoming.id;

    setLayers((prev) => {
      const existingIdx = prev.findIndex(matchesExistingOsm);
      if (existingIdx >= 0) {
        return prev.map((l, idx) =>
          idx === existingIdx
            ? {
                ...l,
                items: incoming.items,
                vertexCount: incoming.vertexCount,
                osmFilter: incoming.osmFilter ?? l.osmFilter,
                notableOnly: incoming.notableOnly ?? l.notableOnly,
                kmlGroup: incoming.kmlGroup ?? l.kmlGroup,
                sourceLabel: incoming.sourceLabel,
                selected: true,
              }
            : l,
        );
      }
      const usedSlugs = new Set(prev.map((l) => layerSlugOf(l.name)).filter(Boolean));
      let finalName = incoming.name;
      let suffix = 2;
      while (usedSlugs.has(layerSlugOf(finalName))) {
        finalName = `${incoming.name} ${suffix++}`;
      }
      return [...prev, { ...incoming, name: finalName }];
    });
    setVisibleLayerIds((prev) => new Set(prev).add(targetId));
  }, []);

  const handleLoadExistingGame = useCallback((def: GameDefinition) => {
    skipRestoreRef.current = true;
    playAreaGenRef.current += 1;
    stationAbortRef.current?.abort();
    stationAbortRef.current = null;
    setStationBusy(null);
    setStationError(null);
    setDrawPoints([]);
    setInteractionMode("browse");

    setGameName(def.name);
    setCustomId(def.id ?? "");
    setScale(def.size ?? "medium");
    setUnit(def.unit ?? def.hidingZones.unit ?? "meters");
    setHidingRadius(def.hidingZones.radius ?? 400);
    setTierOverrides({ ...(def.hidingZones.tierOverrides ?? {}) });
    if (Array.isArray(def.radars)) {
      setRadarMode("custom");
      setRadarsText(def.radars.join(", "));
    } else if (def.radars === true) {
      setRadarMode("default");
      setRadarsText("");
    } else {
      setRadarMode("off");
      setRadarsText("");
    }
    setThermometer(Boolean(def.thermometer));
    setPreservedMetadata({
      serverId: def.serverId,
      revision: def.revision,
      visibility: def.visibility,
      bounds: def.map.bounds,
      center: def.map.center,
    });

    setPlayArea(def.map.playArea);
    setPlayAreaVersion((v) => v + 1);
    const fitBounds =
      tryPlayAreaBounds(def.map.playArea) ??
      def.map.bounds ??
      (Array.isArray(def.map.center) &&
      Number.isFinite(def.map.center[0]) &&
      Number.isFinite(def.map.center[1])
        ? ([
            def.map.center[0] - 0.05,
            def.map.center[1] - 0.05,
            def.map.center[0] + 0.05,
            def.map.center[1] + 0.05,
          ] as Bounds)
        : null);
    if (fitBounds) {
      setFitTarget((prev) => ({
        bounds: fitBounds,
        seq: (prev?.seq ?? 0) + 1,
      }));
    }

    const loadedStations: CreatorPointItem[] = [];
    const loadedExtraZones: HidingZoneFeature[] = [];
    def.hidingZones.features.features.forEach((f, idx) => {
      if (f.geometry.type !== "Point") {
        loadedExtraZones.push(f);
        return;
      }
      const rawTier = f.properties?.tier;
      const tier =
        typeof rawTier === "string"
          ? rawTier
          : typeof rawTier === "number"
            ? String(rawTier)
            : undefined;
      loadedStations.push({
        uid: `loaded-st-${Date.now()}-${idx}`,
        name:
          typeof f.properties?.name === "string" && f.properties.name
            ? f.properties.name
            : `Station ${idx + 1}`,
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        tier,
        enabled: true,
        custom: true,
        originalId: f.id,
        originalProperties: f.properties ? { ...f.properties } : undefined,
      });
    });
    setStations(loadedStations);
    setExtraHidingZones(loadedExtraZones);
    setStationSummary(
      loadedExtraZones.length > 0
        ? `Loaded ${loadedStations.length} point station(s) + ${loadedExtraZones.length} polygon hiding zone(s) from file`
        : `Loaded ${loadedStations.length} stations from file`,
    );

    const loadedGeoLayers: CreatorGeometryLayer[] = (def.features ?? []).map((feat, idx) => {
      const firstType = feat.data.features[0]?.geometry.type;
      const fam: GeometryFamily =
        firstType === undefined || firstType === "Point"
          ? "points"
          : firstType === "LineString" || firstType === "MultiLineString"
            ? "lines"
            : "polygons";
      const items = feat.data.features.map((f, fIdx) => ({
        uid: `loaded-f-${idx}-${fIdx}`,
        name:
          typeof f.properties?.name === "string" && f.properties.name
            ? f.properties.name
            : `${feat.name} ${fIdx + 1}`,
        geometry: f.geometry,
        enabled: true,
        originalId: f.id,
        originalProperties: f.properties ? { ...f.properties } : undefined,
      }));
      return {
        id: `loaded-layer-${Date.now()}-${idx}`,
        name: feat.name,
        family: fam,
        enabledFor: [...feat.enabledFor],
        color: feat.color ?? inferLayerColor(feat.name, idx),
        ...(fam === "points" && {
          icon: feat.icon ?? inferLayerIcon(feat.name),
        }),
        ...(feat.kmlFolder && { kmlFolder: feat.kmlFolder }),
        selected: true,
        noOverlaps: feat.noOverlaps === true,
        sourceLabel: "Loaded .game.json",
        items,
        vertexCount: sumFeatureVertices(items),
      };
    });
    setLayers(loadedGeoLayers);
    setVisibleLayerIds(new Set(loadedGeoLayers.slice(0, 1).map((l) => l.id)));
  }, []);

  const handleLoadGameFile = async (file: File) => {
    const seq = ++loadGameSeqRef.current;
    if (file.size > MAX_LOCAL_GAME_BYTES) {
      toast.error("File is too large (50 MB limit).");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (loadGameSeqRef.current !== seq) return;
      toast.error("Could not read file.");
      return;
    }
    if (loadGameSeqRef.current !== seq) return;
    const parsed = parseJsonImportText(text, file.name);
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    if (parsed.kind !== "game-definition") {
      toast.error(
        "That file looks like plain GeoJSON, not a full Searchlight .game.json. Use Step 2 (Stops) or Step 3 → Import File for GeoJSON.",
      );
      return;
    }
    handleLoadExistingGame(parsed.definition);
    toast.success(`Loaded "${parsed.definition.name}" into Creator`);
  };

  const handleAddTier = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newTierName.trim();
    const radius = Number(newTierRadius);
    if (!name || !Number.isFinite(radius) || radius <= 0) return;
    setTierOverrides((prev) => ({ ...prev, [name]: radius }));
    setNewTierName("");
  };

  // ── Live assembled GameDefinition & validation ───────────────────────────
  const assembled = useMemo<{
    definition: GameDefinition | null;
    compiled: CompiledGame | null;
    validationErrors: string[];
    jsonSize: number;
    coreRevision: number;
  }>(() => {
    const cached = coreAssemblyCacheRef.current;
    const structureUnchanged =
      cached !== null &&
      cached.playArea === playArea &&
      cached.stations === stations &&
      cached.extraHidingZones === extraHidingZones &&
      cached.preservedMetadata === preservedMetadata &&
      cached.gameName === deferredGameName &&
      cached.customId === deferredCustomId &&
      cached.scale === scale &&
      cached.unit === unit &&
      cached.hidingRadius === hidingRadius &&
      cached.tierOverrides === tierOverrides &&
      cached.radarMode === radarMode &&
      cached.radarsText === deferredRadarsText &&
      cached.thermometer === thermometer &&
      cached.layerSnapshots.length === layers.length &&
      cached.layerSnapshots.every((snap, idx) => {
        const l = layers[idx];
        return (
          snap.id === l.id &&
          snap.name === l.name &&
          snap.family === l.family &&
          snap.enabledFor === l.enabledFor &&
          snap.selected === l.selected &&
          snap.noOverlaps === l.noOverlaps &&
          snap.items === l.items
        );
      });

    // Fast path: only layer display/KML metadata (color, icon, kmlFolder,
    // kmlGroup) changed. Shallow-patch onto the already validated definition
    // without re-validating coordinates or re-compiling questions.
    if (structureUnchanged && cached) {
      const base = cached.result;
      if (!base.definition?.features) return base;
      const activeByName = new Map<string, CreatorGeometryLayer>();
      for (const l of layers) {
        if (!l.selected) continue;
        const key = l.name.trim();
        if (key && !activeByName.has(key)) activeByName.set(key, l);
      }
      const nextFeatures = base.definition.features.map((feat) => {
        const src = activeByName.get(feat.name);
        if (!src) return feat;
        const next = { ...feat };
        if (/^#[0-9a-fA-F]{6}$/.test(src.color)) {
          next.color = src.color;
        } else {
          delete next.color;
        }
        if (src.family === "points" && src.icon) {
          next.icon = src.icon;
        } else {
          delete next.icon;
        }
        const folder = src.kmlFolder?.trim().slice(0, 100);
        if (folder) {
          next.kmlFolder = folder;
        } else {
          delete next.kmlFolder;
        }
        return next;
      });
      return {
        ...base,
        definition: {
          ...base.definition,
          features: nextFeatures,
        },
      };
    }

    const saveCache = (result: {
      definition: GameDefinition | null;
      compiled: CompiledGame | null;
      validationErrors: string[];
      jsonSize: number;
      coreRevision: number;
    }) => {
      coreAssemblyCacheRef.current = {
        playArea,
        stations,
        extraHidingZones,
        preservedMetadata,
        gameName: deferredGameName,
        customId: deferredCustomId,
        scale,
        unit,
        hidingRadius,
        tierOverrides,
        radarMode,
        radarsText: deferredRadarsText,
        thermometer,
        layerSnapshots: layers.map((l) => ({
          id: l.id,
          name: l.name,
          family: l.family,
          enabledFor: l.enabledFor,
          selected: l.selected,
          noOverlaps: l.noOverlaps,
          items: l.items,
        })),
        result,
      };
      return result;
    };

    const nextCoreRev = ++coreRevisionSeqRef.current;

    if (!playArea) {
      return saveCache({
        definition: null,
        compiled: null,
        validationErrors: ["Set a play area in Step 1."],
        jsonSize: 0,
        coreRevision: nextCoreRev,
      });
    }
    const activeStations = stations.filter((s) => s.enabled);
    if (activeStations.length === 0 && extraHidingZones.length === 0) {
      return saveCache({
        definition: null,
        compiled: null,
        validationErrors: ["Add or fetch at least one enabled station in Step 2."],
        jsonSize: 0,
        coreRevision: nextCoreRev,
      });
    }

    const layerNameErrors = validateCreatorLayers(layers);
    if (layerNameErrors.length > 0) {
      return saveCache({
        definition: null,
        compiled: null,
        validationErrors: layerNameErrors,
        jsonSize: 0,
        coreRevision: nextCoreRev,
      });
    }

    const parsedRadars = radarMode === "custom" ? parseRadarsText(deferredRadarsText) : [];
    const radarsValue: boolean | number[] =
      radarMode === "off"
        ? false
        : radarMode === "custom" && parsedRadars.length > 0
          ? parsedRadars
          : true;
    const definition = assembleGameDefinition({
      name: deferredGameName,
      id: deferredCustomId,
      size: scale,
      unit,
      hidingRadius,
      tierOverrides,
      radars: radarsValue,
      thermometer,
      playArea,
      stations,
      extraHidingZones,
      preservedMetadata,
      layers,
    });

    const validation = validateGameDefinition(definition);
    if (!validation.valid) {
      return saveCache({
        definition,
        compiled: null,
        validationErrors: validation.errors.map(
          (e) => `${e.path && e.path !== "/" ? `${e.path}: ` : ""}${e.message}`,
        ),
        jsonSize: 0,
        coreRevision: nextCoreRev,
      });
    }

    try {
      const compiled = compileGameDefinition(definition);
      const compactSize = new TextEncoder().encode(JSON.stringify(definition)).byteLength;
      return saveCache({
        definition,
        compiled,
        validationErrors: [],
        jsonSize: compactSize,
        coreRevision: nextCoreRev,
      });
    } catch (err) {
      return saveCache({
        definition,
        compiled: null,
        validationErrors: [
          err instanceof Error ? err.message : "Failed to compile game definition",
        ],
        jsonSize: 0,
        coreRevision: nextCoreRev,
      });
    }
  }, [
    playArea,
    stations,
    extraHidingZones,
    preservedMetadata,
    deferredGameName,
    deferredCustomId,
    scale,
    unit,
    hidingRadius,
    tierOverrides,
    radarMode,
    deferredRadarsText,
    thermometer,
    layers,
  ]);

  const assembledDefRef = useRef<GameDefinition | null>(null);
  assembledDefRef.current = assembled.definition;

  // Run check-game.mjs quality checks when viewing the Export step (only when
  // structural data changes, debounced so UI interactions never stutter).
  useEffect(() => {
    if (step !== "export" || !assembledDefRef.current || !assembled.compiled) {
      setQualityIssues([]);
      setCheckingQuality(false);
      return;
    }
    let cancelled = false;
    setCheckingQuality(true);
    const timer = window.setTimeout(() => {
      const def = assembledDefRef.current;
      if (cancelled || !def) return;
      void checkGameQuality(def)
        .then((issues) => {
          if (!cancelled) setQualityIssues(issues);
        })
        .catch(() => {
          if (!cancelled) setQualityIssues([]);
        })
        .finally(() => {
          if (!cancelled) setCheckingQuality(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [step, assembled.coreRevision, assembled.compiled]);

  // Preview hiding zone circles when enabled on map.
  const previewCircles = useMemo(() => {
    if (!showZoneCircles || !assembled.compiled) return null;
    return turf.featureCollection(hidingZoneCircles(assembled.compiled));
  }, [showZoneCircles, assembled.compiled]);

  const layerColorsMap = useMemo(() => {
    const map = Object.create(null) as Record<string, string>;
    for (const l of layers) {
      if (!l.selected) continue;
      const key = l.name.trim();
      if (key && !(key in map)) map[key] = l.color;
    }
    return map;
  }, [layers]);

  const layerGroupsMap = useMemo(() => {
    const map = Object.create(null) as Record<string, string>;
    for (const l of layers) {
      if (!l.selected || !l.kmlGroup) continue;
      const key = l.name.trim();
      if (key && !(key in map)) map[key] = l.kmlGroup;
    }
    return map;
  }, [layers]);

  // Lightweight KML folder plan (< 0.1 ms). Full XML is generated lazily on download.
  const kmlPlan = useMemo(() => {
    if (step !== "export" || !assembled.definition || !assembled.compiled) {
      return null;
    }
    try {
      return planKmlFolders(assembled.definition, {
        maxLayers: maxKmlLayers,
        includePlayArea: includePlayAreaKml,
        includeHidingZoneCircles: includeCirclesKml,
        layerColors: layerColorsMap,
        layerGroups: layerGroupsMap,
      });
    } catch {
      return null;
    }
  }, [
    step,
    assembled.definition,
    assembled.compiled,
    maxKmlLayers,
    includePlayAreaKml,
    includeCirclesKml,
    layerColorsMap,
    layerGroupsMap,
  ]);

  // ── Export & handoff actions ─────────────────────────────────────────────
  const assemblyPending =
    gameName !== deferredGameName ||
    customId !== deferredCustomId ||
    radarsText !== deferredRadarsText;

  const fileStem = assembled.definition
    ? resolveGameDefinitionId(assembled.definition)
    : "custom-game";

  const handleDownloadJson = () => {
    if (!assembled.definition || assemblyPending) return;
    downloadBlob(
      `${fileStem}.game.json`,
      formatGameDefinitionJson(assembled.definition),
      "application/json",
    );
    toast.success(`Downloaded ${fileStem}.game.json`);
  };

  const handleDownloadKml = () => {
    if (!assembled.definition || assemblyPending) return;
    const result = buildGameKml(assembled.definition, {
      maxLayers: maxKmlLayers,
      includePlayArea: includePlayAreaKml,
      includeHidingZoneCircles: includeCirclesKml,
      layerColors: layerColorsMap,
      layerGroups: layerGroupsMap,
    });
    downloadBlob(`${fileStem}.kml`, result.kml, "application/vnd.google-earth.kml+xml");
    const sizeWarn = result.myMapsWarnings.find((w) => w.includes("5 MB"));
    if (sizeWarn) {
      toast.warn(`Downloaded ${fileStem}.kml (${sizeWarn})`);
    } else {
      toast.success(`Downloaded ${fileStem}.kml (${formatFileSize(result.byteLength)})`);
    }
  };

  const handleDownloadSingleKmlFolder = (folderName: string) => {
    if (!assembled.definition || assemblyPending) return;
    const single = buildGameKml(assembled.definition, {
      maxLayers: maxKmlLayers,
      includePlayArea: includePlayAreaKml,
      includeHidingZoneCircles: includeCirclesKml,
      layerColors: layerColorsMap,
      layerGroups: layerGroupsMap,
      onlyFolder: folderName,
    });
    if (single.folderCount === 0) return;
    const folderSlug = layerSlugOf(folderName) || "layer";
    const fileName = `${fileStem}-${folderSlug}.kml`;
    downloadBlob(fileName, single.kml, "application/vnd.google-earth.kml+xml");
    toast.success(`Downloaded ${fileName}`);
  };

  const handleTestLocally = async () => {
    if (!assembled.definition || !assembled.compiled || assemblyPending) return;
    // Open a new tab synchronously on click so testing doesn't wipe the draft.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setLaunchingAction("local");
    try {
      const persistent = await isLocalStoragePersistent();
      if (!persistent) {
        popup?.close();
        toast.error(
          "Browser storage (IndexedDB) is unavailable in this window. Download the .game.json file and open it on /local instead.",
        );
        return;
      }
      const saved = await saveLocalGame(assembled.definition, {
        kind: "file",
        label: "Map Creator",
      });
      const session = await createLocalSession(saved, `${assembled.definition.name} (Test)`);
      const targetUrl = `/local?session=${encodeURIComponent(session.id)}`;
      if (popup && !popup.closed) {
        popup.location.href = targetUrl;
      } else {
        writeLastLocalSessionId(session.id);
        window.location.href = targetUrl;
      }
    } catch (err) {
      popup?.close();
      toast.error(err instanceof Error ? err.message : "Couldn't open local session.");
    } finally {
      setLaunchingAction(null);
    }
  };

  const handleImportToSearchlight = async () => {
    if (!assembled.definition || !assembled.compiled || assemblyPending) return;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    setLaunchingAction("import");
    try {
      const draftId = await saveCreatorImportHandoff(`${fileStem}.game.json`, assembled.definition);
      if (!draftId) {
        popup?.close();
        toast.error(
          "Browser storage is unavailable. Download the .game.json file and upload it on /games/import instead.",
        );
        return;
      }
      const targetUrl = `/games/import?from=creator&draft=${encodeURIComponent(draftId)}`;
      if (popup && !popup.closed) {
        popup.location.href = targetUrl;
      } else {
        window.location.href = targetUrl;
      }
    } finally {
      setLaunchingAction(null);
    }
  };

  // ── Workspace draft autosave & restore across reloads (IndexedDB) ────────
  const hasWorkspaceProgress = Boolean(
    gameName.trim() ||
      customId.trim() ||
      (playArea && playArea.features.length > 0) ||
      stations.length > 0 ||
      extraHidingZones.length > 0 ||
      layers.length > 0,
  );

  const workspaceDraft = useMemo<CreatorWorkspaceDraft | null>(() => {
    if (!hasWorkspaceProgress) return null;
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      step,
      gameName,
      customId,
      scale,
      unit,
      hidingRadius,
      radarMode,
      radarsText,
      thermometer,
      playArea,
      preservedMetadata,
      stationSource,
      stationTypes,
      customStationFilter,
      dedupeMeters,
      preferEnglishName,
      stations,
      extraHidingZones,
      tierOverrides,
      layers,
      visibleLayerIds: [...visibleLayerIds],
      poiBufferKm,
      customEndpoint,
      maxKmlLayers,
      includePlayAreaKml,
      includeCirclesKml,
    };
  }, [
    hasWorkspaceProgress,
    step,
    gameName,
    customId,
    scale,
    unit,
    hidingRadius,
    radarMode,
    radarsText,
    thermometer,
    playArea,
    preservedMetadata,
    stationSource,
    stationTypes,
    customStationFilter,
    dedupeMeters,
    preferEnglishName,
    stations,
    extraHidingZones,
    tierOverrides,
    layers,
    visibleLayerIds,
    poiBufferKm,
    customEndpoint,
    maxKmlLayers,
    includePlayAreaKml,
    includeCirclesKml,
  ]);

  latestDraftRef.current = workspaceDraft;

  // Restore autosaved draft once on mount (unless user already loaded/reset).
  useEffect(() => {
    let cancelled = false;
    void readCreatorWorkspaceDraft().then((saved) => {
      if (cancelled) return;
      if (
        !skipRestoreRef.current &&
        !latestDraftRef.current &&
        saved &&
        (saved.gameName.trim() ||
          saved.customId.trim() ||
          (saved.playArea && saved.playArea.features.length > 0) ||
          saved.stations.length > 0 ||
          saved.extraHidingZones.length > 0 ||
          saved.layers.length > 0)
      ) {
        setStep(saved.step);
        setGameName(saved.gameName);
        setCustomId(saved.customId);
        setScale(saved.scale);
        setUnit(saved.unit);
        setHidingRadius(saved.hidingRadius);
        setRadarMode(saved.radarMode);
        setRadarsText(saved.radarsText);
        setThermometer(saved.thermometer);
        setPlayArea(saved.playArea);
        setPlayAreaVersion((v) => v + 1);
        setPreservedMetadata(saved.preservedMetadata);
        setStationSource(saved.stationSource ?? "transitous");
        setStationTypes(
          Array.isArray(saved.stationTypes)
            ? saved.stationTypes
            : stationTypesFromLegacyPreset(saved.stationPreset, saved.scale),
        );
        setCustomStationFilter(saved.stationTypes ? (saved.customStationFilter ?? "") : "");
        setDedupeMeters(saved.dedupeMeters);
        setPreferEnglishName(saved.preferEnglishName);
        setStations(saved.stations);
        setExtraHidingZones(saved.extraHidingZones);
        setTierOverrides(saved.tierOverrides);
        setLayers(saved.layers);
        setVisibleLayerIds(new Set(saved.visibleLayerIds));
        setPoiBufferKm(saved.poiBufferKm);
        setCustomEndpoint(saved.customEndpoint);
        setMaxKmlLayers(saved.maxKmlLayers);
        setIncludePlayAreaKml(saved.includePlayAreaKml);
        setIncludeCirclesKml(saved.includeCirclesKml);

        const bounds =
          (saved.playArea && tryPlayAreaBounds(saved.playArea)) ??
          saved.preservedMetadata?.bounds ??
          null;
        if (bounds) {
          setFitTarget((prev) => ({
            bounds,
            seq: (prev?.seq ?? 0) + 1,
          }));
        }
        toast.info("Restored your in-progress map draft", {
          toastId: "creator-draft-restored",
        });
      }
      setDraftHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced IndexedDB autosave after initial hydration completes.
  // Uses a monotonic sequence so an older commit never clears a newer edit's
  // dirty state, and an untouched tab never overwrites another tab's changes.
  useEffect(() => {
    if (!draftHydrated) return;
    if (prevDraftRef.current === undefined) {
      prevDraftRef.current = workspaceDraft;
      if (!skipRestoreRef.current) return;
    } else if (prevDraftRef.current === workspaceDraft) {
      return;
    } else {
      prevDraftRef.current = workspaceDraft;
    }
    const seq = ++draftSeqRef.current;
    const timer = window.setTimeout(() => {
      if (workspaceDraft) {
        void saveCreatorWorkspaceDraft(workspaceDraft).then((ok) => {
          if (ok) {
            if (savedSeqRef.current < seq) {
              savedSeqRef.current = seq;
            }
          } else {
            toast.warn(
              "Couldn't autosave your draft to browser storage. Download .game.json to keep a backup.",
              { toastId: "creator-autosave-failed" },
            );
          }
        });
      } else {
        void clearCreatorWorkspaceDraft().then(() => {
          if (savedSeqRef.current < seq) {
            savedSeqRef.current = seq;
          }
        });
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftHydrated, workspaceDraft]);

  // Flush pending draft immediately when navigating away or reloading.
  useEffect(() => {
    if (!draftHydrated) return;
    const flush = () => {
      if (savedSeqRef.current >= draftSeqRef.current) return;
      savedSeqRef.current = draftSeqRef.current;
      flushCreatorWorkspaceDraftSync(latestDraftRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [draftHydrated]);

  // Auto-clear inline "Reset?" confirmation after 3 seconds.
  useEffect(() => {
    if (!confirmReset) return;
    const t = window.setTimeout(() => setConfirmReset(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmReset]);

  const handleResetWorkspace = () => {
    skipRestoreRef.current = true;
    playAreaGenRef.current += 1;
    stationAbortRef.current?.abort();
    stationAbortRef.current = null;
    setConfirmReset(false);
    setStep("area");
    setInteractionMode("browse");
    setGameName("");
    setCustomId("");
    setScale(DEFAULT_SCALE);
    setUnit(SCALE_PRESETS[DEFAULT_SCALE].unit);
    setHidingRadius(SCALE_PRESETS[DEFAULT_SCALE].hidingRadius);
    setRadarMode("custom");
    setRadarsText(SCALE_PRESETS[DEFAULT_SCALE].radars.join(", "));
    setThermometer(SCALE_PRESETS[DEFAULT_SCALE].thermometer);
    setPreservedMetadata(null);
    setExtraHidingZones([]);
    setPlayArea(null);
    setPlayAreaVersion((v) => v + 1);
    setDrawPoints([]);
    setPlaceQuery("");
    setPlaceResults([]);
    setPlaceError(null);
    setStationSource("transitous");
    setStationTypes([...SCALE_PRESETS[DEFAULT_SCALE].stationTypes]);
    setCustomStationFilter("");
    setDedupeMeters(250);
    setPreferEnglishName(false);
    setStations([]);
    setStationSearch("");
    setStationSummary(null);
    setStationBusy(null);
    setStationError(null);
    setStationRawQuery(null);
    setTierOverrides({});
    setLayers([]);
    setVisibleLayerIds(new Set());
    setPoiBufferKm(SCALE_PRESETS[DEFAULT_SCALE].poiBufferKm);
    setMaxKmlLayers(MY_MAPS_MOBILE_MAX_LAYERS);
    setIncludePlayAreaKml(true);
    setIncludeCirclesKml(false);
    setNewFolderForLayer(null);
    setNewFolderDraft("");
    setFeatureSubTab("layers");
    void clearCreatorWorkspaceDraft();
    toast.info("Cleared map draft");
  };

  // ── Derived counters ─────────────────────────────────────────────────────
  const activeStationCount = stations.filter((s) => s.enabled).length;
  const activeLayerCount = layers.filter(
    (l) => l.selected && l.enabledFor.length > 0 && l.items.some((i) => i.enabled),
  ).length;

  const filteredStations = useMemo(() => {
    const q = stationSearch.trim().toLowerCase();
    if (!q) return stations;
    return stations.filter((s) => s.name.toLowerCase().includes(q));
  }, [stations, stationSearch]);

  const tierNames = Object.keys(tierOverrides);

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:h-dvh md:flex-row">
      {/* Left Sidebar */}
      <aside className="flex w-full shrink-0 flex-col border-b border-border bg-card md:h-full md:w-[440px] md:border-b-0 md:border-r">
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h1 className="text-base font-bold tracking-tight">Map Creator</h1>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => loadGameInputRef.current?.click()}
            >
              <FolderOpen className="mr-1 h-3.5 w-3.5" />
              Load
            </Button>
            {hasWorkspaceProgress && (
              <Button
                type="button"
                size="sm"
                variant={confirmReset ? "destructive" : "ghost"}
                title="Clear current draft and start a blank map"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  if (!confirmReset) {
                    setConfirmReset(true);
                  } else {
                    handleResetWorkspace();
                  }
                }}
              >
                {confirmReset ? "Reset?" : "Reset"}
              </Button>
            )}
            <input
              ref={loadGameInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleLoadGameFile(file);
              }}
            />
            <a href="/games" className="text-muted-foreground hover:text-foreground">
              Games
            </a>
            <span className="text-muted-foreground">·</span>
            <a href="/local" className="text-muted-foreground hover:text-foreground">
              Local
            </a>
            <span className="text-muted-foreground">·</span>
            <a href="/" className="text-muted-foreground hover:text-foreground">
              Home
            </a>
          </div>
        </div>

        {/* Step Tabs */}
        <nav
          aria-label="Map creator steps"
          className="grid grid-cols-4 border-b border-border bg-background/40 text-xs font-medium"
        >
          {(
            [
              { id: "area", label: "1. Area" },
              {
                id: "stations",
                label: `2. Stops${activeStationCount ? ` (${activeStationCount})` : ""}`,
              },
              {
                id: "features",
                label: `3. Layers${activeLayerCount ? ` (${activeLayerCount})` : ""}`,
              },
              { id: "export", label: "4. Export" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setStep(tab.id);
                if (tab.id !== "area" && interactionMode === "draw-area") {
                  setInteractionMode("browse");
                }
                if (tab.id !== "stations" && interactionMode === "add-station") {
                  setInteractionMode("browse");
                }
              }}
              className={cn(
                "truncate border-b-2 px-2 py-2.5 text-center transition-colors",
                step === tab.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Step Content */}
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {/* ── STEP 1: AREA & DEFAULTS ── */}
          {step === "area" && (
            <CreatorAreaStep
              scale={scale}
              applyScalePreset={applyScalePreset}
              placeQuery={placeQuery}
              setPlaceQuery={setPlaceQuery}
              placeSearching={placeSearching}
              placeError={placeError}
              placeResults={placeResults}
              handlePlaceSearch={handlePlaceSearch}
              handlePickPlace={handlePickPlace}
              interactionMode={interactionMode}
              setInteractionMode={setInteractionMode}
              drawPoints={drawPoints}
              setDrawPoints={setDrawPoints}
              handleFinishDrawing={handleFinishDrawing}
              handleUseMapView={handleUseMapView}
              playArea={playArea}
              clearPlayArea={clearPlayArea}
              setPlayAreaAndFit={setPlayAreaAndFit}
              stations={stations}
              layers={layers}
              gameName={gameName}
              setGameName={setGameName}
              hidingRadius={hidingRadius}
              setHidingRadius={setHidingRadius}
              unit={unit}
              setUnit={setUnit}
              radarMode={radarMode}
              setRadarMode={setRadarMode}
              radarsText={radarsText}
              setRadarsText={setRadarsText}
              thermometer={thermometer}
              setThermometer={setThermometer}
              onNext={() => setStep("stations")}
            />
          )}

          {/* ── STEP 2: STATIONS (HIDING ZONES) ── */}
          {step === "stations" && (
            <CreatorStationsStep
              playArea={playArea}
              hasPlayAreaGeometry={hasPlayAreaGeometry}
              stationSource={stationSource}
              setStationSource={setStationSource}
              stationTypes={stationTypes}
              onToggleStationType={handleToggleStationType}
              customStationFilter={customStationFilter}
              setCustomStationFilter={setCustomStationFilter}
              dedupeMeters={dedupeMeters}
              setDedupeMeters={setDedupeMeters}
              preferEnglishName={preferEnglishName}
              setPreferEnglishName={setPreferEnglishName}
              showStationQuery={showStationQuery}
              setShowStationQuery={setShowStationQuery}
              stationRawQuery={stationRawQuery}
              setStationRawQuery={setStationRawQuery}
              generatedStationQuery={generatedStationQuery}
              stationBusy={stationBusy}
              stationError={stationError}
              stationSummary={stationSummary}
              handleFetchStations={handleFetchStations}
              onAbortStationFetch={() => stationAbortRef.current?.abort()}
              stations={stations}
              setStations={setStations}
              filteredStations={filteredStations}
              activeStationCount={activeStationCount}
              extraHidingZones={extraHidingZones}
              onImportStations={(imported, replace) => {
                if (replace) {
                  stationAbortRef.current?.abort();
                  stationAbortRef.current = null;
                  setStationBusy(null);
                  setExtraHidingZones([]);
                }
                setStations((prev) => (replace ? imported : [...prev, ...imported]));
                setStationSummary(
                  replace
                    ? `Loaded ${imported.length} stations from file`
                    : `Added ${imported.length} stations from file`,
                );
              }}
              onClearStations={() => {
                stationAbortRef.current?.abort();
                stationAbortRef.current = null;
                setStationBusy(null);
                setStations([]);
                setExtraHidingZones([]);
                setStationSummary(null);
              }}
              onLoadGameDefinition={handleLoadExistingGame}
              interactionMode={interactionMode}
              setInteractionMode={setInteractionMode}
              showZoneCircles={showZoneCircles}
              setShowZoneCircles={setShowZoneCircles}
              unit={unit}
              tierNames={tierNames}
              tierOverrides={tierOverrides}
              setTierOverrides={setTierOverrides}
              newTierName={newTierName}
              setNewTierName={setNewTierName}
              newTierRadius={newTierRadius}
              setNewTierRadius={setNewTierRadius}
              handleAddTier={handleAddTier}
              stationSearch={stationSearch}
              setStationSearch={setStationSearch}
              onNext={() => setStep("features")}
            />
          )}

          {/* ── STEP 3: FEATURE LAYERS (My Layers, Import File, Fetch from OSM) ── */}
          {step === "features" && (
            <>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/40 p-1">
                {(
                  [
                    ["layers", layers.length > 0 ? `My Layers (${layers.length})` : "My Layers"],
                    ["import", "Import File"],
                    ["osm", "Fetch OSM"],
                  ] as const
                ).map(([tabId, label]) => (
                  <button
                    key={tabId}
                    type="button"
                    onClick={() => setFeatureSubTab(tabId)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                      featureSubTab === tabId
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {featureSubTab === "layers" && (
                <CreatorLayersList
                  layers={layers}
                  setLayers={setLayers}
                  visibleLayerIds={visibleLayerIds}
                  setVisibleLayerIds={setVisibleLayerIds}
                  playArea={playArea}
                  playAreaGenRef={playAreaGenRef}
                  poiBufferKm={poiBufferKm}
                  preferEnglishName={preferEnglishName}
                  customEndpoint={customEndpoint}
                  simplifyPreview={simplifyPreview}
                  onSimplifyPreviewChange={setSimplifyPreview}
                  onOpenImportTab={() => setFeatureSubTab("import")}
                  onOpenOsmTab={() => setFeatureSubTab("osm")}
                />
              )}

              <div className={featureSubTab === "import" ? "" : "hidden"}>
                <CreatorImportPanel
                  existingLayerSlugs={existingLayerSlugs}
                  geometryLayerCount={layers.length}
                  onImportStations={(imported, replace) => {
                    if (replace) {
                      stationAbortRef.current?.abort();
                      stationAbortRef.current = null;
                      setStationBusy(null);
                      setExtraHidingZones([]);
                    }
                    setStations((prev) => (replace ? imported : [...prev, ...imported]));
                    setStationSummary(
                      replace
                        ? `Loaded ${imported.length} stations from file`
                        : `Added ${imported.length} stations from file`,
                    );
                  }}
                  onAddGeometryLayers={(incoming) => {
                    setLayers((prev) => [...prev, ...incoming]);
                    if (incoming[0]) {
                      setVisibleLayerIds((prev) => new Set(prev).add(incoming[0].id));
                    }
                  }}
                  onLoadGameDefinition={handleLoadExistingGame}
                  onDoneImporting={() => setFeatureSubTab("layers")}
                />
              </div>

              {featureSubTab === "osm" && (
                <CreatorOsmFetchPanel
                  playArea={playArea}
                  playAreaGenRef={playAreaGenRef}
                  poiBufferKm={poiBufferKm}
                  setPoiBufferKm={setPoiBufferKm}
                  preferEnglishName={preferEnglishName}
                  customEndpoint={customEndpoint}
                  setCustomEndpoint={setCustomEndpoint}
                  existingLayers={layers}
                  existingLayerSlugs={existingLayerSlugs}
                  onUpsertLayer={handleUpsertOsmLayer}
                />
              )}

              <Button type="button" className="w-full" onClick={() => setStep("export")}>
                Next: Review & Export →
              </Button>
            </>
          )}

          {/* ── STEP 4: REVIEW & EXPORT ── */}
          {step === "export" && (
            <CreatorExportStep
              assembled={assembled}
              activeStationCount={activeStationCount}
              extraHidingZones={extraHidingZones}
              activeLayerCount={activeLayerCount}
              fileStem={fileStem}
              customId={customId}
              setCustomId={setCustomId}
              preservedMetadata={preservedMetadata}
              setPreservedMetadata={setPreservedMetadata}
              checkingQuality={checkingQuality}
              qualityIssues={qualityIssues}
              handleDecodeAllEntities={handleDecodeAllEntities}
              handleQuickSimplifyLayer={handleQuickSimplifyLayer}
              handleQuickSingularizeLayer={handleQuickSingularizeLayer}
              launchingAction={launchingAction}
              assemblyPending={assemblyPending}
              handleTestLocally={handleTestLocally}
              handleDownloadJson={handleDownloadJson}
              handleDownloadKml={handleDownloadKml}
              handleDownloadSingleKmlFolder={handleDownloadSingleKmlFolder}
              handleImportToSearchlight={handleImportToSearchlight}
              maxKmlLayers={maxKmlLayers}
              setMaxKmlLayers={setMaxKmlLayers}
              includePlayAreaKml={includePlayAreaKml}
              setIncludePlayAreaKml={setIncludePlayAreaKml}
              includeCirclesKml={includeCirclesKml}
              setIncludeCirclesKml={setIncludeCirclesKml}
              kmlPlan={kmlPlan}
              showKmlGrouping={showKmlGrouping}
              setShowKmlGrouping={setShowKmlGrouping}
              layers={layers}
              setLayers={setLayers}
              newFolderForLayer={newFolderForLayer}
              setNewFolderForLayer={setNewFolderForLayer}
              newFolderDraft={newFolderDraft}
              setNewFolderDraft={setNewFolderDraft}
            />
          )}
        </div>
      </aside>

      <CreatorMapPane
        interactionMode={interactionMode}
        setInteractionMode={setInteractionMode}
        drawPoints={drawPoints}
        setDrawPoints={setDrawPoints}
        handleFinishDrawing={handleFinishDrawing}
        simplifyPreview={simplifyPreview}
        fitTarget={fitTarget}
        mapRef={mapRef}
        handleMapClick={handleMapClick}
        playArea={playArea}
        playAreaVersion={playAreaVersion}
        previewCircles={previewCircles}
        hidingRadius={hidingRadius}
        unit={unit}
        extraHidingZones={extraHidingZones}
        tierOverrides={tierOverrides}
        stations={stations}
        setStations={setStations}
        layers={layers}
        setLayers={setLayers}
        visibleLayerIds={visibleLayerIds}
      />
    </div>
  );
}
