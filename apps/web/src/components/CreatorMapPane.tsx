import type {
  Bounds,
  DistanceUnit,
  HidingZoneFeature,
  PlayAreaFeatureCollection,
} from "@searchlight/shared";
import type * as L from "leaflet";
import { Layers } from "lucide-react";
import { memo, useEffect } from "react";
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

import type { SimplifyPreviewState } from "@/components/CreatorLayersList";
import { CARTO_API_KEY, WORLD_BOUNDS } from "@/lib/basemap";
import type { CreatorGeometryLayer } from "@/lib/creator/assemble";
import type { CreatorPointItem } from "@/lib/creator/overpass";

type MapInteractionMode = "browse" | "draw-area" | "add-station";

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
    el.style.cursor = interactionMode === "browse" ? "" : "crosshair";
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

interface Props {
  interactionMode: MapInteractionMode;
  setInteractionMode: (mode: MapInteractionMode) => void;
  drawPoints: [number, number][];
  setDrawPoints: (pts: [number, number][]) => void;
  handleFinishDrawing: () => void;
  simplifyPreview: SimplifyPreviewState | null;
  fitTarget: { bounds: Bounds; seq: number } | null;
  mapRef: React.MutableRefObject<L.Map | null>;
  handleMapClick: (lat: number, lng: number) => void;
  playArea: PlayAreaFeatureCollection | null;
  playAreaVersion: number;
  previewCircles: GeoJSON.FeatureCollection | null;
  hidingRadius: number;
  unit: DistanceUnit;
  extraHidingZones: readonly HidingZoneFeature[];
  tierOverrides: Record<string, number>;
  stations: CreatorPointItem[];
  setStations: React.Dispatch<React.SetStateAction<CreatorPointItem[]>>;
  hideDisabledStations?: boolean;
  layers: CreatorGeometryLayer[];
  setLayers: React.Dispatch<React.SetStateAction<CreatorGeometryLayer[]>>;
  visibleLayerIds: ReadonlySet<string>;
}

// Memoized so typing in the sidebar doesn't re-render every station marker per key.
export const CreatorMapPane = memo(function CreatorMapPane({
  interactionMode,
  setInteractionMode,
  drawPoints,
  setDrawPoints,
  handleFinishDrawing,
  simplifyPreview,
  fitTarget,
  mapRef,
  handleMapClick,
  playArea,
  playAreaVersion,
  previewCircles,
  hidingRadius,
  unit,
  extraHidingZones,
  tierOverrides,
  stations,
  setStations,
  hideDisabledStations = false,
  layers,
  setLayers,
  visibleLayerIds,
}: Props) {
  return (
    <div className="relative h-[55dvh] overflow-hidden md:h-full md:flex-1">
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
              if (interactionMode === "draw-area" && drawPoints.length >= 3) {
                handleFinishDrawing();
              } else {
                setInteractionMode("browse");
                setDrawPoints([]);
              }
            }}
          >
            {interactionMode === "draw-area" && drawPoints.length >= 3 ? "Finish" : "Done"}
          </button>
        </div>
      )}

      {interactionMode === "browse" && simplifyPreview && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[1000] flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-500/60 bg-background/95 px-3.5 py-1.5 text-xs text-amber-300 shadow-lg backdrop-blur-sm">
          <span>
            Simplify preview ({simplifyPreview.layerName} · {simplifyPreview.toleranceMeters} m):{" "}
            {simplifyPreview.originalVertices.toLocaleString()} →{" "}
            {simplifyPreview.vertexCount.toLocaleString()} pts · dashed = simplified
          </span>
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

        {(hideDisabledStations
          ? stations.filter((s) => s.enabled)
          : [...stations.filter((s) => !s.enabled), ...stations.filter((s) => s.enabled)]
        ).map((station) => (
          <CircleMarker
            key={station.uid}
            center={[station.lat, station.lng]}
            radius={station.enabled ? 6 : 3.5}
            pathOptions={{
              color: station.enabled ? "#ffffff" : "#9ca3af",
              weight: station.enabled ? 1.5 : 1,
              fillColor: station.enabled ? "#2563eb" : "#6b7280",
              fillOpacity: station.enabled ? 0.95 : 0.3,
            }}
            eventHandlers={{
              click: () => {
                if (interactionMode !== "browse") return;
                setStations((prev) =>
                  prev.map((s) => (s.uid === station.uid ? { ...s, enabled: !s.enabled } : s)),
                );
              },
            }}
          >
            <Tooltip sticky>
              {station.name}
              {station.tier ? ` (${station.tier})` : ""}
              {!station.enabled ? " (disabled)" : ""}
            </Tooltip>
          </CircleMarker>
        ))}

        {layers
          .filter((l) => l.family !== "points" && visibleLayerIds.has(l.id))
          .map((layer) => {
            const activeItems = layer.items.filter((item) => item.enabled);
            if (activeItems.length === 0) return null;
            const fc = {
              type: "FeatureCollection" as const,
              features: activeItems.map((item) => ({
                type: "Feature" as const,
                geometry: item.geometry,
                properties: { name: item.name },
              })),
            };
            const activeSig = activeItems.map((i) => i.uid).join("|");
            const layerKey = `${layer.id}-${layer.color}-${layer.vertexCount}-${layer.noOverlaps ? 1 : 0}-${activeSig}`;
            return (
              <GeoJSON
                key={layerKey}
                data={fc}
                style={() => ({
                  color: layer.color,
                  weight: layer.family === "lines" ? 3 : 2,
                  fillColor: layer.color,
                  fillOpacity: layer.family === "polygons" ? 0.14 : 0.85,
                })}
                onEachFeature={(feature, leafletLayer) => {
                  const name =
                    typeof feature.properties?.name === "string"
                      ? feature.properties.name
                      : layer.name;
                  const el = document.createElement("span");
                  el.textContent = `${name} (${layer.name})`;
                  leafletLayer.bindTooltip(el, {
                    sticky: true,
                  });
                }}
              />
            );
          })}

        {simplifyPreview &&
          (() => {
            const activeItems = simplifyPreview.items.filter((item) => item.enabled);
            if (activeItems.length === 0) return null;
            const fc = {
              type: "FeatureCollection" as const,
              features: activeItems.map((item) => ({
                type: "Feature" as const,
                geometry: item.geometry,
                properties: { name: item.name },
              })),
            };
            return (
              <GeoJSON
                key={`simplify-preview-${simplifyPreview.layerId}-${simplifyPreview.toleranceMeters}-${simplifyPreview.vertexCount}-${activeItems.map((i) => i.uid).join(",")}`}
                data={fc}
                interactive={false}
                style={() => ({
                  color: "#f59e0b",
                  weight: 2.5,
                  dashArray: "6 4",
                  fillOpacity: 0,
                })}
              />
            );
          })()}

        {layers
          .filter((l) => l.family === "points" && visibleLayerIds.has(l.id))
          .flatMap((layer) =>
            layer.items.map((item) => {
              if (item.geometry.type !== "Point") return null;
              const [lng, lat] = item.geometry.coordinates;
              return (
                <CircleMarker
                  key={item.uid}
                  center={[lat, lng]}
                  radius={item.enabled ? 5 : 4}
                  pathOptions={{
                    color: "#ffffff",
                    weight: 1,
                    fillColor: item.enabled ? layer.color : "#9ca3af",
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
                                items: l.items.map((x) =>
                                  x.uid === item.uid
                                    ? {
                                        ...x,
                                        enabled: !x.enabled,
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
              );
            }),
          )}
      </MapContainer>
    </div>
  );
});
