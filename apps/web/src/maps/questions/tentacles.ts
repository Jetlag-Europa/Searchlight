import * as turf from "@turf/turf";
import type { BBox, FeatureCollection, Point } from "geojson";

import { hiderMode } from "@/lib/context";
import { customPOIPoints, resolveCategory } from "@/lib/poiOverride";
import { findTentacleLocations } from "@/maps/api";
import { arcBuffer, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoiSafe } from "@/maps/geo-utils";
import type { TentacleQuestion, Units } from "@/maps/schema";

// A bbox covering the tentacle's POIs and its radius circle, used to clip the
// planar-Voronoi fallback in geoSpatialVoronoiSafe (which kicks in only when the
// spherical Voronoi is degenerate for tightly-clustered POIs).
function tentacleVoronoiBbox(
    points: FeatureCollection<Point>,
    question: TentacleQuestion,
): BBox {
    const circle = turf.buffer(turf.point([question.lng, question.lat]), question.radius * 1.15, {
        units: question.unit,
    });
    const fc = turf.featureCollection([
        ...points.features,
        ...(circle ? [circle] : []),
    ] as never);
    const [a, b, c, d] = turf.bbox(fc);
    const px = (c - a) * 0.1 || 0.1;
    const py = (d - b) * 0.1 || 0.1;
    return [a - px, b - py, c + px, d + py];
}

// Promise cache for Overpass-backed tentacle lookups.
// getLocationsForTentacleQuestion is called up to 3-4× per refresh (per-question
// region + elimination + planning + hiderify), and refreshes fire on every atom
// change — without this, each call re-hits Overpass and the user sees a storm of
// "Determining tentacle locations…" toasts that never settle. Caching the
// *promise* (not just the result) also dedupes concurrent in-flight calls so one
// refresh fires at most one request per unique query. Results (including empty)
// are kept so we don't refetch; on error the entry is evicted to allow a retry.
// Cleared on game switch. Custom-POI results bypass this entirely (cheap, no
// network) and are checked first, so they override any stale cached fallback.
const _tentacleCache = new Map<string, Promise<FeatureCollection<Point>>>();

export function clearTentacleCache(): void {
    _tentacleCache.clear();
}

export async function getLocationsForTentacleQuestion(
    question: TentacleQuestion,
): Promise<FeatureCollection<Point>> {
    const categoryKey = resolveCategory(question.locationType);
    const overridePts = customPOIPoints(categoryKey);
    if (overridePts) {
        const center = turf.point([question.lng, question.lat]);
        const radiusMeters = turf.convertLength(question.radius, question.unit, "meters");
        const nearby = overridePts.filter(
            (pt) => turf.distance(center, pt, { units: "meters" }) <= radiusMeters,
        );
        console.info(`[taibled:poi] tentacle ${question.locationType} → ${nearby.length} custom within radius`);
        return turf.featureCollection(nearby) as FeatureCollection<Point>;
    }

    const key = JSON.stringify({
        t: question.locationType,
        lat: question.lat?.toFixed(5),
        lng: question.lng?.toFixed(5),
        r: question.radius,
        u: question.unit,
    });
    let pending = _tentacleCache.get(key);
    if (!pending) {
        pending = findTentacleLocations(
            question as Exclude<TentacleQuestion, { locationType: "custom" }>,
        ).catch((e) => {
            _tentacleCache.delete(key); // allow a later refresh to retry
            throw e;
        });
        _tentacleCache.set(key, pending);
    }
    return pending;
}

const filterPointsWithinRadius = (
    points: any,
    centerLng: number,
    centerLat: number,
    radius: number,
    unit: Units,
) => {
    if (
        centerLng === null ||
        centerLat === null ||
        radius === undefined ||
        radius === null
    ) {
        return points;
    }
    const center = turf.point([centerLng, centerLat]);

    return turf.featureCollection(
        points.features.filter((feature: any) => {
            const coords =
                feature?.geometry?.coordinates ??
                (feature?.properties?.lon && feature?.properties?.lat
                    ? [feature.properties.lon, feature.properties.lat]
                    : null);

            if (!coords) return false;

            const pt = turf.point(coords);
            const dist = turf.distance(center, pt, { units: unit });
            return dist <= radius;
        }),
    );
};

export const adjustPerTentacle = async (
    question: TentacleQuestion,
    mapData: any,
) => {
    if (mapData === null) return;
    if (question.location === false) {
        throw new Error("Must have a location");
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));

    const correctPolygon = voronoi.features.find((feature: any) => {
        if (!question.location) return false;
        return (
            feature.properties.site.properties.name ===
            question.location.properties.name
        );
    });
    if (!correctPolygon) {
        return mapData;
    }

    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    return turf.intersect(
        turf.featureCollection([safeUnion(mapData), correctPolygon, circle]),
    );
};

export const hiderifyTentacles = async (question: TentacleQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));

    const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
    const location = turf.point([question.lng, question.lat]);

    if (
        turf.distance(hider, location, { units: question.unit }) >
        question.radius
    ) {
        question.location = false;
        return question;
    }

    let correctLocation: any = null;

    // Use the cell's own `site` rather than indexing into points — the planar
    // fallback in geoSpatialVoronoiSafe may drop null cells, so cell order no
    // longer lines up with the input points. Both Voronoi paths set properties.site.
    const correctPolygon = voronoi.features.find((feature: any) => {
        const pointIn =
            turf.booleanPointInPolygon(hider, feature.geometry) || false;

        if (pointIn) {
            correctLocation = feature.properties.site;
        }
        return pointIn;
    });

    if (!correctPolygon) {
        return question;
    }

    question.location = correctLocation!;
    return question;
};

export const tentaclesPlanningPolygon = async (question: TentacleQuestion) => {
    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : await getLocationsForTentacleQuestion(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoiSafe(points, tentacleVoronoiBbox(points, question));
    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    const interiorVoronoi = voronoi.features
        .map((feature) =>
            turf.intersect(turf.featureCollection([feature, circle])),
        )
        .filter((feature) => feature !== null);

    return turf.combine(
        turf.featureCollection(
            interiorVoronoi
                .map((x: any) => turf.polygonToLine(x))
                .flatMap((line) =>
                    line.type === "FeatureCollection" ? line.features : [line],
                ),
        ),
    );
};
