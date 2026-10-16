export const lngLatToText = (coordinates: [number, number]) => {
    /**
     * @param coordinates - Should be in longitude, latitude order
     */
    return `${Math.abs(coordinates[1])}°${coordinates[1] > 0 ? "N" : "S"}, ${Math.abs(coordinates[0])}°${coordinates[0] > 0 ? "E" : "W"}`;
};

export const extractStationName = (stationPlace: any) =>
    stationPlace.properties["name:en"] || stationPlace.properties.name;

export const extractStationLabel = (stationPlace: any) =>
    extractStationName(stationPlace) ||
    lngLatToText(stationPlace.geometry.coordinates);
