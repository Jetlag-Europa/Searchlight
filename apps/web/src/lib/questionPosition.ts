import * as turf from "@turf/turf";

export interface LatLng {
    lat: number;
    lng: number;
}

// Where a question added from the Add Question dialog starts: at the seeker
// while Follow Me has a fix, otherwise at the map centre. The fix has no age
// limit: the watch only reports again once the seeker moves, so a seeker
// standing still keeps their last fix (it is dropped when the watch fails).
export const newQuestionPosition = (
    center: LatLng,
    followMe: boolean,
    fix: LatLng | null,
): LatLng =>
    followMe && fix
        ? { lat: fix.lat, lng: fix.lng }
        : { lat: center.lat, lng: center.lng };

// What Follow Me does on a geolocation error: only a refusal ends it. A slow
// or missing fix (indoors, on a train) times out now and then, and the watch
// keeps trying.
export const geoErrorAction = (code: number): "stop" | "keep" =>
    code === 1 /* GeolocationPositionError.PERMISSION_DENIED */
        ? "stop"
        : "keep";

// A new thermometer starts (A) at the given point and ends (B) 5 km east of it.
export const newThermometerData = (start: LatLng) => {
    const destination = turf.destination([start.lng, start.lat], 5, 90, {
        units: "kilometers",
    });
    return {
        latA: start.lat,
        lngA: start.lng,
        latB: destination.geometry.coordinates[1],
        lngB: destination.geometry.coordinates[0],
    };
};
