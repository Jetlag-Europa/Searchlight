import type { Feature, MultiPolygon, Point, Polygon } from "geojson";
import type { LatLngTuple } from "leaflet";

export interface OpenStreetMap {
    type: string;
    geometry: OpenStreetMapGeometry;
    properties: OpenStreetMapProperties;
}

export interface OpenStreetMapGeometry {
    type: string;
    coordinates: LatLngTuple;
}

export interface OpenStreetMapProperties {
    osm_type: "W" | "R" | "N";
    osm_id: number;
    extent?: number[];
    country?: string;
    state?: string;
    osm_key: string;
    countrycode: string;
    osm_value: string;
    name: string;
    type: string;
}

export interface StationPlaceProperties {
    id: string;
    name?: string;
    tier?: string;
    [key: string]: unknown;
}

/** A hiding zone's station, or the point marking a polygon zone. */
export type StationPlace = Feature<Point, StationPlaceProperties>;
/** A hiding zone's area: a circle around its station, or a polygon zone. */
export type StationCircle = Feature<Polygon | MultiPolygon, StationPlace>;
