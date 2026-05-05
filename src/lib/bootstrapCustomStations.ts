import {
    customStations,
    defaultUnit,
    hidingRadius,
    hidingRadiusUnits,
    includeDefaultStations,
    mapGeoLocation,
    polyGeoJSON,
    useCustomStations,
} from "@/lib/context";
import type { CustomStation, OpenStreetMap } from "@/maps/api";
import { parseCustomStationsFromText } from "@/maps/api/importers";

// Bundled hiding-zone source — see public/luxembourg-hiding-zones.kml.
// Astro's BASE_URL lacks a trailing slash, hence the explicit normalize.
const NORMALIZED_BASE = (import.meta.env.BASE_URL ?? "/").replace(
    /\/?$/,
    "/",
);
export const BUNDLED_KML_URL = `${NORMALIZED_BASE}luxembourg-hiding-zones.kml`;

// Sentinel value used in `displayHidingZonesOptions` to represent the
// bundled Luxembourg KML. Filtered out before any Overpass call.
export const BUNDLED_LUX_OPTION_VALUE = "__bundled-luxembourg-2026__";
export const BUNDLED_LUX_OPTION_LABEL = "Luxembourg 2026 stations";

const DEFAULT_RADIUS_KM = 1;
const DEFAULT_RADIUS_UNITS = "kilometers";

// Photon result #0 for "luxembourg" — Luxembourg country (relation 2171347).
const LUXEMBOURG_COUNTRY: OpenStreetMap = {
    type: "Feature",
    geometry: {
        type: "Point",
        coordinates: [49.8158683, 6.1296751],
    },
    properties: {
        osm_type: "R",
        osm_id: 2171347,
        extent: [50.1827989, 5.7356988, 49.4478587, 6.5312481],
        country: "Luxembourg",
        osm_key: "place",
        countrycode: "LU",
        osm_value: "country",
        name: "Luxembourg",
        type: "country",
    },
};

let hasRun = false;

export function bootstrapDefaults(): void {
    if (hasRun) return;
    hasRun = true;

    // OptionDrawers' useEffect copies defaultUnit → hidingRadiusUnits on
    // mount, which would otherwise clobber our hiding-radius units. Set both.
    defaultUnit.set(DEFAULT_RADIUS_UNITS);
    hidingRadius.set(DEFAULT_RADIUS_KM);
    hidingRadiusUnits.set(DEFAULT_RADIUS_UNITS);

    mapGeoLocation.set(LUXEMBOURG_COUNTRY);
    if (polyGeoJSON.get() !== null) {
        polyGeoJSON.set(null);
    }
}

let cached: CustomStation[] | null = null;

export async function loadBundledStations(): Promise<CustomStation[]> {
    if (cached) return cached;
    const res = await fetch(BUNDLED_KML_URL);
    if (!res.ok) {
        throw new Error(`KML fetch failed: ${res.status}`);
    }
    const text = await res.text();
    const stations = parseCustomStationsFromText(text, "kml");
    cached = stations;
    return stations;
}

// On-demand activator: pull the bundled KML, push it into customStations,
// and switch the app into custom-stations mode. Mode atoms are flipped
// SYNCHRONOUSLY so any concurrent reader (e.g. an in-flight
// `initializeHidingZones` call) sees consistent state. Stations populate
// when the fetch resolves; the cache makes subsequent activations instant.
export function activateBundledStations(): void {
    useCustomStations.set(true);
    includeDefaultStations.set(false);
    if (cached) {
        customStations.set(cached);
        return;
    }
    loadBundledStations()
        .then((stations) => {
            if (stations.length === 0) {
                console.warn("[bundled-stations] 0 stations parsed from KML");
                return;
            }
            customStations.set(stations);
        })
        .catch((e) => {
            console.warn("[bundled-stations] activation failed:", e);
        });
}
