import type { Evaluator } from "@searchlight/shared";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    Position,
} from "geojson";

export type Region = Feature<Polygon | MultiPolygon>;

export interface GeometrySource {
    points: Feature<Point>[];
    regions: Region[];
    /**
     * The game marks the regions as not overlapping (the import page checks
     * that), so the boundary of the region a point is in is also the nearest
     * boundary of any region.
     */
    noOverlaps: boolean;
    lines: {
        source: Feature;
        /** Which of the layer's line features this part belongs to: 0, 1, 2... */
        featureOrdinal: number;
        line: Feature<LineString>;
    }[];
    fixed: Map<string, Promise<unknown>>;
    positions: Map<string, Promise<unknown>>;
    buffers: Map<string, Promise<unknown>>;
}

// Compiling a game/revision creates a fresh datasets object. Weak ownership also
// lets retired games and replaced datasets release their geometry without an
// explicit global invalidation hook. Session-supplied geometry uses its own
// immutable collection/array identity within the same scope.
const scopes = new WeakMap<object, WeakMap<object, GeometrySource>>();
const POSITION_CACHE_LIMIT = 32;
const BUFFER_CACHE_LIMIT = 4;

export function geometrySource(
    evaluator: Evaluator,
    datasets: Record<string, unknown>,
    data: {
        geo?: FeatureCollection;
        customRegions?: FeatureCollection;
        places?: unknown[];
    },
): GeometrySource | undefined {
    const datasetId =
        evaluator.source?.kind === "dataset"
            ? evaluator.source.datasetId
            : undefined;
    // Compiled datasets have already passed game-definition validation.
    const dataset = (datasetId ? datasets[datasetId] : undefined) as
        | { kind?: string; features?: FeatureCollection; noOverlaps?: boolean }
        | undefined;
    const input = datasetId
        ? dataset?.kind === "inline"
            ? dataset.features
            : undefined
        : (data.geo ?? data.customRegions ?? data.places);
    if (!input) return undefined;
    // The feature array changes when data is replaced even if its wrapper is reused.
    const identity = Array.isArray(input) ? input : input.features;
    if (!identity) return undefined;
    let scope = scopes.get(datasets);
    if (!scope) scopes.set(datasets, (scope = new WeakMap()));
    const cached = scope.get(identity);
    if (cached) return cached;

    const features: Feature[] = Array.isArray(input) ? [] : input.features;
    if (Array.isArray(input)) {
        for (const place of input) {
            if (!place || typeof place !== "object") continue;
            if (
                "type" in place &&
                place.type === "Feature" &&
                "geometry" in place
            ) {
                // Session features were parsed by the question schema.
                features.push(place as Feature);
            } else {
                const lng =
                    "lng" in place
                        ? place.lng
                        : "lon" in place
                          ? place.lon
                          : undefined;
                const lat = "lat" in place ? place.lat : undefined;
                if (typeof lng !== "number" || typeof lat !== "number")
                    continue;
                const id = "id" in place ? place.id : undefined;
                features.push(
                    turf.point(
                        [lng, lat],
                        {
                            name: "name" in place ? place.name : undefined,
                        },
                        {
                            id:
                                typeof id === "string" || typeof id === "number"
                                    ? id
                                    : undefined,
                        },
                    ),
                );
            }
        }
    }
    const source: GeometrySource = {
        points: [],
        regions: [],
        noOverlaps: dataset?.noOverlaps === true,
        lines: [],
        fixed: new Map(),
        positions: new Map(),
        buffers: new Map(),
    };
    let lineFeatures = 0;
    for (const feature of features) {
        switch (feature.geometry?.type) {
            case "Point":
                source.points.push(feature as Feature<Point>);
                break;
            case "Polygon":
            case "MultiPolygon":
                source.regions.push(feature as Region);
                break;
            case "LineString":
            case "MultiLineString": {
                const featureOrdinal = lineFeatures++;
                for (const line of turf.flatten(feature).features) {
                    source.lines.push({
                        source: feature,
                        featureOrdinal,
                        line: line as Feature<LineString>,
                    });
                }
                break;
            }
        }
    }
    scope.set(identity, source);
    return source;
}

export function cachedGeometry<T>(
    source: GeometrySource,
    key: string,
    build: () => T | Promise<T>,
    fixed = false,
): Promise<T> {
    return fixed
        ? remember(source.fixed, undefined, key, build)
        : remember(source.positions, POSITION_CACHE_LIMIT, key, build);
}

/**
 * Like a position-keyed cachedGeometry, for results that can run to
 * megabytes, such as distance buffers around a large layer: only the last
 * few are kept. Without an entry for `key`, an entry whose key `serves`
 * accepts is used instead.
 */
export function cachedBuffer<T>(
    source: GeometrySource,
    key: string,
    build: () => T | Promise<T>,
    serves?: (cachedKey: string) => boolean,
): Promise<T> {
    if (serves && !source.buffers.has(key)) {
        for (const cachedKey of source.buffers.keys()) {
            if (serves(cachedKey)) {
                key = cachedKey;
                break;
            }
        }
    }
    return remember(source.buffers, BUFFER_CACHE_LIMIT, key, build);
}

function remember<T>(
    cache: Map<string, Promise<unknown>>,
    limit: number | undefined,
    key: string,
    build: () => T | Promise<T>,
): Promise<T> {
    const previous = cache.get(key);
    if (previous) {
        if (limit !== undefined) {
            cache.delete(key);
            cache.set(key, previous);
        }
        return previous as Promise<T>;
    }
    // Install before invoking the builder so simultaneous planning/evaluation
    // requests share even asynchronous ArcGIS initialization and buffer work.
    const pending = Promise.resolve().then(build);
    cache.set(key, pending);
    if (limit !== undefined && cache.size > limit) {
        cache.delete(cache.keys().next().value!);
    }
    void pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
    });
    return pending;
}

export function regionLines(region: Region): FeatureCollection<LineString> {
    return turf.flatten(
        turf.polygonToLine(region),
    ) as FeatureCollection<LineString>;
}

/**
 * Every edge of the regions' boundaries once, as one MultiLineString: the
 * border two neighbours share is buffered once instead of twice.
 */
export function borderNetwork(regions: Region[]): Feature<MultiLineString> {
    const key = (a: Position, b: Position) => {
        const p = `${a[0]},${a[1]}`;
        const q = `${b[0]},${b[1]}`;
        return p < q ? `${p} ${q}` : `${q} ${p}`;
    };
    const seen = new Set<string>();
    const paths: Position[][] = [];
    for (const region of regions) {
        for (const line of regionLines(region).features) {
            const ring = line.geometry.coordinates;
            let path: Position[] = [];
            for (let i = 0; i + 1 < ring.length; i++) {
                const edge = key(ring[i], ring[i + 1]);
                if (seen.has(edge)) {
                    if (path.length > 1) paths.push(path);
                    path = [];
                    continue;
                }
                seen.add(edge);
                if (!path.length) path.push(ring[i]);
                path.push(ring[i + 1]);
            }
            if (path.length > 1) paths.push(path);
        }
    }
    return turf.multiLineString(paths);
}

export function containingRegion(
    regions: Region[],
    point: Feature<Point>,
): Region | undefined {
    return regions.find((region) => turf.booleanPointInPolygon(point, region));
}

export function nearestLine(
    lines: GeometrySource["lines"],
    point: Feature<Point>,
): Feature | undefined {
    let nearest: Feature | undefined;
    let distance = Infinity;
    for (const { source, line } of lines) {
        const candidate = turf.pointToLineDistance(point, line, {
            units: "kilometers",
        });
        if (candidate < distance) {
            nearest = source;
            distance = candidate;
        }
    }
    return nearest;
}
