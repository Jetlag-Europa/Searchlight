import type { Feature, Point, Polygon } from "geojson";
import type { LatLngTuple } from "leaflet";

import type { Question, Units } from "@/maps/schema";

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
    isHidingZone?: boolean;
    questions?: Question[];
}

export interface AdditionalMapGeoLocations {
    added: boolean;
    location: OpenStreetMap;
    base: boolean;
}

export enum CacheType {
    CACHE = "jlhs-map-generator-cache",
    ZONE_CACHE = "jlhs-map-generator-zone-cache",
    PERMANENT_CACHE = "jlhs-map-generator-permanent-cache",
}

export interface CustomStation {
    id: string;
    name?: string;
    lat: number;
    lng: number;
    tier?: string;
    radius?: number;
    unit?: Units;
}

export interface StationPlaceProperties {
    id: string;
    name?: string;
    tier?: string;
    radius?: number;
    unit?: Units;
    [key: string]: unknown;
}

export type StationPlace = Feature<Point, StationPlaceProperties>;
export type StationCircle = Feature<Polygon, StationPlace>;
