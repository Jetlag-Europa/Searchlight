import "leaflet/dist/leaflet.css";

import {
    type Bounds,
    type DistanceUnit,
    type FeatureEnabledFor,
    formatGameDefinitionJson,
    type GameDefinition,
    type HidingZoneFeature,
    type PlayAreaFeatureCollection,
    resolveGameDefinitionId,
    validateGameDefinition,
} from "@searchlight/shared";
import * as turf from "@turf/turf";
import * as L from "leaflet";
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronRight,
    Download,
    Eye,
    EyeOff,
    Layers,
    MapPin,
    PenTool,
    Play,
    Plus,
    RefreshCw,
    Search,
    Sparkles,
    Trash2,
    UploadCloud,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    CircleMarker,
    GeoJSON,
    MapContainer,
    Polygon as LeafletPolygon,
    Polyline,
    ScaleControl,
    TileLayer,
    Tooltip,
    useMap,
    useMapEvents,
} from "react-leaflet";
import { toast } from "react-toastify";

import { CreatorGeometryPanel } from "@/components/CreatorGeometryPanel";
import { CreatorImportPanel } from "@/components/CreatorImportPanel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
    type CompiledGame,
    compileGameDefinition,
} from "@/game-definition/compile";
import {
    checkGameQuality,
    formatFileSize,
    type QualityIssue,
} from "@/game-definition/inspect";
import { CARTO_API_KEY, WORLD_BOUNDS } from "@/lib/basemap";
import {
    assembleGameDefinition,
    type CreatorGeometryLayer,
    type CreatorLayerState,
    layerSlugOf,
    type PreservedGameMetadata,
    validateCreatorLayers,
} from "@/lib/creator/assemble";
import { saveCreatorImportHandoff } from "@/lib/creator/handoff";
import {
    type GeometryFamily,
    sumFeatureVertices,
} from "@/lib/creator/importFile";
import { buildGameKml } from "@/lib/creator/kml";
import {
    buildValidatedDrawnPlayArea,
    type CreatorPointItem,
    fetchPoiLayersFromOsm,
    fetchStationsFromOsm,
    type PlaceSearchResult,
    rectanglePlayArea,
    searchPlaces,
    tryPlayAreaBounds,
    validateCustomOsmFilter,
} from "@/lib/creator/overpass";
import {
    CREATOR_POI_CATALOG,
    CUSTOM_LAYER_COLORS,
    type GameScale,
    getStationPreset,
    SCALE_PRESETS,
    STATION_PRESETS,
    type StationPresetId,
} from "@/lib/creator/presets";
import {
    createLocalSession,
    isLocalStoragePersistent,
    saveLocalGame,
    writeLastLocalSessionId,
} from "@/lib/localStore";
import { cn } from "@/lib/utils";
import { hidingZoneCircles } from "@/maps/geo-utils/hidingZones";

type CreatorStep = "area" | "stations" | "features" | "export";
type FeatureSubTab = "pois" | "geometry" | "import";
type MapInteractionMode = "browse" | "draw-area" | "add-station";

const DEFAULT_SCALE: GameScale = "medium";

function createInitialLayers(scale: GameScale): CreatorLayerState[] {
    const defaultIds = new Set(SCALE_PRESETS[scale].defaultPoiIds);
    return CREATOR_POI_CATALOG.map((cat) => ({
        id: cat.id,
        name: cat.name,
        osmFilter: cat.osmFilter,
        enabledFor: [...cat.defaultEnabledFor],
        color: cat.color,
        selected: defaultIds.has(cat.id),
        notableOnly: Boolean(cat.noisyInOsm),
        items: [],
        fetched: false,
    }));
}

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

function MapController({
    fitBoundsTarget,
    mapRef,
    interactionMode,
    onMapClick,
}: {
    fitBoundsTarget: { bounds: Bounds; seq: number } | null;
    mapRef: React.MutableRefObject<L.Map | null>;
    interactionMode: MapInteractionMode;
    onMapClick: (lat: number, lng: number) => void;
}) {
    const map = useMap();

    useEffect(() => {
        mapRef.current = map;
        return () => {
            if (mapRef.current === map) mapRef.current = null;
        };
    }, [map, mapRef]);

    useEffect(() => {
        if (!fitBoundsTarget) return;
        const [west, south, east, north] = fitBoundsTarget.bounds;
        map.fitBounds(
            [
                [south, west],
                [north, east],
            ],
            { padding: [24, 24], maxZoom: 14 },
        );
    }, [map, fitBoundsTarget]);

    useEffect(() => {
        const el = map.getContainer();
        el.style.cursor =
            interactionMode === "browse" ? "" : "crosshair";
        return () => {
            el.style.cursor = "";
        };
    }, [map, interactionMode]);

    useMapEvents({
        click(e) {
            if (interactionMode !== "browse") {
                onMapClick(e.latlng.lat, e.latlng.lng);
            }
        },
    });

    return null;
}

export function GameCreator() {
    const [step, setStep] = useState<CreatorStep>("area");
    const [interactionMode, setInteractionMode] =
        useState<MapInteractionMode>("browse");

    // ── Step 1: Area & Defaults ──────────────────────────────────────────────
    const [gameName, setGameName] = useState("");
    const [customId, setCustomId] = useState("");
    const [scale, setScale] = useState<GameScale>(DEFAULT_SCALE);
    const [unit, setUnit] = useState<DistanceUnit>(
        SCALE_PRESETS[DEFAULT_SCALE].unit,
    );
    const [hidingRadius, setHidingRadius] = useState<number>(
        SCALE_PRESETS[DEFAULT_SCALE].hidingRadius,
    );
    const [radarMode, setRadarMode] = useState<"off" | "default" | "custom">(
        "custom",
    );
    const [radarsText, setRadarsText] = useState(
        SCALE_PRESETS[DEFAULT_SCALE].radars.join(", "),
    );
    const [thermometer, setThermometer] = useState(
        SCALE_PRESETS[DEFAULT_SCALE].thermometer,
    );
    const [preservedMetadata, setPreservedMetadata] =
        useState<PreservedGameMetadata | null>(null);
    const [extraHidingZones, setExtraHidingZones] = useState<
        HidingZoneFeature[]
    >([]);

    const [playArea, setPlayArea] = useState<PlayAreaFeatureCollection | null>(
        null,
    );
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
    const [stationPreset, setStationPreset] = useState<StationPresetId>(
        SCALE_PRESETS[DEFAULT_SCALE].stationPreset,
    );
    const [customStationFilter, setCustomStationFilter] = useState(
        '["railway"="station"]',
    );
    const [dedupeMeters, setDedupeMeters] = useState(250);
    const [preferEnglishName, setPreferEnglishName] = useState(false);
    const [stations, setStations] = useState<CreatorPointItem[]>([]);
    const [stationSearch, setStationSearch] = useState("");
    const [stationSummary, setStationSummary] = useState<string | null>(null);
    const [stationBusy, setStationBusy] = useState<string | null>(null);
    const [stationError, setStationError] = useState<string | null>(null);
    const [showZoneCircles, setShowZoneCircles] = useState(true);
    const [tierOverrides, setTierOverrides] = useState<Record<string, number>>(
        {},
    );
    const [newTierName, setNewTierName] = useState("");
    const [newTierRadius, setNewTierRadius] = useState("600");

    // ── Step 3: Feature Layers (POIs, Regions/Lines, Imported Files) ─────────
    const [featureSubTab, setFeatureSubTab] = useState<FeatureSubTab>("pois");
    const [layers, setLayers] = useState<CreatorLayerState[]>(() =>
        createInitialLayers(DEFAULT_SCALE),
    );
    const [geometryLayers, setGeometryLayers] = useState<
        CreatorGeometryLayer[]
    >([]);
    const [poiBufferKm, setPoiBufferKm] = useState<number>(
        SCALE_PRESETS[DEFAULT_SCALE].poiBufferKm,
    );
    const [visibleLayerIds, setVisibleLayerIds] = useState<Set<string>>(
        () => new Set(),
    );
    const [expandedLayerId, setExpandedLayerId] = useState<string | null>(null);
    const [poiBusy, setPoiBusy] = useState<string | null>(null);
    const [poiError, setPoiError] = useState<string | null>(null);
    const [customEndpoint, setCustomEndpoint] = useState("");
    const [showAdvancedOsm, setShowAdvancedOsm] = useState(false);

    // Add custom POI layer form
    const [customLayerName, setCustomLayerName] = useState("");
    const [customLayerFilter, setCustomLayerFilter] = useState("");
    const [customLayerError, setCustomLayerError] = useState<string | null>(
        null,
    );

    // ── Step 4: Review & Export ──────────────────────────────────────────────
    const [qualityIssues, setQualityIssues] = useState<QualityIssue[]>([]);
    const [checkingQuality, setCheckingQuality] = useState(false);
    const [combinePoisKml, setCombinePoisKml] = useState(true);
    const [includeCirclesKml, setIncludeCirclesKml] = useState(false);
    const [launchingAction, setLaunchingAction] = useState<string | null>(null);

    const mapRef = useRef<L.Map | null>(null);
    const stationAbortRef = useRef<AbortController | null>(null);
    const poiAbortRef = useRef<AbortController | null>(null);
    const playAreaGenRef = useRef(0);
    const customStationCounterRef = useRef(1);

    const invalidateFetchedAreaData = useCallback(() => {
        playAreaGenRef.current += 1;
        stationAbortRef.current?.abort();
        stationAbortRef.current = null;
        poiAbortRef.current?.abort();
        poiAbortRef.current = null;
        setStationBusy(null);
        setPoiBusy(null);
        setStationError(null);
        setPoiError(null);
        setStationSummary(null);
        // Keep user-placed and file-imported stations; only clear OSM-fetched stations.
        setStations((prev) => prev.filter((s) => s.custom));
        setLayers((prev) =>
            prev.map((layer) => ({ ...layer, items: [], fetched: false })),
        );
        // Drop OSM-fetched region/line layers from the old area; keep user-imported file layers.
        setGeometryLayers((prev) =>
            prev.filter((l) => !l.sourceLabel.startsWith("OSM ")),
        );
        setVisibleLayerIds(new Set());
        setExpandedLayerId(null);
    }, []);

    const applyScalePreset = (nextScale: GameScale) => {
        const preset = SCALE_PRESETS[nextScale];
        setScale(nextScale);
        setUnit(preset.unit);
        setHidingRadius(preset.hidingRadius);
        setRadarMode("custom");
        setRadarsText(preset.radars.join(", "));
        setThermometer(preset.thermometer);
        setStationPreset(preset.stationPreset);
        setPoiBufferKm(preset.poiBufferKm);
        const defaultIds = new Set(preset.defaultPoiIds);
        setLayers((prev) =>
            prev.map((layer) =>
                layer.custom
                    ? layer
                    : { ...layer, selected: defaultIds.has(layer.id) },
            ),
        );
    };

    const setPlayAreaAndFit = useCallback(
        (next: PlayAreaFeatureCollection) => {
            invalidateFetchedAreaData();
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
                err instanceof Error
                    ? err.message
                    : "Place search failed. Check your connection.",
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
        const bounds: Bounds = [
            b.getWest(),
            b.getSouth(),
            b.getEast(),
            b.getNorth(),
        ];
        if (bounds[2] - bounds[0] > 40 || bounds[3] - bounds[1] > 30) {
            toast.warn(
                "Zoom in closer before using the map view — a continent-sized box will time out Overpass.",
            );
            return;
        }
        setPlayAreaAndFit(
            rectanglePlayArea(bounds, gameName.trim() || "Play Area"),
        );
        setInteractionMode("browse");
        setDrawPoints([]);
    };

    const handleFinishDrawing = () => {
        const result = buildValidatedDrawnPlayArea(
            drawPoints,
            gameName.trim() || "Play Area",
        );
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

    // ── Fetch stations from OSM ──────────────────────────────────────────────
    const handleFetchStations = async () => {
        if (!hasPlayAreaGeometry || !playArea) {
            setStationError("Set a play area in Step 1 first.");
            return;
        }
        let filters: readonly string[];
        if (stationPreset === "custom") {
            const check = validateCustomOsmFilter(customStationFilter);
            if (!check.ok) {
                setStationError(check.error);
                return;
            }
            filters = [check.filter];
        } else {
            filters = getStationPreset(stationPreset).osmFilters;
        }

        stationAbortRef.current?.abort();
        const controller = new AbortController();
        stationAbortRef.current = controller;
        const areaGen = playAreaGenRef.current;
        setStationError(null);
        setStationBusy("Querying OpenStreetMap for stations…");

        try {
            const result = await fetchStationsFromOsm({
                filters,
                playArea,
                dedupeMeters,
                preferEnglishName,
                customEndpoint: customEndpoint.trim() || undefined,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (playAreaGenRef.current === areaGen) setStationBusy(msg);
                },
            });
            if (playAreaGenRef.current !== areaGen) return;
            setStations((prev) => {
                // Keep any manually placed custom stations when re-fetching OSM.
                const manual = prev.filter((s) => s.custom);
                return [...manual, ...result.stations];
            });
            const parts = [`Found ${result.stations.length} stations`];
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
                    : "Failed to fetch stations from OpenStreetMap.",
            );
        } finally {
            if (stationAbortRef.current === controller) {
                stationAbortRef.current = null;
                setStationBusy(null);
            }
        }
    };

    // ── Fetch POIs from OSM (single batched query) ───────────────────────────
    const handleFetchPois = async () => {
        if (!hasPlayAreaGeometry || !playArea) {
            setPoiError("Set a play area in Step 1 first.");
            return;
        }
        const selectedLayers = layers.filter((l) => l.selected);
        if (selectedLayers.length === 0) {
            setPoiError("Select at least one feature layer to fetch.");
            return;
        }

        poiAbortRef.current?.abort();
        const controller = new AbortController();
        poiAbortRef.current = controller;
        const areaGen = playAreaGenRef.current;
        setPoiError(null);
        setPoiBusy("Querying OpenStreetMap for feature layers…");

        try {
            const result = await fetchPoiLayersFromOsm({
                layers: selectedLayers.map((l) => ({
                    id: l.id,
                    name: l.name,
                    osmFilter: l.osmFilter,
                    notableOnly: l.notableOnly,
                })),
                playArea,
                bufferKm: poiBufferKm,
                preferEnglishName,
                customEndpoint: customEndpoint.trim() || undefined,
                signal: controller.signal,
                onStatus: (msg) => {
                    if (playAreaGenRef.current === areaGen) setPoiBusy(msg);
                },
            });
            if (playAreaGenRef.current !== areaGen) return;
            setLayers((prev) =>
                prev.map((layer) =>
                    layer.id in result.byLayerId
                        ? {
                              ...layer,
                              items: result.byLayerId[layer.id],
                              fetched: true,
                          }
                        : layer,
                ),
            );
            // Automatically show the first non-empty fetched layer on the map.
            const firstNonEmpty = selectedLayers.find(
                (l) => (result.byLayerId[l.id]?.length ?? 0) > 0,
            );
            if (firstNonEmpty) {
                setVisibleLayerIds((prev) => {
                    const next = new Set(prev);
                    next.add(firstNonEmpty.id);
                    return next;
                });
            }
            const totalPins = Object.values(result.byLayerId).reduce(
                (sum, list) => sum + list.length,
                0,
            );
            toast.success(
                `Fetched ${totalPins} places across ${selectedLayers.length} layer${selectedLayers.length === 1 ? "" : "s"}`,
            );
        } catch (err) {
            if (
                playAreaGenRef.current !== areaGen ||
                (err instanceof DOMException && err.name === "AbortError")
            ) {
                return;
            }
            setPoiError(
                err instanceof Error
                    ? err.message
                    : "Failed to fetch features from OpenStreetMap.",
            );
        } finally {
            if (poiAbortRef.current === controller) {
                poiAbortRef.current = null;
                setPoiBusy(null);
            }
        }
    };

    const handleAddCustomLayer = (e: React.FormEvent) => {
        e.preventDefault();
        setCustomLayerError(null);
        const name = customLayerName.trim();
        if (!name) {
            setCustomLayerError("Enter a singular layer name (e.g. Castle).");
            return;
        }
        const slug = layerSlugOf(name);
        if (!slug) {
            setCustomLayerError(
                "Layer name must include at least one ASCII letter or digit (a–z, 0–9).",
            );
            return;
        }
        const collision = [...layers, ...geometryLayers].find(
            (l) => layerSlugOf(l.name) === slug,
        );
        if (collision) {
            setCustomLayerError(
                `A layer with the same ID already exists ("${collision.name}").`,
            );
            return;
        }
        const filterCheck = validateCustomOsmFilter(customLayerFilter);
        if (!filterCheck.ok) {
            setCustomLayerError(filterCheck.error);
            return;
        }
        const id = `custom-${Date.now()}`;
        const color =
            CUSTOM_LAYER_COLORS[layers.length % CUSTOM_LAYER_COLORS.length];
        setLayers((prev) => [
            ...prev,
            {
                id,
                name,
                osmFilter: filterCheck.filter,
                enabledFor: ["matching", "measuring"],
                color,
                selected: true,
                notableOnly: false,
                custom: true,
                items: [],
                fetched: false,
            },
        ]);
        setCustomLayerName("");
        setCustomLayerFilter("");
    };

    const existingLayerSlugs = useMemo(() => {
        const set = new Set<string>();
        for (const l of layers) {
            if (!l.selected) continue;
            const s = layerSlugOf(l.name);
            if (s) set.add(s);
        }
        for (const l of geometryLayers) {
            const s = layerSlugOf(l.name);
            if (s) set.add(s);
        }
        return set;
    }, [layers, geometryLayers]);

    const handleLoadExistingGame = useCallback((def: GameDefinition) => {
        playAreaGenRef.current += 1;
        stationAbortRef.current?.abort();
        stationAbortRef.current = null;
        poiAbortRef.current?.abort();
        poiAbortRef.current = null;
        setStationBusy(null);
        setPoiBusy(null);
        setStationError(null);
        setPoiError(null);

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
                originalProperties: f.properties
                    ? { ...f.properties }
                    : undefined,
            });
        });
        setStations(loadedStations);
        setExtraHidingZones(loadedExtraZones);
        setStationSummary(
            loadedExtraZones.length > 0
                ? `Loaded ${loadedStations.length} point station(s) + ${loadedExtraZones.length} polygon hiding zone(s) from file`
                : `Loaded ${loadedStations.length} stations from file`,
        );

        // Keep standard OSM catalog deselected so it doesn't collide with loaded layers.
        setLayers((prev) =>
            prev.map((l) => ({
                ...l,
                selected: false,
                items: [],
                fetched: false,
            })),
        );

        const loadedGeoLayers: CreatorGeometryLayer[] = (
            def.features ?? []
        ).map((feat, idx) => {
            const firstType = feat.data.features[0]?.geometry.type;
            const fam: GeometryFamily =
                firstType === "Point"
                    ? "points"
                    : firstType === "LineString" ||
                        firstType === "MultiLineString"
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
                originalProperties: f.properties
                    ? { ...f.properties }
                    : undefined,
            }));
            return {
                id: `loaded-layer-${Date.now()}-${idx}`,
                name: feat.name,
                family: fam,
                enabledFor: [...feat.enabledFor],
                color: CUSTOM_LAYER_COLORS[idx % CUSTOM_LAYER_COLORS.length],
                selected: true,
                noOverlaps: feat.noOverlaps === true,
                sourceLabel: "Loaded .game.json",
                items,
                vertexCount: sumFeatureVertices(items),
            };
        });
        setGeometryLayers(loadedGeoLayers);
        setVisibleLayerIds(
            new Set(loadedGeoLayers.slice(0, 1).map((l) => l.id)),
        );
    }, []);

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
    }>(() => {
        if (!playArea) {
            return {
                definition: null,
                compiled: null,
                validationErrors: ["Set a play area in Step 1."],
                jsonSize: 0,
            };
        }
        const activeStations = stations.filter((s) => s.enabled);
        if (activeStations.length === 0 && extraHidingZones.length === 0) {
            return {
                definition: null,
                compiled: null,
                validationErrors: [
                    "Add or fetch at least one enabled station in Step 2.",
                ],
                jsonSize: 0,
            };
        }

        const layerNameErrors = validateCreatorLayers([
            ...layers,
            ...geometryLayers,
        ]);
        if (layerNameErrors.length > 0) {
            return {
                definition: null,
                compiled: null,
                validationErrors: layerNameErrors,
                jsonSize: 0,
            };
        }

        const parsedRadars =
            radarMode === "custom" ? parseRadarsText(radarsText) : [];
        const radarsValue: boolean | number[] =
            radarMode === "off"
                ? false
                : radarMode === "custom" && parsedRadars.length > 0
                  ? parsedRadars
                  : true;
        const definition = assembleGameDefinition({
            name: gameName,
            id: customId,
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
            geometryLayers,
        });

        const validation = validateGameDefinition(definition);
        if (!validation.valid) {
            return {
                definition,
                compiled: null,
                validationErrors: validation.errors.map(
                    (e) =>
                        `${e.path && e.path !== "/" ? `${e.path}: ` : ""}${e.message}`,
                ),
                jsonSize: 0,
            };
        }

        try {
            const compiled = compileGameDefinition(definition);
            const compactSize = new TextEncoder().encode(
                JSON.stringify(definition),
            ).byteLength;
            return {
                definition,
                compiled,
                validationErrors: [],
                jsonSize: compactSize,
            };
        } catch (err) {
            return {
                definition,
                compiled: null,
                validationErrors: [
                    err instanceof Error
                        ? err.message
                        : "Failed to compile game definition",
                ],
                jsonSize: 0,
            };
        }
    }, [
        playArea,
        stations,
        extraHidingZones,
        preservedMetadata,
        gameName,
        customId,
        scale,
        unit,
        hidingRadius,
        tierOverrides,
        radarMode,
        radarsText,
        thermometer,
        layers,
        geometryLayers,
    ]);

    // Run check-game.mjs quality checks when viewing the Export step.
    useEffect(() => {
        if (step !== "export" || !assembled.definition || !assembled.compiled) {
            setQualityIssues([]);
            return;
        }
        let cancelled = false;
        setCheckingQuality(true);
        void checkGameQuality(assembled.definition)
            .then((issues) => {
                if (!cancelled) setQualityIssues(issues);
            })
            .catch(() => {
                if (!cancelled) setQualityIssues([]);
            })
            .finally(() => {
                if (!cancelled) setCheckingQuality(false);
            });
        return () => {
            cancelled = true;
        };
    }, [step, assembled.definition, assembled.compiled]);

    // Preview hiding zone circles when enabled on map.
    const previewCircles = useMemo(() => {
        if (!showZoneCircles || !assembled.compiled) return null;
        return turf.featureCollection(hidingZoneCircles(assembled.compiled));
    }, [showZoneCircles, assembled.compiled]);

    const layerColorsMap = useMemo(() => {
        const map = Object.create(null) as Record<string, string>;
        for (const l of layers) map[l.name] = l.color;
        for (const l of geometryLayers) map[l.name] = l.color;
        return map;
    }, [layers, geometryLayers]);

    const kmlPreview = useMemo(() => {
        if (step !== "export" || !assembled.definition || !assembled.compiled) {
            return null;
        }
        try {
            return buildGameKml(assembled.definition, {
                combinePoisForMyMaps: combinePoisKml,
                includeHidingZoneCircles: includeCirclesKml,
                layerColors: layerColorsMap,
            });
        } catch {
            return null;
        }
    }, [
        step,
        assembled.definition,
        assembled.compiled,
        combinePoisKml,
        includeCirclesKml,
        layerColorsMap,
    ]);

    // ── Export & handoff actions ─────────────────────────────────────────────
    const fileStem = assembled.definition
        ? resolveGameDefinitionId(assembled.definition)
        : "custom-game";

    const handleDownloadJson = () => {
        if (!assembled.definition) return;
        downloadBlob(
            `${fileStem}.game.json`,
            formatGameDefinitionJson(assembled.definition),
            "application/json",
        );
        toast.success(`Downloaded ${fileStem}.game.json`);
    };

    const handleDownloadKml = () => {
        if (!kmlPreview) return;
        downloadBlob(
            `${fileStem}.kml`,
            kmlPreview.kml,
            "application/vnd.google-earth.kml+xml",
        );
        toast.success(`Downloaded ${fileStem}.kml`);
    };

    const handleTestLocally = async () => {
        if (!assembled.definition || !assembled.compiled) return;
        // Open a new tab synchronously on click so testing doesn't wipe the draft.
        const popup = window.open("about:blank", "_blank");
        if (popup) popup.opener = null;
        setLaunchingAction("local");
        try {
            const persistent = await isLocalStoragePersistent();
            if (!persistent) {
                popup?.close();
                toast.error(
                    "Browser storage (IndexedDB) is unavailable in this window — download the .game.json file and open it on /local instead.",
                );
                return;
            }
            const saved = await saveLocalGame(assembled.definition, {
                kind: "file",
                label: "Map Creator",
            });
            const session = await createLocalSession(
                saved,
                `${assembled.definition.name} (Test)`,
            );
            writeLastLocalSessionId(session.id);
            if (popup && !popup.closed) {
                popup.location.href = "/local";
            } else {
                window.location.href = "/local";
            }
        } catch (err) {
            popup?.close();
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Couldn't open local session.",
            );
        } finally {
            setLaunchingAction(null);
        }
    };

    const handleImportToSearchlight = async () => {
        if (!assembled.definition || !assembled.compiled) return;
        const popup = window.open("about:blank", "_blank");
        if (popup) popup.opener = null;
        setLaunchingAction("import");
        try {
            const draftId = await saveCreatorImportHandoff(
                `${fileStem}.game.json`,
                assembled.definition,
            );
            if (!draftId) {
                popup?.close();
                toast.error(
                    "Browser storage is unavailable — download the .game.json file and upload it on /games/import instead.",
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

    // ── Derived counters ─────────────────────────────────────────────────────
    const activeStationCount = stations.filter((s) => s.enabled).length;
    const activeLayerCount =
        layers.filter(
            (l) =>
                l.selected &&
                l.enabledFor.length > 0 &&
                l.items.some((i) => i.enabled),
        ).length +
        geometryLayers.filter(
            (l) =>
                l.selected &&
                l.enabledFor.length > 0 &&
                l.items.some((i) => i.enabled),
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
                        <h1 className="text-base font-bold tracking-tight">
                            Map Creator
                        </h1>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <a
                            href="/local"
                            className="text-muted-foreground hover:text-foreground"
                        >
                            Local Play
                        </a>
                        <span className="text-muted-foreground">·</span>
                        <a
                            href="/"
                            className="text-muted-foreground hover:text-foreground"
                        >
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
                                label: `3. POIs${activeLayerCount ? ` (${activeLayerCount})` : ""}`,
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
                        <>
                            <section className="space-y-2">
                                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                    Quick-start preset
                                </Label>
                                <div className="grid grid-cols-3 gap-2">
                                    {(["small", "medium", "large"] as const).map(
                                        (id) => {
                                            const p = SCALE_PRESETS[id];
                                            return (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    onClick={() =>
                                                        applyScalePreset(id)
                                                    }
                                                    className={cn(
                                                        "rounded-lg border p-2.5 text-left transition-colors",
                                                        scale === id
                                                            ? "border-primary bg-primary/10"
                                                            : "border-border bg-background/40 hover:bg-accent/50",
                                                    )}
                                                >
                                                    <div className="text-sm font-semibold">
                                                        {p.label}
                                                    </div>
                                                    <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                                                        {p.description}
                                                    </div>
                                                </button>
                                            );
                                        },
                                    )}
                                </div>
                            </section>

                            <section className="space-y-3">
                                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                    Play area
                                </Label>
                                <form
                                    className="flex gap-2"
                                    onSubmit={(e) => void handlePlaceSearch(e)}
                                >
                                    <Input
                                        placeholder="Search city or region (e.g. Zurich, Paris)…"
                                        value={placeQuery}
                                        onChange={(e) =>
                                            setPlaceQuery(e.target.value)
                                        }
                                        disabled={placeSearching}
                                    />
                                    <Button
                                        type="submit"
                                        size="sm"
                                        disabled={
                                            placeSearching || !placeQuery.trim()
                                        }
                                    >
                                        <Search className="h-4 w-4" />
                                    </Button>
                                </form>

                                {placeError && (
                                    <p className="text-xs text-destructive">
                                        {placeError}
                                    </p>
                                )}

                                {placeResults.length > 0 && (
                                    <div className="divide-y divide-border rounded-lg border border-border bg-background/60">
                                        {placeResults.map((place) => (
                                            <button
                                                key={place.id}
                                                type="button"
                                                onClick={() =>
                                                    handlePickPlace(place)
                                                }
                                                className="flex w-full flex-col px-3 py-2 text-left text-xs transition-colors hover:bg-accent"
                                            >
                                                <span className="font-medium text-foreground">
                                                    {place.name}
                                                </span>
                                                <span className="truncate text-muted-foreground">
                                                    {place.displayName}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant={
                                            interactionMode === "draw-area"
                                                ? "default"
                                                : "outline"
                                        }
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
                                        {interactionMode === "draw-area"
                                            ? "Cancel drawing"
                                            : "Draw polygon"}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        onClick={handleUseMapView}
                                    >
                                        Use current map view
                                    </Button>
                                    {playArea && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={clearPlayArea}
                                        >
                                            Clear
                                        </Button>
                                    )}
                                </div>

                                {interactionMode === "draw-area" && (
                                    <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">
                                        <p className="font-medium">
                                            Click on the map to place polygon
                                            corners ({drawPoints.length} placed).
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
                                                disabled={
                                                    drawPoints.length === 0
                                                }
                                                onClick={() =>
                                                    setDrawPoints((p) =>
                                                        p.slice(0, -1),
                                                    )
                                                }
                                            >
                                                Undo point
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                {playArea && (
                                    <p className="text-xs text-emerald-500">
                                        Play area set (
                                        {playArea.features[0]?.properties
                                            ?.name || "Custom polygon"}
                                        ).
                                    </p>
                                )}
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
                                    <Input
                                        id="creator-game-name"
                                        maxLength={120}
                                        placeholder="e.g. Zurich Casual"
                                        value={gameName}
                                        onChange={(e) =>
                                            setGameName(e.target.value)
                                        }
                                    />
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="creator-radius" className="text-xs">
                                            Hiding zone radius
                                        </Label>
                                        <Input
                                            id="creator-radius"
                                            type="number"
                                            min={1}
                                            step="any"
                                            value={hidingRadius}
                                            onChange={(e) =>
                                                setHidingRadius(
                                                    Number(e.target.value) || 0,
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="creator-unit" className="text-xs">
                                            Distance unit
                                        </Label>
                                        <select
                                            id="creator-unit"
                                            value={unit}
                                            onChange={(e) =>
                                                setUnit(
                                                    e.target
                                                        .value as DistanceUnit,
                                                )
                                            }
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                        >
                                            <option value="meters">
                                                Meters
                                            </option>
                                            <option value="kilometers">
                                                Kilometers
                                            </option>
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
                                                setRadarMode(
                                                    v === true
                                                        ? radarsText.trim()
                                                            ? "custom"
                                                            : "default"
                                                        : "off",
                                                )
                                            }
                                        />
                                        <label
                                            htmlFor="creator-radars"
                                            className="cursor-pointer text-sm"
                                        >
                                            Enable Radar questions
                                        </label>
                                    </div>
                                    {radarMode !== "off" && (
                                        <div className="space-y-1 pl-6">
                                            <Label
                                                htmlFor="creator-radar-presets"
                                                className="text-xs text-muted-foreground"
                                            >
                                                Quick-pick radii ({unit}, comma-separated; leave blank for default)
                                            </Label>
                                            <Input
                                                id="creator-radar-presets"
                                                value={
                                                    radarMode === "custom"
                                                        ? radarsText
                                                        : ""
                                                }
                                                onChange={(e) => {
                                                    const val = e.target.value;
                                                    setRadarsText(val);
                                                    setRadarMode(
                                                        val.trim()
                                                            ? "custom"
                                                            : "default",
                                                    );
                                                }}
                                                placeholder="Game default (or e.g. 250, 400, 800, 1500)"
                                            />
                                        </div>
                                    )}
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            id="creator-thermometer"
                                            checked={thermometer}
                                            onCheckedChange={(v) =>
                                                setThermometer(v === true)
                                            }
                                        />
                                        <label
                                            htmlFor="creator-thermometer"
                                            className="cursor-pointer text-sm"
                                        >
                                            Enable Thermometer questions
                                        </label>
                                    </div>
                                </div>
                            </section>

                            <Button
                                type="button"
                                className="w-full"
                                disabled={!playArea}
                                onClick={() => setStep("stations")}
                            >
                                Next: Stations →
                            </Button>
                        </>
                    )}

                    {/* ── STEP 2: STATIONS (HIDING ZONES) ── */}
                    {step === "stations" && (
                        <>
                            {!playArea && (
                                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                                    Set a play area in Step 1 before fetching
                                    stations.
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
                                        onChange={(e) =>
                                            setStationPreset(
                                                e.target
                                                    .value as StationPresetId,
                                            )
                                        }
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
                                        <Label
                                            htmlFor="creator-custom-station-filter"
                                            className="text-xs"
                                        >
                                            Custom OSM tag filter
                                        </Label>
                                        <Input
                                            id="creator-custom-station-filter"
                                            value={customStationFilter}
                                            onChange={(e) =>
                                                setCustomStationFilter(
                                                    e.target.value,
                                                )
                                            }
                                            placeholder='["amenity"="ferry_terminal"]'
                                            className="font-mono text-xs"
                                        />
                                    </div>
                                )}

                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <Label
                                            htmlFor="creator-dedupe"
                                            className="text-xs text-muted-foreground"
                                        >
                                            Merge same-name within (m)
                                        </Label>
                                        <Input
                                            id="creator-dedupe"
                                            type="number"
                                            min={0}
                                            max={2000}
                                            value={dedupeMeters}
                                            onChange={(e) =>
                                                setDedupeMeters(
                                                    Math.max(
                                                        0,
                                                        Number(e.target.value) ||
                                                            0,
                                                    ),
                                                )
                                            }
                                        />
                                    </div>
                                    <div className="flex items-end pb-2">
                                        <div className="flex items-center gap-2">
                                            <Checkbox
                                                id="creator-en-names"
                                                checked={preferEnglishName}
                                                onCheckedChange={(v) =>
                                                    setPreferEnglishName(
                                                        v === true,
                                                    )
                                                }
                                            />
                                            <label
                                                htmlFor="creator-en-names"
                                                className="cursor-pointer text-xs"
                                            >
                                                Prefer English names
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex gap-2">
                                    <Button
                                        type="button"
                                        className="flex-1"
                                        disabled={
                                            !hasPlayAreaGeometry ||
                                            Boolean(stationBusy)
                                        }
                                        onClick={() =>
                                            void handleFetchStations()
                                        }
                                    >
                                        <RefreshCw
                                            className={cn(
                                                "mr-1.5 h-4 w-4",
                                                stationBusy && "animate-spin",
                                            )}
                                        />
                                        {stationBusy
                                            ? "Fetching…"
                                            : "Fetch stations from OSM"}
                                    </Button>
                                    {stationBusy && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() =>
                                                stationAbortRef.current?.abort()
                                            }
                                        >
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                {stationBusy && (
                                    <p className="text-xs text-muted-foreground">
                                        {stationBusy}
                                    </p>
                                )}
                                {stationError && (
                                    <p className="text-xs text-destructive">
                                        {stationError}
                                    </p>
                                )}
                                {stationSummary && !stationBusy && (
                                    <p className="text-xs text-emerald-500">
                                        {stationSummary}
                                    </p>
                                )}
                            </section>

                            <Separator />

                            {/* Map curation & tiers */}
                            <section className="space-y-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant={
                                            interactionMode === "add-station"
                                                ? "default"
                                                : "outline"
                                        }
                                        onClick={() =>
                                            setInteractionMode((m) =>
                                                m === "add-station"
                                                    ? "browse"
                                                    : "add-station",
                                            )
                                        }
                                    >
                                        <MapPin className="mr-1.5 h-3.5 w-3.5" />
                                        {interactionMode === "add-station"
                                            ? "Done adding stops"
                                            : "Click map to add stop"}
                                    </Button>
                                    <div className="flex items-center gap-1.5 text-xs">
                                        <Checkbox
                                            id="creator-show-circles"
                                            checked={showZoneCircles}
                                            onCheckedChange={(v) =>
                                                setShowZoneCircles(v === true)
                                            }
                                        />
                                        <label
                                            htmlFor="creator-show-circles"
                                            className="cursor-pointer"
                                        >
                                            Show zone circles
                                        </label>
                                    </div>
                                </div>

                                {/* Optional radius tiers */}
                                <div className="space-y-2 rounded-lg border border-border bg-background/40 p-2.5">
                                    <p className="text-xs font-medium text-muted-foreground">
                                        Optional radius tiers (e.g. Outer = 600{" "}
                                        {unit})
                                    </p>
                                    {tierNames.length > 0 && (
                                        <div className="flex flex-wrap gap-1.5">
                                            {tierNames.map((name) => (
                                                <span
                                                    key={name}
                                                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs"
                                                >
                                                    {name}:{" "}
                                                    {tierOverrides[name]} {unit}
                                                    <button
                                                        type="button"
                                                        aria-label={`Remove tier ${name}`}
                                                        onClick={() =>
                                                            setTierOverrides(
                                                                (prev) => {
                                                                    const next =
                                                                        {
                                                                            ...prev,
                                                                        };
                                                                    delete next[
                                                                        name
                                                                    ];
                                                                    return next;
                                                                },
                                                            )
                                                        }
                                                    >
                                                        <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                                                    </button>
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <form
                                        className="flex gap-1.5"
                                        onSubmit={handleAddTier}
                                    >
                                        <Input
                                            placeholder="Tier name"
                                            value={newTierName}
                                            onChange={(e) =>
                                                setNewTierName(e.target.value)
                                            }
                                            className="h-8 text-xs"
                                        />
                                        <Input
                                            type="number"
                                            min={1}
                                            step="any"
                                            placeholder="Radius"
                                            value={newTierRadius}
                                            onChange={(e) =>
                                                setNewTierRadius(e.target.value)
                                            }
                                            className="h-8 w-24 text-xs"
                                        />
                                        <Button
                                            type="submit"
                                            size="sm"
                                            variant="secondary"
                                            className="h-8"
                                        >
                                            Add
                                        </Button>
                                    </form>
                                </div>

                                {/* Station list */}
                                {stations.length > 0 && (
                                    <div className="space-y-2">
                                        <div className="flex items-center justify-between gap-2 text-xs">
                                            <span className="text-muted-foreground">
                                                {activeStationCount} of{" "}
                                                {stations.length} enabled (click
                                                pins on map to toggle)
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
                                                    onClick={() => {
                                                        stationAbortRef.current?.abort();
                                                        stationAbortRef.current =
                                                            null;
                                                        setStationBusy(null);
                                                        setStations([]);
                                                        setExtraHidingZones([]);
                                                        setStationSummary(null);
                                                    }}
                                                >
                                                    Clear
                                                </button>
                                            </div>
                                        </div>

                                        <Input
                                            placeholder="Filter stations…"
                                            value={stationSearch}
                                            onChange={(e) =>
                                                setStationSearch(e.target.value)
                                            }
                                            className="h-8 text-xs"
                                        />

                                        <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-background/40">
                                            {filteredStations.map((s) => (
                                                <div
                                                    key={s.uid}
                                                    className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                                                >
                                                    <Checkbox
                                                        checked={s.enabled}
                                                        onCheckedChange={(v) =>
                                                            setStations((prev) =>
                                                                prev.map((x) =>
                                                                    x.uid ===
                                                                    s.uid
                                                                        ? {
                                                                              ...x,
                                                                              enabled:
                                                                                  v ===
                                                                                  true,
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
                                                                    x.uid ===
                                                                    s.uid
                                                                        ? {
                                                                              ...x,
                                                                              name: e
                                                                                  .target
                                                                                  .value,
                                                                          }
                                                                        : x,
                                                                ),
                                                            )
                                                        }
                                                        className={cn(
                                                            "min-w-0 flex-1 bg-transparent outline-none focus:underline",
                                                            !s.enabled &&
                                                                "text-muted-foreground line-through",
                                                        )}
                                                    />
                                                    {tierNames.length > 0 && (
                                                        <select
                                                            value={s.tier ?? ""}
                                                            aria-label={`Tier for ${s.name}`}
                                                            onChange={(e) =>
                                                                setStations(
                                                                    (prev) =>
                                                                        prev.map(
                                                                            (
                                                                                x,
                                                                            ) =>
                                                                                x.uid ===
                                                                                s.uid
                                                                                    ? {
                                                                                          ...x,
                                                                                          tier:
                                                                                              e
                                                                                                  .target
                                                                                                  .value ||
                                                                                              undefined,
                                                                                      }
                                                                                    : x,
                                                                        ),
                                                                )
                                                            }
                                                            className="h-6 rounded border border-border bg-background px-1 text-[11px]"
                                                        >
                                                            <option value="">
                                                                Base
                                                            </option>
                                                            {tierNames.map(
                                                                (t) => (
                                                                    <option
                                                                        key={t}
                                                                        value={
                                                                            t
                                                                        }
                                                                    >
                                                                        {t}
                                                                    </option>
                                                                ),
                                                            )}
                                                        </select>
                                                    )}
                                                    {s.custom && (
                                                        <button
                                                            type="button"
                                                            aria-label={`Delete ${s.name}`}
                                                            onClick={() =>
                                                                setStations(
                                                                    (prev) =>
                                                                        prev.filter(
                                                                            (
                                                                                x,
                                                                            ) =>
                                                                                x.uid !==
                                                                                s.uid,
                                                                        ),
                                                                )
                                                            }
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
                                disabled={
                                    activeStationCount === 0 &&
                                    extraHidingZones.length === 0
                                }
                                onClick={() => setStep("features")}
                            >
                                Next: Feature Layers →
                            </Button>
                        </>
                    )}

                    {/* ── STEP 3: FEATURE LAYERS (POIs, Regions & Lines, File Import) ── */}
                    {step === "features" && (
                        <>
                            <div className="grid grid-cols-3 gap-1 rounded-lg border border-border bg-muted/40 p-1">
                                {(
                                    [
                                        ["pois", "POIs (OSM)"],
                                        [
                                            "geometry",
                                            geometryLayers.length > 0
                                                ? `Regions (${geometryLayers.length})`
                                                : "Regions & Lines",
                                        ],
                                        ["import", "Import File"],
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

                            {featureSubTab === "pois" && (
                                <>
                            {!playArea && (
                                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                                    Set a play area in Step 1 before fetching
                                    features.
                                </div>
                            )}

                            <section className="space-y-3">
                                <div className="flex items-end gap-2">
                                    <div className="w-36 space-y-1">
                                        <Label
                                            htmlFor="creator-poi-buffer"
                                            className="text-xs text-muted-foreground"
                                        >
                                            Border margin (km)
                                        </Label>
                                        <Input
                                            id="creator-poi-buffer"
                                            type="number"
                                            min={0}
                                            max={50}
                                            step="any"
                                            value={poiBufferKm}
                                            onChange={(e) =>
                                                setPoiBufferKm(
                                                    Math.max(
                                                        0,
                                                        Number(e.target.value) ||
                                                            0,
                                                    ),
                                                )
                                            }
                                            className="h-9 text-xs"
                                        />
                                    </div>
                                    <Button
                                        type="button"
                                        className="flex-1"
                                        disabled={
                                            !hasPlayAreaGeometry ||
                                            Boolean(poiBusy)
                                        }
                                        onClick={() => void handleFetchPois()}
                                    >
                                        <RefreshCw
                                            className={cn(
                                                "mr-1.5 h-4 w-4",
                                                poiBusy && "animate-spin",
                                            )}
                                        />
                                        {poiBusy
                                            ? "Fetching…"
                                            : "Fetch selected layers"}
                                    </Button>
                                    {poiBusy && (
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() =>
                                                poiAbortRef.current?.abort()
                                            }
                                        >
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <p className="text-xs text-muted-foreground">
                                    All selected layers are fetched in one
                                    batched OpenStreetMap query. Margin includes
                                    nearest sites just outside the play area.
                                </p>

                                {poiBusy && (
                                    <p className="text-xs text-muted-foreground">
                                        {poiBusy}
                                    </p>
                                )}
                                {poiError && (
                                    <p className="text-xs text-destructive">
                                        {poiError}
                                    </p>
                                )}
                            </section>

                            <section className="space-y-2">
                                {layers.map((layer) => {
                                    const activeCount = layer.items.filter(
                                        (i) => i.enabled,
                                    ).length;
                                    const visible = visibleLayerIds.has(
                                        layer.id,
                                    );
                                    const expanded =
                                        expandedLayerId === layer.id;

                                    const toggleKind = (
                                        kind: FeatureEnabledFor,
                                    ) => {
                                        setLayers((prev) =>
                                            prev.map((l) => {
                                                if (l.id !== layer.id) return l;
                                                const has =
                                                    l.enabledFor.includes(kind);
                                                const next = has
                                                    ? l.enabledFor.filter(
                                                          (k) => k !== kind,
                                                      )
                                                    : [...l.enabledFor, kind];
                                                return {
                                                    ...l,
                                                    enabledFor: next,
                                                };
                                            }),
                                        );
                                    };

                                    return (
                                        <div
                                            key={layer.id}
                                            className="rounded-lg border border-border bg-background/40 p-2.5"
                                        >
                                            <div className="flex items-center gap-2">
                                                <Checkbox
                                                    checked={layer.selected}
                                                    onCheckedChange={(v) =>
                                                        setLayers((prev) =>
                                                            prev.map((l) =>
                                                                l.id ===
                                                                layer.id
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
                                                        backgroundColor:
                                                            layer.color,
                                                    }}
                                                />
                                                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                                    {layer.name}
                                                </span>
                                                {layer.fetched && (
                                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                                        {activeCount}/
                                                        {layer.items.length}
                                                    </span>
                                                )}
                                                {layer.items.length > 0 && (
                                                    <>
                                                        <button
                                                            type="button"
                                                            title={
                                                                visible
                                                                    ? "Hide on map"
                                                                    : "Show on map"
                                                            }
                                                            onClick={() =>
                                                                setVisibleLayerIds(
                                                                    (prev) => {
                                                                        const next =
                                                                            new Set(
                                                                                prev,
                                                                            );
                                                                        if (
                                                                            visible
                                                                        )
                                                                            next.delete(
                                                                                layer.id,
                                                                            );
                                                                        else
                                                                            next.add(
                                                                                layer.id,
                                                                            );
                                                                        return next;
                                                                    },
                                                                )
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
                                                            title="Inspect places"
                                                            onClick={() =>
                                                                setExpandedLayerId(
                                                                    expanded
                                                                        ? null
                                                                        : layer.id,
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
                                                    </>
                                                )}
                                                {layer.custom && (
                                                    <button
                                                        type="button"
                                                        aria-label={`Remove ${layer.name}`}
                                                        onClick={() =>
                                                            setLayers((prev) =>
                                                                prev.filter(
                                                                    (l) =>
                                                                        l.id !==
                                                                        layer.id,
                                                                ),
                                                            )
                                                        }
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                                                    </button>
                                                )}
                                            </div>

                                            {layer.selected && (
                                                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-6 text-[11px]">
                                                    <div className="flex gap-1">
                                                        {(
                                                            [
                                                                [
                                                                    "matching",
                                                                    "Match",
                                                                ],
                                                                [
                                                                    "measuring",
                                                                    "Measure",
                                                                ],
                                                                [
                                                                    "tentacle",
                                                                    "Tentacle",
                                                                ],
                                                            ] as const
                                                        ).map(
                                                            ([kind, label]) => {
                                                                const on =
                                                                    layer.enabledFor.includes(
                                                                        kind,
                                                                    );
                                                                return (
                                                                    <button
                                                                        key={
                                                                            kind
                                                                        }
                                                                        type="button"
                                                                        onClick={() =>
                                                                            toggleKind(
                                                                                kind,
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
                                                    <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                                                        <input
                                                            type="checkbox"
                                                            checked={
                                                                layer.notableOnly
                                                            }
                                                            onChange={(e) =>
                                                                setLayers(
                                                                    (prev) =>
                                                                        prev.map(
                                                                            (
                                                                                l,
                                                                            ) =>
                                                                                l.id ===
                                                                                layer.id
                                                                                    ? {
                                                                                          ...l,
                                                                                          notableOnly:
                                                                                              e
                                                                                                  .target
                                                                                                  .checked,
                                                                                      }
                                                                                    : l,
                                                                        ),
                                                                )
                                                            }
                                                        />
                                                        Notable only
                                                    </label>
                                                </div>
                                            )}

                                            {expanded &&
                                                layer.items.length > 0 && (
                                                    <div className="mt-2 max-h-40 divide-y divide-border overflow-y-auto rounded border border-border bg-card">
                                                        {layer.items.map(
                                                            (item) => (
                                                                <label
                                                                    key={
                                                                        item.uid
                                                                    }
                                                                    className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs"
                                                                >
                                                                    <Checkbox
                                                                        checked={
                                                                            item.enabled
                                                                        }
                                                                        onCheckedChange={(
                                                                            v,
                                                                        ) =>
                                                                            setLayers(
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
                                                                                                  }
                                                                                                : l,
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
                                                                        {
                                                                            item.name
                                                                        }
                                                                    </span>
                                                                </label>
                                                            ),
                                                        )}
                                                    </div>
                                                )}
                                        </div>
                                    );
                                })}
                            </section>

                            {/* Add custom OSM layer */}
                            <form
                                onSubmit={handleAddCustomLayer}
                                className="space-y-2 rounded-lg border border-border bg-background/40 p-3"
                            >
                                <p className="text-xs font-semibold">
                                    Add custom OSM POI layer
                                </p>
                                <div className="grid grid-cols-2 gap-2">
                                    <Input
                                        placeholder="Name (e.g. Castle)"
                                        value={customLayerName}
                                        onChange={(e) =>
                                            setCustomLayerName(e.target.value)
                                        }
                                        className="h-8 text-xs"
                                    />
                                    <Input
                                        placeholder='["historic"="castle"]'
                                        value={customLayerFilter}
                                        onChange={(e) =>
                                            setCustomLayerFilter(e.target.value)
                                        }
                                        className="h-8 font-mono text-xs"
                                    />
                                </div>
                                {customLayerError && (
                                    <p className="text-xs text-destructive">
                                        {customLayerError}
                                    </p>
                                )}
                                <Button
                                    type="submit"
                                    size="sm"
                                    variant="secondary"
                                >
                                    <Plus className="mr-1 h-3.5 w-3.5" />
                                    Add layer
                                </Button>
                            </form>

                            {/* Advanced Overpass endpoint */}
                            <div>
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowAdvancedOsm((v) => !v)
                                    }
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                >
                                    {showAdvancedOsm ? "▾" : "▸"} Advanced
                                    Overpass endpoint
                                </button>
                                {showAdvancedOsm && (
                                    <div className="mt-2 space-y-1">
                                        <Input
                                            placeholder="Default: overpass-api.de + kumi.systems fallback"
                                            value={customEndpoint}
                                            onChange={(e) =>
                                                setCustomEndpoint(
                                                    e.target.value,
                                                )
                                            }
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                )}
                            </div>
                                </>
                            )}

                            {featureSubTab === "geometry" && (
                                <CreatorGeometryPanel
                                    playArea={playArea}
                                    playAreaGenRef={playAreaGenRef}
                                    poiBufferKm={poiBufferKm}
                                    preferEnglishName={preferEnglishName}
                                    customEndpoint={customEndpoint}
                                    geometryLayers={geometryLayers}
                                    setGeometryLayers={setGeometryLayers}
                                    visibleLayerIds={visibleLayerIds}
                                    setVisibleLayerIds={setVisibleLayerIds}
                                    existingLayerSlugs={existingLayerSlugs}
                                />
                            )}

                            {featureSubTab === "import" && (
                                <CreatorImportPanel
                                    existingLayerSlugs={existingLayerSlugs}
                                    geometryLayerCount={geometryLayers.length}
                                    onSetPlayArea={(nextArea, name) => {
                                        setPlayAreaAndFit(nextArea);
                                        if (name && !gameName.trim()) {
                                            setGameName(name);
                                        }
                                    }}
                                    onImportStations={(imported, replace) => {
                                        if (replace) {
                                            stationAbortRef.current?.abort();
                                            stationAbortRef.current = null;
                                            setStationBusy(null);
                                            setExtraHidingZones([]);
                                        }
                                        setStations((prev) =>
                                            replace
                                                ? imported
                                                : [...prev, ...imported],
                                        );
                                        setStationSummary(
                                            replace
                                                ? `Loaded ${imported.length} stations from file`
                                                : `Added ${imported.length} stations from file`,
                                        );
                                    }}
                                    onAddGeometryLayer={(layer) => {
                                        setGeometryLayers((prev) => [
                                            ...prev,
                                            layer,
                                        ]);
                                        setVisibleLayerIds((prev) =>
                                            new Set(prev).add(layer.id),
                                        );
                                        setFeatureSubTab("geometry");
                                    }}
                                    onLoadGameDefinition={
                                        handleLoadExistingGame
                                    }
                                />
                            )}

                            <Button
                                type="button"
                                className="w-full"
                                onClick={() => setStep("export")}
                            >
                                Next: Review & Export →
                            </Button>
                        </>
                    )}

                    {/* ── STEP 4: REVIEW & EXPORT ── */}
                    {step === "export" && (
                        <>
                            {assembled.validationErrors.length > 0 && (
                                <div className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                                    <p className="font-semibold">
                                        Finish these before exporting:
                                    </p>
                                    <ul className="list-disc pl-4">
                                        {assembled.validationErrors.map(
                                            (err, idx) => (
                                                <li key={idx}>{err}</li>
                                            ),
                                        )}
                                    </ul>
                                </div>
                            )}

                            {assembled.definition && assembled.compiled && (
                                <>
                                    <section className="space-y-2 rounded-lg border border-border bg-background/40 p-3 text-xs">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <span className="text-sm font-semibold">
                                                {assembled.definition.name}
                                            </span>
                                            <span className="font-mono text-muted-foreground">
                                                {formatFileSize(
                                                    assembled.jsonSize,
                                                )}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                                            <span>
                                                {activeStationCount +
                                                    extraHidingZones.length}{" "}
                                                hiding zones
                                            </span>
                                            <span>
                                                {activeLayerCount} feature
                                                layers
                                            </span>
                                            <span>
                                                {
                                                    assembled.compiled.questions
                                                        .length
                                                }{" "}
                                                questions
                                            </span>
                                        </div>
                                        <div className="pt-1">
                                            <Label
                                                htmlFor="creator-custom-id"
                                                className="text-[11px] text-muted-foreground"
                                            >
                                                Game ID (filename & permanent key)
                                            </Label>
                                            <Input
                                                id="creator-custom-id"
                                                placeholder={fileStem}
                                                value={customId}
                                                onChange={(e) =>
                                                    setCustomId(e.target.value)
                                                }
                                                className="mt-1 h-8 font-mono text-xs"
                                            />
                                        </div>
                                        {(preservedMetadata?.visibility ||
                                            (preservedMetadata?.serverId &&
                                                preservedMetadata.serverId !==
                                                    "home-games")) && (
                                            <div className="mt-2 flex items-center justify-between gap-2 rounded border border-border bg-card px-2 py-1.5 text-[11px] text-muted-foreground">
                                                <span>
                                                    Preserving loaded server &
                                                    access metadata (
                                                    {preservedMetadata.serverId}
                                                    {preservedMetadata.visibility
                                                        ? `, ${preservedMetadata.visibility.kind}`
                                                        : ""}
                                                    ).
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setPreservedMetadata(
                                                            null,
                                                        )
                                                    }
                                                    className="shrink-0 font-medium text-primary hover:underline"
                                                >
                                                    Export as casual copy
                                                </button>
                                            </div>
                                        )}
                                    </section>

                                    {/* Questions preview */}
                                    <section className="space-y-1.5">
                                        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                            Questions players will see (
                                            {
                                                assembled.compiled.questions
                                                    .length
                                            }
                                            )
                                        </h2>
                                        <div className="max-h-36 overflow-y-auto rounded-lg border border-border bg-background/40 p-2 text-xs">
                                            {assembled.compiled.questions
                                                .length === 0 ? (
                                                <p className="text-muted-foreground">
                                                    Custom questions only.
                                                </p>
                                            ) : (
                                                <ul className="space-y-0.5">
                                                    {assembled.compiled.questions.map(
                                                        (q) => (
                                                            <li
                                                                key={q.id}
                                                                className="flex items-center justify-between gap-2"
                                                            >
                                                                <span className="truncate">
                                                                    {q.label}
                                                                </span>
                                                                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                                                    {q.family}
                                                                </span>
                                                            </li>
                                                        ),
                                                    )}
                                                </ul>
                                            )}
                                        </div>
                                    </section>

                                    {/* Quality checks from check-game.mjs */}
                                    {checkingQuality && (
                                        <p className="text-xs text-muted-foreground">
                                            Running game quality checks…
                                        </p>
                                    )}
                                    {!checkingQuality &&
                                        qualityIssues.length > 0 && (
                                            <section className="space-y-1.5">
                                                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                                                    Quality checks (
                                                    {qualityIssues.length})
                                                </h2>
                                                <div className="max-h-40 space-y-1 overflow-y-auto">
                                                    {qualityIssues.map(
                                                        (issue, idx) => (
                                                            <div
                                                                key={idx}
                                                                className={cn(
                                                                    "rounded-md border px-2 py-1.5 text-xs",
                                                                    issue.level ===
                                                                        "error"
                                                                        ? "border-destructive/50 bg-destructive/10 text-destructive"
                                                                        : issue.level ===
                                                                            "warning"
                                                                          ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                                                                          : "border-border bg-muted/40 text-muted-foreground",
                                                                )}
                                                            >
                                                                <span className="mr-1 font-semibold uppercase">
                                                                    {issue.strict
                                                                        ? "defect"
                                                                        : issue.level}
                                                                </span>
                                                                {issue.message}
                                                            </div>
                                                        ),
                                                    )}
                                                </div>
                                            </section>
                                        )}

                                    <Separator />

                                    {/* Primary actions */}
                                    <section className="space-y-2.5">
                                        <Button
                                            type="button"
                                            className="w-full"
                                            disabled={Boolean(launchingAction)}
                                            onClick={() =>
                                                void handleTestLocally()
                                            }
                                        >
                                            <Play className="mr-2 h-4 w-4" />
                                            {launchingAction === "local"
                                                ? "Opening Local Play…"
                                                : "Test locally in Searchlight"}
                                        </Button>

                                        <div className="grid grid-cols-2 gap-2">
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={handleDownloadJson}
                                            >
                                                <Download className="mr-1.5 h-4 w-4" />
                                                .game.json
                                            </Button>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                onClick={handleDownloadKml}
                                            >
                                                <Download className="mr-1.5 h-4 w-4" />
                                                .kml (My Maps)
                                            </Button>
                                        </div>

                                        {/* KML options */}
                                        <div className="space-y-1.5 rounded-lg border border-border bg-background/40 p-2.5 text-xs">
                                            <p className="font-medium text-muted-foreground">
                                                Google My Maps KML options
                                            </p>
                                            <label className="flex cursor-pointer items-center gap-2">
                                                <Checkbox
                                                    checked={combinePoisKml}
                                                    onCheckedChange={(v) =>
                                                        setCombinePoisKml(
                                                            v === true,
                                                        )
                                                    }
                                                />
                                                <span>
                                                    Combine POIs into one styled
                                                    layer (10-layer safe)
                                                </span>
                                            </label>
                                            <label className="flex cursor-pointer items-center gap-2">
                                                <Checkbox
                                                    checked={includeCirclesKml}
                                                    onCheckedChange={(v) =>
                                                        setIncludeCirclesKml(
                                                            v === true,
                                                        )
                                                    }
                                                />
                                                <span>
                                                    Include hiding zone circles
                                                </span>
                                            </label>
                                            {kmlPreview && (
                                                <p className="text-[11px] text-muted-foreground">
                                                    {kmlPreview.folderCount}{" "}
                                                    layer
                                                    {kmlPreview.folderCount ===
                                                    1
                                                        ? ""
                                                        : "s"}{" "}
                                                    ·{" "}
                                                    {formatFileSize(
                                                        kmlPreview.byteLength,
                                                    )}
                                                </p>
                                            )}
                                            {kmlPreview?.myMapsWarnings.map(
                                                (warn, idx) => (
                                                    <div
                                                        key={idx}
                                                        className="flex items-start gap-1.5 text-amber-300"
                                                    >
                                                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                                        <span>{warn}</span>
                                                    </div>
                                                ),
                                            )}
                                        </div>

                                        <Button
                                            type="button"
                                            variant="secondary"
                                            className="w-full"
                                            disabled={Boolean(launchingAction)}
                                            onClick={() =>
                                                void handleImportToSearchlight()
                                            }
                                        >
                                            <UploadCloud className="mr-2 h-4 w-4" />
                                            {launchingAction === "import"
                                                ? "Opening Importer…"
                                                : "Import to Searchlight (requires sign-in)"}
                                        </Button>
                                    </section>
                                </>
                            )}
                        </>
                    )}
                </div>
            </aside>

            {/* Interactive Map Pane (CARTO Voyager — no Google Maps, no Searchlight API) */}
            <div className="relative h-[55dvh] flex-1 overflow-hidden md:h-full">
                {interactionMode !== "browse" && (
                    <div className="pointer-events-auto absolute left-1/2 top-3 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/50 bg-background/95 px-3.5 py-1.5 text-xs shadow-lg backdrop-blur-sm">
                        <Layers className="h-3.5 w-3.5 text-primary" />
                        <span>
                            {interactionMode === "draw-area"
                                ? `Drawing play area: click corners (${drawPoints.length})`
                                : "Click map to add a custom station"}
                        </span>
                        <button
                            type="button"
                            className="ml-1 font-semibold text-primary hover:underline"
                            onClick={() => {
                                if (
                                    interactionMode === "draw-area" &&
                                    drawPoints.length >= 3
                                ) {
                                    handleFinishDrawing();
                                } else {
                                    setInteractionMode("browse");
                                    setDrawPoints([]);
                                }
                            }}
                        >
                            {interactionMode === "draw-area" &&
                            drawPoints.length >= 3
                                ? "Finish"
                                : "Done"}
                        </button>
                    </div>
                )}

                <MapContainer
                    center={[48.85, 8.2]}
                    zoom={5}
                    minZoom={2}
                    preferCanvas
                    className="!h-full w-full"
                >
                    <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>'
                        url={`https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=${CARTO_API_KEY}`}
                        subdomains="abcd"
                        maxZoom={20}
                        minZoom={2}
                        noWrap
                        crossOrigin
                        bounds={WORLD_BOUNDS}
                    />
                    <ScaleControl position="bottomleft" />
                    <MapController
                        fitBoundsTarget={fitTarget}
                        mapRef={mapRef}
                        interactionMode={interactionMode}
                        onMapClick={handleMapClick}
                    />

                    {/* Play area */}
                    {playArea && (
                        <GeoJSON
                            key={`play-area-${playAreaVersion}`}
                            data={playArea}
                            interactive={false}
                            style={{
                                color: "#111827",
                                weight: 2.5,
                                fillColor: "#2563eb",
                                fillOpacity: 0.06,
                            }}
                        />
                    )}

                    {/* Polygon currently being drawn */}
                    {drawPoints.length >= 2 && (
                        <Polyline
                            positions={drawPoints}
                            pathOptions={{
                                color: "#2563eb",
                                weight: 2,
                                dashArray: "6 4",
                            }}
                        />
                    )}
                    {drawPoints.length >= 3 && (
                        <LeafletPolygon
                            positions={drawPoints}
                            pathOptions={{
                                color: "#2563eb",
                                weight: 2,
                                fillOpacity: 0.12,
                            }}
                        />
                    )}
                    {drawPoints.map(([lat, lng], idx) => (
                        <CircleMarker
                            key={`draw-${idx}`}
                            center={[lat, lng]}
                            radius={5}
                            pathOptions={{
                                color: "#fff",
                                weight: 1.5,
                                fillColor: "#2563eb",
                                fillOpacity: 1,
                            }}
                        />
                    ))}

                    {/* Hiding zone circles preview */}
                    {previewCircles && (
                        <GeoJSON
                            key={`circles-${hidingRadius}-${unit}-${extraHidingZones.length}-${JSON.stringify(tierOverrides)}-${stations
                                .filter((s) => s.enabled)
                                .map((s) => `${s.uid}:${s.lat}:${s.lng}:${s.tier ?? ""}`)
                                .join("|")}`}
                            data={previewCircles}
                            interactive={false}
                            style={{
                                color: "#2563eb",
                                weight: 1,
                                fillOpacity: 0.08,
                            }}
                        />
                    )}

                    {/* Station pins (click to toggle) */}
                    {stations.map((station) => (
                        <CircleMarker
                            key={station.uid}
                            center={[station.lat, station.lng]}
                            radius={station.enabled ? 6 : 4.5}
                            pathOptions={{
                                color: station.enabled ? "#ffffff" : "#9ca3af",
                                weight: 1.5,
                                fillColor: station.enabled
                                    ? "#2563eb"
                                    : "#6b7280",
                                fillOpacity: station.enabled ? 0.95 : 0.4,
                            }}
                            eventHandlers={{
                                click: () => {
                                    if (interactionMode !== "browse") return;
                                    setStations((prev) =>
                                        prev.map((s) =>
                                            s.uid === station.uid
                                                ? { ...s, enabled: !s.enabled }
                                                : s,
                                        ),
                                    );
                                },
                            }}
                        >
                            <Tooltip sticky>
                                {station.name}
                                {station.tier ? ` (${station.tier})` : ""}
                                {!station.enabled ? " — disabled" : ""}
                            </Tooltip>
                        </CircleMarker>
                    ))}

                    {/* Visible geometry layers (admin regions, line layers, imported shapes) */}
                    {geometryLayers
                        .filter((l) => visibleLayerIds.has(l.id))
                        .map((layer) => {
                            const activeItems = layer.items.filter(
                                (item) => item.enabled,
                            );
                            if (activeItems.length === 0) return null;
                            const fc = {
                                type: "FeatureCollection" as const,
                                features: activeItems.map((item) => ({
                                    type: "Feature" as const,
                                    geometry: item.geometry,
                                    properties: { name: item.name },
                                })),
                            };
                            const activeSig = activeItems
                                .map((i) => i.uid)
                                .join("|");
                            const layerKey = `${layer.id}-${layer.vertexCount}-${layer.noOverlaps ? 1 : 0}-${activeSig}`;
                            return (
                                <GeoJSON
                                    key={layerKey}
                                    data={fc}
                                    style={() => ({
                                        color: layer.color,
                                        weight:
                                            layer.family === "lines" ? 3 : 2,
                                        fillColor: layer.color,
                                        fillOpacity:
                                            layer.family === "polygons"
                                                ? 0.14
                                                : 0.85,
                                    })}
                                    pointToLayer={(_feature, latlng) =>
                                        L.circleMarker(latlng, {
                                            radius: 5,
                                            color: "#ffffff",
                                            weight: 1,
                                            fillColor: layer.color,
                                            fillOpacity: 0.9,
                                        })
                                    }
                                    onEachFeature={(feature, leafletLayer) => {
                                        const name =
                                            typeof feature.properties?.name ===
                                            "string"
                                                ? feature.properties.name
                                                : layer.name;
                                        const el =
                                            document.createElement("span");
                                        el.textContent = `${name} (${layer.name})`;
                                        leafletLayer.bindTooltip(el, {
                                            sticky: true,
                                        });
                                    }}
                                />
                            );
                        })}

                    {/* Visible POI layer pins (click to toggle) */}
                    {layers
                        .filter((l) => visibleLayerIds.has(l.id))
                        .flatMap((layer) =>
                            layer.items.map((item) => (
                                <CircleMarker
                                    key={item.uid}
                                    center={[item.lat, item.lng]}
                                    radius={item.enabled ? 5 : 4}
                                    pathOptions={{
                                        color: "#ffffff",
                                        weight: 1,
                                        fillColor: item.enabled
                                            ? layer.color
                                            : "#9ca3af",
                                        fillOpacity: item.enabled ? 0.9 : 0.35,
                                    }}
                                    eventHandlers={{
                                        click: () => {
                                            if (interactionMode !== "browse") {
                                                return;
                                            }
                                            setLayers((prev) =>
                                                prev.map((l) =>
                                                    l.id === layer.id
                                                        ? {
                                                              ...l,
                                                              items: l.items.map(
                                                                  (x) =>
                                                                      x.uid ===
                                                                      item.uid
                                                                          ? {
                                                                                ...x,
                                                                                enabled:
                                                                                    !x.enabled,
                                                                            }
                                                                          : x,
                                                              ),
                                                          }
                                                        : l,
                                                ),
                                            );
                                        },
                                    }}
                                >
                                    <Tooltip sticky>
                                        {item.name} ({layer.name}
                                        {!item.enabled ? ", excluded" : ""})
                                    </Tooltip>
                                </CircleMarker>
                            )),
                        )}
                </MapContainer>
            </div>
        </div>
    );
}
