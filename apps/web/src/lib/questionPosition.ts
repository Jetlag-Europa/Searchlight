import * as turf from "@turf/turf";

export interface LatLng {
    lat: number;
    lng: number;
}

export interface GpsFix extends LatLng {
    // When the fix was taken, in ms since the epoch (GeolocationPosition.timestamp).
    timestamp: number;
}

// Older fixes than this are too far behind a moving seeker to place a question.
export const GPS_FIX_MAX_AGE_MS = 2 * 60 * 1000;

// Where a question added from the Add Question dialog starts: at the seeker
// while Follow Me has a recent fix, otherwise at the map centre.
export const newQuestionPosition = (
    center: LatLng,
    followMe: boolean,
    fix: GpsFix | null,
    now: number = Date.now(),
): LatLng => {
    if (followMe && fix && now - fix.timestamp <= GPS_FIX_MAX_AGE_MS) {
        return { lat: fix.lat, lng: fix.lng };
    }
    return { lat: center.lat, lng: center.lng };
};

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
