import _ from "lodash";

import { GEOCODER_API } from "./constants";
import { convertToLatLong } from "./geo";
import type { OpenStreetMap } from "./types";

export const geocodeUrl = (address: string, language: string) =>
    `${GEOCODER_API}?${new URLSearchParams({ lang: language, q: address })}`;

export const geocode = async (
    address: string,
    language: string,
    filter: boolean = true,
    signal?: AbortSignal,
) => {
    const features = (
        await (await fetch(geocodeUrl(address, language), { signal })).json()
    ).features as OpenStreetMap[];

    features.forEach((feature) => {
        feature.geometry.coordinates = convertToLatLong(
            feature.geometry.coordinates as number[],
        );
        if (!feature.properties.extent) return;
        feature.properties.extent = [
            feature.properties.extent[1],
            feature.properties.extent[0],
            feature.properties.extent[3],
            feature.properties.extent[2],
        ];
    });

    return _.uniqBy(
        features.filter((feature) => {
            return filter ? feature.properties.osm_type === "R" : true;
        }),
        (feature) => feature.properties.osm_id,
    );
};
