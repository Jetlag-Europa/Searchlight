import "leaflet-draw/dist/leaflet.draw.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
// The default import is Leaflet's own object, which leaflet-draw extends with
// drawLocal. A namespace import is a copy made before leaflet-draw runs.
import L from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";
import { FeatureGroup, Marker, Polygon, Polyline } from "react-leaflet";
import { EditControl } from "react-leaflet-draw";

import { sessionReadOnly } from "@/lib/activeSession";
import { autoSave, drawingQuestionKey, questionModified, questions, save } from "@/lib/context";
import { uniqBy } from "@/lib/utils";
import { isZoneSizeChange } from "@/lib/zoneSize";
import { lngLatToText } from "@/maps/geo-utils";
import type {
  CustomMatchingQuestion,
  CustomMeasuringQuestion,
  CustomTentacleQuestion,
  Question,
} from "@/maps/schema";

import { LatitudeLongitude } from "./LatLngPicker";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input } from "./ui/input";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

// The points drawn here (and leaflet-draw's marker tool) use Leaflet's default
// icon. Leaflet looks for its image next to leaflet.css, which the build
// inlines, so it would ask for /map/marker-icon.png: use the app's blue one.
L.Icon.Default.imagePath = "";
L.Icon.Default.mergeOptions({
  iconUrl: "/markers/marker-icon-2x-blue.png",
  iconRetinaUrl: "/markers/marker-icon-2x-blue.png",
  shadowUrl: "/markers/marker-shadow.png",
});

const swapCoordinates = (geojson: any) => {
  return JSON.parse(JSON.stringify(geojson), (key, value) => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      return [value[1], value[0], ...value.slice(2)];
    }
    return value;
  });
};

const TentacleMarker = ({ point }: { point: CustomTentacleQuestion["places"][number] }) => {
  const $autoSave = useStore(autoSave);
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Marker
        // @ts-expect-error This is passed to options, so it is not typed
        properties={point.properties}
        position={[point.geometry.coordinates[1], point.geometry.coordinates[0]]}
        eventHandlers={{
          click: () => {
            setOpen(true);
          },
        }}
      />
      <DialogContent aria-describedby={undefined}>
        <div className="flex flex-col gap-2">
          <Input
            className="text-center !text-2xl font-bold font-poppins mt-3"
            value={point.properties?.name}
            onChange={(e) => {
              point.properties.name = e.target.value;
              questionModified();
            }}
          />
          <SidebarMenu>
            <LatitudeLongitude
              latitude={point.geometry.coordinates[1]}
              longitude={point.geometry.coordinates[0]}
              inlineEdit
              onChange={(lat, lng) => {
                if (lat) {
                  point.geometry.coordinates[1] = lat;
                }
                if (lng) {
                  point.geometry.coordinates[0] = lng;
                }

                questionModified();
              }}
            />
            {!$autoSave && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500 mt-2"
                  onClick={save}
                >
                  Save
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// A custom matching or measuring point.
const PointMarker = ({
  point,
}: {
  point: CustomMatchingQuestion["geo"][number] | CustomMeasuringQuestion["geo"]["features"][number];
}) => {
  const $autoSave = useStore(autoSave);
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Marker
        position={[point.geometry.coordinates[1], point.geometry.coordinates[0]]}
        // @ts-expect-error This is passed to options, so it is not typed
        isDialog={true}
        eventHandlers={{
          click: () => {
            setOpen(true);
          },
        }}
      />
      <DialogContent aria-describedby={undefined}>
        <div className="flex flex-col gap-2">
          <SidebarMenu>
            <LatitudeLongitude
              latitude={point.geometry.coordinates[1]}
              longitude={point.geometry.coordinates[0]}
              inlineEdit
              onChange={(lat, lng) => {
                if (lat) {
                  point.geometry.coordinates[1] = lat;
                }
                if (lng) {
                  point.geometry.coordinates[0] = lng;
                }

                questionModified();
              }}
            />
            {!$autoSave && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="bg-blue-600 p-2 rounded-md font-semibold font-poppins transition-shadow duration-500 mt-2"
                  onClick={save}
                >
                  Save
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Leaflet Draw's edit mode ends by disabling dragging on every marker it was
// editing, which throws, and blanks the map, for a marker React removed in the
// meantime (a teammate's save, switching or deleting the card).
const editToolbar = (L as unknown as { EditToolbar: { Edit: { prototype: any } } }).EditToolbar;
const disableLayerEdit = editToolbar.Edit.prototype._disableLayerEdit;
editToolbar.Edit.prototype._disableLayerEdit = function (e: any) {
  const layer = e.layer || e.target || e;
  if (layer instanceof L.Marker && !layer.dragging) return;
  disableLayerEdit.call(this, e);
};

// A marker keeps its first key while its point's coordinates are typed (they
// change in place), so its coordinate dialog stays open. Points that come back
// as new objects (a teammate's save, a redraw) are keyed by their coordinates,
// so unchanged ones keep their markers, which Leaflet Draw's edit mode needs.
const markerKeys = new WeakMap<object, string>();
const markerKey = (geometry: { coordinates: number[] }) => {
  if (!markerKeys.has(geometry)) markerKeys.set(geometry, geometry.coordinates.join(","));
  return markerKeys.get(geometry);
};

export const PolygonDraw = () => {
  const $drawingQuestionKey = useStore(drawingQuestionKey);
  const $questions = useStore(questions);
  const $readOnly = useStore(sessionReadOnly);

  const featureRef = useRef<any | null>(null);

  // Drawing is only for the custom question being edited, and never for a
  // spectator.
  let question: Question | undefined;

  if ($drawingQuestionKey !== -1 && $readOnly) {
    drawingQuestionKey.set(-1);
  } else if ($drawingQuestionKey !== -1) {
    question = $questions.find((q) => q.key === $drawingQuestionKey);

    if (question && isZoneSizeChange(question)) question = undefined;
    // Locked, deleted, or switched to a type that isn't drawn (which would
    // also keep auto zoom waiting): the drawing ends.
    const data = question?.data as { type?: unknown; locationType?: unknown } | undefined;
    const drawn = data?.locationType === "custom" || String(data?.type).startsWith("custom-");
    if (question?.data.drag === false || !drawn) {
      drawingQuestionKey.set(-1);
    }
    if (question?.id === "matching") {
      L.drawLocal.draw.toolbar.buttons.polygon = "Draw the matching zone(s)!";
    }
    if (question?.id === "measuring") {
      L.drawLocal.draw.toolbar.buttons.polygon = "Draw the measuring zone(s)!";
    }
  }

  const onChange = () => {
    if (question?.id === "tentacles" && question.data.locationType === "custom") {
      if (!featureRef.current?._layers) return;

      const layers = featureRef.current._layers;
      const geoJSONs = Object.values(layers).map((layer: any) => {
        const geoJSON = layer.toGeoJSON();
        geoJSON.properties = layer.options.properties;

        if (!geoJSON.properties) {
          geoJSON.properties = {
            name: lngLatToText(geoJSON.geometry.coordinates),
          };
        }

        return geoJSON;
      });
      const geoJSON = turf.featureCollection(geoJSONs);

      question.data.places = uniqBy(geoJSON.features as CustomTentacleQuestion["places"], (x) =>
        x.geometry.coordinates.join(","),
      ); // Sometimes keys are duplicated
      if (featureRef.current) {
        Object.values(featureRef.current._layers).map((layer: any) => {
          if (!layer.options.properties) {
            featureRef.current.removeLayer(layer);
          }
        });
      }
      questionModified();
    } else if (question?.id === "matching" && question.data.type === "custom-zone") {
      if (!featureRef.current?._layers) return;

      const layers = featureRef.current._layers;
      const geoJSONs = Object.values(layers).map((layer: any) => layer.toGeoJSON());
      const geoJSON = turf.combine(turf.featureCollection(geoJSONs)).features[0];

      (question.data as CustomMatchingQuestion).geo = geoJSON;
      if (featureRef.current) {
        Object.values(featureRef.current._layers).map((layer: any) => {
          if (!layer.options.isSpecial) {
            featureRef.current.removeLayer(layer);
          }
        });
      }
      questionModified();
    } else if (question?.id === "matching" && question.data.type === "custom-points") {
      if (!featureRef.current?._layers) return;

      const layers = featureRef.current._layers;
      const geoJSONs = Object.values(layers).map((layer: any) => layer.toGeoJSON());
      const geoJSON = turf.featureCollection(geoJSONs);

      (question.data as CustomMatchingQuestion).geo = uniqBy(
        geoJSON.features as CustomTentacleQuestion["places"],
        (x) => x.geometry.coordinates.join(","),
      ); // Sometimes keys are duplicated
      if (featureRef.current) {
        Object.values(featureRef.current._layers).map((layer: any) => {
          if (!layer.options.isDialog) {
            featureRef.current.removeLayer(layer);
          }
        });
      }
      questionModified();
    } else if (question?.id === "measuring" && question.data.type === "custom-measure") {
      if (!featureRef.current?._layers) return;

      const layers = featureRef.current._layers;
      const geoJSONs = Object.values(layers).map((layer: any) => layer.toGeoJSON());
      const geoJSON = turf.featureCollection(geoJSONs);

      (question.data as CustomMeasuringQuestion).geo = turf.featureCollection(
        uniqBy(geoJSON.features as CustomTentacleQuestion["places"], (x) =>
          x.geometry.coordinates.join(","),
        ),
      ); // Sometimes keys are duplicated
      if (featureRef.current) {
        Object.values(featureRef.current._layers).map((layer: any) => {
          if (!layer.options.isSpecial && !layer.options.isDialog) {
            featureRef.current.removeLayer(layer);
          }
        });
      }
      questionModified();
    }
  };

  // react-leaflet-draw's EditControl adds edit and delete handlers whenever its
  // callbacks change and never removes them, so handlers of every earlier render
  // kept writing into the question drawn then. One stable callback calls the
  // current onChange.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const onDrawChange = useCallback(() => onChangeRef.current(), []);

  useEffect(() => {
    if (featureRef.current && $drawingQuestionKey === -1) {
      featureRef.current.clearLayers();
    }
  }, [$drawingQuestionKey]);

  // A custom question may not have anything drawn yet.
  const measuringGeo =
    (question?.data as CustomMeasuringQuestion | undefined)?.geo ?? turf.featureCollection([]);

  return (
    <FeatureGroup ref={featureRef}>
      {question &&
        question.id === "tentacles" &&
        question.data.locationType === "custom" &&
        question.data.places?.map((x) => <TentacleMarker key={markerKey(x.geometry)} point={x} />)}
      {question &&
        question.id === "matching" &&
        question.data.type === "custom-points" &&
        ((question.data as CustomMatchingQuestion).geo ?? []).map((x: any) => (
          <PointMarker key={markerKey(x.geometry)} point={x} />
        ))}
      {question &&
        question.id === "measuring" &&
        question.data.type === "custom-measure" &&
        turf
          .flatten(measuringGeo)
          .features.filter((x: any) => turf.getType(x) === "Point")
          .map((x: any) => <PointMarker key={markerKey(x.geometry)} point={x} />)}
      {question &&
        question.id === "measuring" &&
        question.data.type === "custom-measure" &&
        turf
          .flatten(measuringGeo)
          .features.filter((x: any) => turf.getType(x) === "Polygon")
          .map((x: any) => (
            <Polygon
              key={x.geometry.coordinates.join(",")}
              positions={swapCoordinates(x.geometry.coordinates)}
              // @ts-expect-error This is passed to options, so it is not typed
              isSpecial={true}
              stroke
              pathOptions={{ color: "red" }}
              fill={false}
            />
          ))}
      {question &&
        question.id === "measuring" &&
        question.data.type === "custom-measure" &&
        turf
          .flatten(measuringGeo)
          .features.filter((x: any) => turf.getType(x) === "LineString")
          .map((x: any) => (
            <Polyline
              key={x.geometry.coordinates.join(",")}
              positions={swapCoordinates(x.geometry.coordinates)}
              // @ts-expect-error This is passed to options, so it is not typed
              isSpecial={true}
              stroke
              pathOptions={{ color: "red" }}
              fill={false}
            />
          ))}
      {question &&
        question.id === "matching" &&
        question.data.type === "custom-zone" &&
        (question.data as CustomMatchingQuestion).geo &&
        ((question.data as CustomMatchingQuestion).geo.type === "FeatureCollection"
          ? turf.flatten((question.data as CustomMatchingQuestion).geo)
          : turf.flatten(turf.featureCollection([(question.data as CustomMatchingQuestion).geo]))
        ).features.map((x: any) => (
          <Polygon
            key={JSON.stringify(x)}
            positions={swapCoordinates(x.geometry.coordinates)}
            // @ts-expect-error This is passed to options, so it is not typed
            isSpecial={true}
            stroke
            pathOptions={{ color: "red" }}
            fill={false}
          />
        ))}
      {question && (
        <EditControl
          // Its toolbar is rebuilt only on a new mount now that the callback is stable.
          key={`${question.key}:${String((question.data as { type?: unknown }).type)}`}
          position="bottomleft"
          draw={{
            rectangle: false,
            circle: false,
            circlemarker: false,
            marker:
              question.id === "tentacles" ||
              (question.id === "matching" && question.data.type === "custom-points") ||
              question.id === "measuring"
                ? true
                : false,
            polyline: question.id === "measuring",
            polygon:
              question.id === "tentacles" ||
              (question.id === "matching" && question.data.type === "custom-points")
                ? false
                : {
                    shapeOptions: { fillOpacity: 0 },
                  },
          }}
          onCreated={onDrawChange}
          onEdited={onDrawChange}
          onDeleted={onDrawChange}
        />
      )}
    </FeatureGroup>
  );
};
