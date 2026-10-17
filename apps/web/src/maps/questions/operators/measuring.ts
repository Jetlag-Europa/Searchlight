import type { Evaluator } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type { BBox, FeatureCollection, MultiPolygon, Polygon } from "geojson";

import {
    arcBuffer,
    arcBufferToPoint,
    arcDistanceToPoint,
} from "@/maps/geo-utils";
import {
    bufferDeviation,
    featuresReaching,
} from "@/maps/geo-utils/bufferReach";
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
        case "distance-to-containing-region-boundary":
            return boundaryLinesAt(source, data.lat, data.lng);
        default:
            return undefined;
    }
}

/** A region's own boundary, shared by answers and buffers. */
function boundaryLines(source: GeometrySource, index: number) {
    return cachedGeometry(
        source,
        `measuring:region:${index}`,
        () => regionLines(source.regions[index]),
        true,
    );
}

/**
 * The boundary a point is measured to: its own region's. The regions may fall
 * short of the play area, as along a border or coast drawn from other data;
 * a point in none of them is measured to the nearest region's boundary, as
 * though it belonged to that region.
 */
function boundaryLinesAt(source: GeometrySource, lat: number, lng: number) {
    if (!source.regions.length) return undefined;
    const containing = containingRegion(source.regions, turf.point([lng, lat]));
    if (containing) {
        return boundaryLines(source, source.regions.indexOf(containing));
    }
    return cachedGeometry(
        source,
        "measuring:region:all",
        () =>
            turf.featureCollection(
                source.regions.flatMap(
                    (region) => regionLines(region).features,
                ),
            ),
        true,
    );
}

const MAX_CACHED_DISTANCES = 2;
const regionBufferCaches = new WeakMap<
    GeometrySource,
    Map<string, Map<number, Promise<Region>>>
>();

function getRegionBuffer(
    source: GeometrySource,
    index: number,
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
        pending = (async () =>
            arcBuffer(
                await boundaryLines(source, index),
                distance,
                "miles",
                bufferDeviation(distance, "miles"),
            ))();
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
    const seekerLines = await boundaryLinesAt(source, data.lat, data.lng);
    if (!seekerLines) return null;
    // Use the same ArcGIS geodetic metric that constructs the boundary
    // buffers; Turf's spherical distance can differ by over 100 m here.
    const threshold = await cachedGeometry(
        source,
        `measuring:region-distance:${data.lat}:${data.lng}`,
        () => arcDistanceToPoint(seekerLines, data.lat, data.lng, "miles"),
    );
    if (!Number.isFinite(threshold) || threshold <= 0) return null;
    // Only regions within the seeker's distance of the map can shape it. The
    // target is independent of the current map's shape once they are known;
    // a rounded bbox alone is not a safe cache key.
    const candidates = mapGeoData?.features.length
        ? featuresReaching(
              source.regions,
              turf.bbox(mapGeoData),
              turf.convertLength(threshold, "miles", "kilometers"),
          )
        : source.regions.map((_, index) => index);
    const key = `measuring:containing-target:${data.lat}:${data.lng}:${candidates.join(",")}`;
    return cachedBuffer(source, key, async () => {
        if (!candidates.length) return null;
        // A point in a region is closer within that region's buffer, and a
        // point in none within any region's buffer, as it is measured to the
        // nearest region. So the target is every buffer but the part of each
        // region beyond its own buffer. Those parts never reach a region's
        // edge, which leaves no seams for slivers between neighbouring regions.
        const buffers: Region[] = [];
        const farParts: Region[] = [];
        for (const index of candidates) {
            const region = source.regions[index];
            const buffer = await getRegionBuffer(source, index, threshold);
            buffers.push(buffer);
            let far = turf.difference(turf.featureCollection([region, buffer]));
            if (!far) continue;
            // When regions overlap, the first containing source wins for both
            // hider answers and map geometry.
            for (let previous = 0; previous < index; previous++) {
                const earlier = source.regions[previous];
                if (!turf.booleanIntersects(far, earlier)) continue;
                far = turf.difference(turf.featureCollection([far, earlier]));
                if (!far) break;
            }
            if (far) farParts.push(far);
        }
        // Combining whole buffers can take seconds on a large layer, so the
        // worker does it.
        return requestGeometry({
            kind: "clip",
            mapData: turf.featureCollection(buffers),
            modifications: turf.featureCollection(farParts),
            within: false,
        });
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
