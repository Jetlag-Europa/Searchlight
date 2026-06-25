import type { APILocations } from "@/maps/schema";

// Overpass queries no longer hit public servers from the browser — they go through
// the backend /overpass proxy (which reaches LocalOverpass, possibly behind
// Cloudflare Access). This string is only a stable namespace for the browser Cache
// API key, never a request target. It must be an http(s) URL — the Cache API
// rejects other schemes as keys.
export const OVERPASS_CACHE_NS = "https://overpass-api.de/api/interpreter";
export const GEOCODER_API = "https://photon.komoot.io/api/";
export const PASTEBIN_API_POST_URL =
    "https://cors-anywhere.com/https://pastebin.com/api/api_post.php";
export const PASTEBIN_API_RAW_URL = "https://pastebin.com/raw/";
export const PASTEBIN_API_RAW_URL_PROXIED =
    "https://cors-anywhere.com/https://pastebin.com/raw/";

export const ICON_COLORS = {
    black: "#3D3D3D",
    blue: "#2A81CB",
    gold: "#FFD326",
    green: "#2AAD27",
    grey: "#7B7B7B",
    orange: "#CB8427",
    red: "#CB2B3E",
    violet: "#9C2BCB",
};

export const LOCATION_FIRST_TAG: {
    [key in "aquarium" | "hospital" | "peak" | "museum" | "theme_park" | "zoo"
           | "cinema" | "library" | "golf_course" | "consulate" | "park"]:
        | "amenity"
        | "tourism"
        | "leisure"
        | "diplomatic"
        | "natural";
} = {
    aquarium: "tourism",
    hospital: "amenity",
    peak: "natural",
    museum: "tourism",
    theme_park: "tourism",
    zoo: "tourism",
    cinema: "amenity",
    library: "amenity",
    golf_course: "leisure",
    consulate: "diplomatic",
    park: "leisure",
};

export const BLANK_GEOJSON = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [-180, -90],
                        [180, -90],
                        [180, 90],
                        [-180, 90],
                        [-180, -90],
                    ],
                ],
            },
        },
    ],
};
