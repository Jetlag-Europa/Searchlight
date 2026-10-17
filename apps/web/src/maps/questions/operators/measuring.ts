import type { Evaluator } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    BBox,
    FeatureCollection,
    Geometry,
    MultiPolygon,
    Polygon,
} from "geojson";

import {
    arcBuffer,
    arcBufferToPoint,
    arcDistanceToPoint,
    safeUnion,
} from "@/maps/geo-utils";
import { bufferDeviation } from "@/maps/geo-utils/bufferReach";
import { requestGeometry } from "@/maps/geo-utils/geometryClient";

import {
    cachedBuffer,
    cachedGeometry,
    containingRegion,
    type GeometrySource,
    geometrySource,
    type Region,
    regionLines,
} from "./geometry";

export interface MeasuringEvaluationParams {
    evaluator: Evaluator;
    datasets: Record<string, unknown>;
    data: {
        lat: number;
        lng: number;
        hiderCloser?: boolean;
        geo?: FeatureCollection;
    };
    mapGeoData: FeatureCollection<Polygon | MultiPolygon> | null | undefined;
    /**
     * Identifies the asking question, so a buffer for its newer position
     * supersedes one for an older position still waiting in the worker.
     */
    requestKey?: string;
}

type MeasuringGeometryParams = Omit<MeasuringEvaluationParams, "mapGeoData">;

// The buffer is built to be exact only inside the map's bbox, rounded out so
// the key, and the cached buffer, survive questions trimming the map.
const BOUNDS_STEP = 0.05;

function measuringBounds(
    mapGeoData: FeatureCollection<Polygon | MultiPolygon> | null | undefined,
): BBox | undefined {
    if (!mapGeoData?.features.length) return undefined;
    const [west, south, east, north] = turf.bbox(mapGeoData);
    const down = (value: number) =>
        Math.min(value, Math.floor(value / BOUNDS_STEP) * BOUNDS_STEP);
    const up = (value: number) =>
        Math.max(value, Math.ceil(value / BOUNDS_STEP) * BOUNDS_STEP);
    return [
        Math.max(-180, down(west)),
        Math.max(-90, down(south)),
        Math.min(180, up(east)),
        Math.min(90, up(north)),
    ];
}

/** No feature comes within the seeker's distance of the map. */
export function isEmptyBuffer(region: Region): boolean {
    return region.geometry.coordinates.length === 0;
}

/** The same target set drives distance answers, buffers, and planning lines. */
export async function determineMeasuringTargets({
    evaluator,
    datasets,
    data,
}: MeasuringGeometryParams) {
    const source = geometrySource(evaluator, datasets, data);
    if (!source) return undefined;
    switch (evaluator.operator) {
        case "nearest-feature-distance":
            return source.points.length
                ? cachedGeometry(
                      source,
                      "measuring:points",
                      () => turf.featureCollection(source.points),
                      true,
                  )
                : undefined;
        case "distance-to-lines":
            return source.lines.length
                ? cachedGeometry(
                      source,
                      "measuring:lines",
                      () =>
                          turf.featureCollection(
                              source.lines.map(({ line }) => line),
                          ),
                      true,
                  )
                : undefined;
        case "distance-to-containing-region-boundary": {
            const containing = containingRegion(
                source.regions,
                turf.point([data.lng, data.lat]),
            );
            if (!containing) return undefined;
            return cachedGeometry(
                source,
                `measuring:region:${source.regions.indexOf(containing)}`,
                () => regionLines(containing),
                true,
            );
        }
        default:
            return undefined;
    }
}
export interface MeasuredDistance {
    meters: number;
    /** The nearest target's name, when it has one. */
    name?: string;
    /** Measured to a region's boundary, so `name` is the region's. */
    boundary?: boolean;
}

/**
 * How far a point is from the nearest of a measuring question's targets, in
 * the geodetic metric the map's buffers are built from, so it matches the
 * line drawn on the map. The name is picked with Turf's spherical distance,
 * which can only disagree on a near tie.
 */
export async function measureToTargets(
    targets: FeatureCollection,
    lat: number,
    lng: number,
): Promise<MeasuredDistance | undefined> {
    if (!targets.features.length) return undefined;
    const meters = await arcDistanceToPoint(targets, lat, lng, "meters");
    if (!Number.isFinite(meters)) return undefined;
    const point = turf.point([lng, lat]);
    let name: unknown;
    let nearest = Infinity;
    const parts = turf.flatten(targets as FeatureCollection<Geometry>);
    for (const feature of parts.features) {
        const { geometry } = feature;
        let distance: number;
        if (geometry.type === "Point") {
            distance = turf.distance(point, geometry);
        } else if (geometry.type === "LineString") {
            distance = turf.pointToLineDistance(point, geometry);
        } else {
            continue;
        }
        if (distance < nearest) {
            nearest = distance;
            name = feature.properties?.name;
        }
    }
    return {
        meters,
        name: typeof name === "string" && name.trim() ? name : undefined,
    };
}

const MAX_CACHED_DISTANCES = 2;
const regionBufferCaches = new WeakMap<
    GeometrySource,
    Map<string, Map<number, Promise<Region>>>
>();

function getRegionBuffer(
    source: GeometrySource,
    index: number,
    region: Region,
    distance: number,
): Promise<Region> {
    let distMap = regionBufferCaches.get(source);
    if (!distMap) {
        distMap = new Map();
        regionBufferCaches.set(source, distMap);
    }
    const distKey = String(distance);
    let buffers = distMap.get(distKey);
    if (!buffers) {
        buffers = new Map();
        distMap.set(distKey, buffers);
        if (distMap.size > MAX_CACHED_DISTANCES) {
            distMap.delete(distMap.keys().next().value!);
        }
    } else {
        distMap.delete(distKey);
        distMap.set(distKey, buffers);
    }
    let pending = buffers.get(index);
    if (!pending) {
        pending = (async () => {
            const rLines = await cachedGeometry(
                source,
                `measuring:region:${index}`,
                () => regionLines(region),
                true,
            );
            return arcBuffer(
                rLines,
                distance,
                "miles",
                bufferDeviation(distance, "miles"),
            );
        })();
        buffers.set(index, pending);
        void pending.catch(() => {
            if (buffers?.get(index) === pending) {
                buffers.delete(index);
            }
        });
    }
    return pending;
}

async function getContainingRegionTargetGeometry(
    source: GeometrySource,
    data: { lat: number; lng: number },
    mapGeoData?: FeatureCollection<Polygon | MultiPolygon> | null,
): Promise<Region | null> {
    const mapBbox = mapGeoData?.features.length
        ? turf.bbox(mapGeoData)
        : undefined;
    // The target is independent of the current map's shape once the relevant
    // region IDs are known. A rounded bbox alone is not a safe cache key.
    const candidates: { region: Region; index: number }[] = [];
    for (let index = 0; index < source.regions.length; index++) {
        const region = source.regions[index];
        if (mapBbox) {
            const bounds = turf.bbox(region);
            if (
                bounds[0] > mapBbox[2] ||
                bounds[2] < mapBbox[0] ||
                bounds[1] > mapBbox[3] ||
                bounds[3] < mapBbox[1]
            )
                continue;
            if (
                !mapGeoData!.features.some((feature) =>
                    turf.booleanIntersects(region, feature),
                )
            )
                continue;
        }
        candidates.push({ region, index });
    }
    const key = `measuring:containing-target:${data.lat}:${data.lng}:${candidates.map(({ index }) => index).join(",")}`;
    return cachedBuffer(source, key, async () => {
        if (!candidates.length) return null;
        const seekerPoint = turf.point([data.lng, data.lat]);
        const containing = containingRegion(source.regions, seekerPoint);
        // A seeker outside every region has infinite distance to their own
        // boundary. Only candidates inside a region can be closer.
        if (!containing) {
            return safeUnion(
                turf.featureCollection(candidates.map(({ region }) => region)),
            );
        }
        const seekerIndex = source.regions.indexOf(containing);
        const seekerLines = await cachedGeometry(
            source,
            `measuring:region:${seekerIndex}`,
            () => regionLines(containing),
            true,
        );
        // Use the same ArcGIS geodetic metric that constructs the boundary
        // buffers; Turf's spherical distance can differ by over 100 m here.
        const threshold = await arcDistanceToPoint(
            seekerLines,
            data.lat,
            data.lng,
            "miles",
        );
        if (!Number.isFinite(threshold) || threshold <= 0) return null;

        const parts: Region[] = [];
        for (const { region, index } of candidates) {
            const buffer = await getRegionBuffer(
                source,
                index,
                region,
                threshold,
            );
            let part = turf.intersect(turf.featureCollection([region, buffer]));
            if (!part) continue;
            // When regions overlap, the first containing source wins for both
            // hider answers and map geometry.
            for (let previous = 0; previous < index; previous++) {
                const earlier = source.regions[previous];
                if (!turf.booleanIntersects(part, earlier)) continue;
                part = turf.difference(turf.featureCollection([part, earlier]));
                if (!part) break;
            }
            if (part) parts.push(part);
        }
        return parts.length ? safeUnion(turf.featureCollection(parts)) : null;
    });
}

export async function determineMeasuringGeometry(
    params: MeasuringGeometryParams & {
        mapGeoData?: FeatureCollection<Polygon | MultiPolygon> | null;
    },
) {
    const source = geometrySource(
        params.evaluator,
        params.datasets,
        params.data,
    );
    if (!source) return undefined;
    const { evaluator, data } = params;
    if (evaluator.operator === "distance-to-containing-region-boundary") {
        const target = await getContainingRegionTargetGeometry(
            source,
            data,
            params.mapGeoData,
        );
        return target ?? undefined;
    }
    const within = measuringBounds(params.mapGeoData);
    const prefix = `measuring:buffer:${evaluator.operator}:${data.lat}:${data.lng}:`;
    return cachedBuffer(
        source,
        prefix + (within?.join(",") ?? "everywhere"),
        async () => {
            const targets = await determineMeasuringTargets(params);
            if (!targets?.features.length) return undefined;
            // The worker measures the seeker's distance to every target, so
            // it stays exact, then buffers only the targets that can reach
            // the map.
            return arcBufferToPoint(targets, data.lat, data.lng, {
                within,
                supersede: params.requestKey,
            });
        },
        // A buffer exact over a larger box serves a narrower map too.
        (cachedKey) => {
            if (!cachedKey.startsWith(prefix)) return false;
            const bounds = cachedKey.slice(prefix.length);
            if (bounds === "everywhere") return true;
            if (!within) return false;
            const [west, south, east, north] = bounds.split(",").map(Number);
            return (
                west <= within[0] &&
                south <= within[1] &&
                east >= within[2] &&
                north >= within[3]
            );
        },
    );
}

export async function evaluateMeasuringOperator(
    params: MeasuringEvaluationParams,
) {
    if (!params.mapGeoData) return params.mapGeoData;
    const { evaluator, data, mapGeoData } = params;
    if (evaluator.operator === "distance-to-containing-region-boundary") {
        const source = geometrySource(evaluator, params.datasets, data);
        if (!source) return mapGeoData;
        const closer = data.hiderCloser !== false;
        const targetGeometry = await getContainingRegionTargetGeometry(
            source,
            data,
            mapGeoData,
        );
        if (!targetGeometry) {
            return closer ? turf.featureCollection([]) : mapGeoData;
        }
        return requestGeometry({
            kind: "clip",
            mapData: mapGeoData,
            modifications: targetGeometry,
            within: closer,
        });
    }
    const buffer = await determineMeasuringGeometry(params);
    if (!buffer) return mapGeoData;
    const closer = data.hiderCloser !== false;
    if (isEmptyBuffer(buffer)) {
        return closer ? turf.featureCollection([]) : mapGeoData;
    }
    return requestGeometry({
        kind: "clip",
        mapData: mapGeoData,
        modifications: buffer,
        within: closer,
    });
}
