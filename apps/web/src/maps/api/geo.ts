import type { LatLngTuple } from "leaflet";

import type { OpenStreetMap } from "./types";

export const convertToLatLong = (coordinates: number[]): LatLngTuple => {
    return [coordinates[1], coordinates[0]];
};

export const determineName = (feature: OpenStreetMap) => {
    const props = feature.properties;
    if (props.osm_type === "R") {
        const parts = [props.name, props.state, props.country].filter(Boolean);
        return parts.join(", ");
    } else {
        const parts = [
            (props as any).housenumber
                ? `${(props as any).housenumber} ${(props as any).street}`
                : (props as any).street,
            (props as any).city,
            (props as any).county,
            props.state,
            props.country,
        ].filter(Boolean);
        return parts.join(", ");
    }
};
